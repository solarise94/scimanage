/**
 * Canonical actor-aware bank-flow OCR receipts command (T7.5).
 *
 * Calls GLM-OCR on BANK_FLOW image/PDF staging files, synthesizes rows, and
 * creates/resumes a BANK_FLOW workspace (phase=MAPPED). Prefill only — no match/confirm.
 * Shared by Agent `finance.ocr_bank_flow_receipts`.
 */
import type { BusinessActor } from "@/lib/application/actor";
import {
  ConflictError,
  ForbiddenError,
  ValidationError,
} from "@/lib/application/errors";
import {
  WORKSPACE_KIND,
  createTaskWorkspace,
  getOwnedWorkspace,
  listActiveWorkspacesByKind,
  updateWorkspaceManifestCAS,
} from "@/lib/agent-task-workspace";
import {
  IMPORT_KIND,
  IMPORT_PARSER_KEY,
  StagingError,
  attachImportStagingSessionWhileAnalyzing,
  bindImportStagingBatchToSession,
  claimImportStagingBatchForAnalysis,
  completeImportStagingBatchAnalysis,
  failImportStagingAnalysis,
  getOwnedImportStaging,
  heartbeatImportStagingBatchLease,
  isBankFlowImageMime,
  newImportStagingLeaseOwner,
  acquireImportStagingAnalyzingLeaseIfStale,
  readImportStagingBuffer,
  recoverStaleImportStaging,
} from "@/lib/import-staging";
import {
  STAGING_ANALYZING_LEASE_MS,
  isLeaseStale,
} from "@/lib/staging-common";
import { canReadFinance } from "@/lib/finance/permissions";
import { yuanToCents } from "@/lib/finance/money";
import { isGlmOcrConfigured, ocrVoucherImage } from "@/lib/finance/glm-ocr";
import { GlmOcrClientError } from "@/lib/finance/glm-ocr-client";
import {
  parseBankFlowManifest,
  previewBankFlowRows,
  type BankFlowManifest,
} from "@/lib/finance/application/bank-flow-workspace-types";

export type OcrBankFlowReceiptsInput = {
  stagingFileIds: string[];
};

export type OcrBankFlowReceiptsResult = {
  workspaceId: string;
  rowCount: number;
  columns: string[];
  mapping: BankFlowManifest["mapping"];
  preview: ReturnType<typeof previewBankFlowRows>;
  encoding: BankFlowManifest["encoding"];
  warnings: string[];
  version: number;
  expectedVersion: number;
  source: "ocr";
  stats: Record<string, unknown>;
};

function assertOcrCapability(actor: BusinessActor): void {
  if (!canReadFinance(actor.role)) {
    throw new ForbiddenError();
  }
}

function mapStagingError(err: StagingError): never {
  if (err.httpStatus === 404) {
    throw new ValidationError(err.message);
  }
  if (err.httpStatus === 410) {
    throw new ConflictError(err.message);
  }
  if (err.httpStatus === 400) {
    throw new ValidationError(err.message);
  }
  throw new ConflictError(err.message);
}

function mapGlmOcrError(err: GlmOcrClientError): never {
  if (err.httpStatus === 403) throw new ForbiddenError(err.message);
  if (err.httpStatus === 409 || err.httpStatus === 410 || err.httpStatus === 503) {
    throw new ConflictError(err.message);
  }
  if (err.httpStatus >= 400 && err.httpStatus < 500) {
    throw new ValidationError(err.message);
  }
  throw err;
}

function parseManifest(raw: string | null | undefined): BankFlowManifest {
  try {
    return parseBankFlowManifest(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : "workspace manifest 解析失败";
    throw new ValidationError(message);
  }
}

/** manifest 批次与规范化输入（已排序去重）必须集合完全一致才可复用。 */
export function bankFlowStagingIdsMatch(
  manifestIds: string[] | undefined,
  fallbackPrimaryId: string | undefined,
  inputIds: string[],
): boolean {
  const raw =
    manifestIds && manifestIds.length > 0
      ? manifestIds
      : fallbackPrimaryId
        ? [fallbackPrimaryId]
        : [];
  if (raw.length !== inputIds.length) return false;
  const left = [...raw].map(String).sort();
  return left.every((id, i) => id === inputIds[i]);
}

/** OCR 恢复：跳过 manifest 中已完成的 stagingFileId，仅对剩余文件发起外部 OCR。 */
export function stagingIdsNeedingOcr(
  stagingFileIds: string[],
  completed: Array<{ stagingFileId: string }> | undefined,
): string[] {
  const done = new Set((completed ?? []).map((c) => c.stagingFileId));
  return stagingFileIds.filter((id) => !done.has(id));
}


export async function ocrBankFlowReceiptsForActor(
  actor: BusinessActor,
  input: OcrBankFlowReceiptsInput,
): Promise<OcrBankFlowReceiptsResult> {
  assertOcrCapability(actor);

if (!isGlmOcrConfigured()) {
        throw new ConflictError("GLM-OCR 未配置，无法识别回单图片");
      }

      await recoverStaleImportStaging();

      const stagings: Awaited<ReturnType<typeof getOwnedImportStaging>>[] = [];
      for (const stagingFileId of input.stagingFileIds) {
        let staging: Awaited<ReturnType<typeof getOwnedImportStaging>>;
        try {
          staging = await getOwnedImportStaging({
            stagingFileId,
            userId: actor.userId,
          });
        } catch (err) {
          if (err instanceof StagingError) mapStagingError(err);
          throw err;
        }
        if (staging.importKind !== IMPORT_KIND.BANK_FLOW) {
          throw new ValidationError(`${stagingFileId} 不是 BANK_FLOW staging`);
        }
        if (!isBankFlowImageMime(staging.mimeType)) {
          throw new ValidationError(
            `${staging.originalName || stagingFileId} 不是支持的回单图片/PDF`,
          );
        }
        if (staging.status === "FAILED" || staging.status === "EXPIRED") {
          throw new ConflictError(
            `${staging.originalName || stagingFileId} 已失败或过期，请重新上传`,
          );
        }
        if (staging.status === "ANALYZING") {
          if (isLeaseStale(staging.leaseStartedAt, STAGING_ANALYZING_LEASE_MS)) {
            await recoverStaleImportStaging();
            staging = await getOwnedImportStaging({
              stagingFileId,
              userId: actor.userId,
            });
          } else {
            // fresh lease：禁止抢占。等租约过期后由 recover 回 UPLOADED，再走 OCR_PENDING 逐文件恢复。
            throw new ConflictError("STAGING_IN_PROGRESS：其他请求正在 OCR");
          }
        }
        stagings.push(staging);
      }

      const inputIds = input.stagingFileIds;
      const buildOcrReuseResult = (
        existing: { id: string; version: number; manifestJson: string | null },
        manifest: BankFlowManifest,
        stats: Record<string, unknown>,
      ) => ({
        workspaceId: existing.id,
        rowCount: manifest.rowCount,
        columns: ["payerName", "amount", "date", "remark"],
        mapping: manifest.mapping,
        preview: previewBankFlowRows(manifest.rows),
        encoding: manifest.encoding,
        warnings: [] as string[],
        version: existing.version,
        expectedVersion: existing.version,
        source: "ocr" as const,
        stats: { ...stats, ocrFiles: inputIds.length },
      });

      // 复用已完成 OCR 的 workspace；OCR_PENDING 则继续外部识别（不重复创建 workspace）
      type StagingRow = (typeof stagings)[number];
      let resumeWorkspace: {
        id: string;
        version: number;
        manifestJson: string | null;
      } | null = null;

      const tryReuseCompleted = async (
        workspaceId: string,
      ): Promise<ReturnType<typeof buildOcrReuseResult> | "ocr_pending" | null> => {
        const existing = await getOwnedWorkspace({
          workspaceId,
          userId: actor.userId,
        });
        if (!existing || existing.kind !== WORKSPACE_KIND.BANK_FLOW) return null;
        const manifest = parseManifest(existing.manifestJson);
        if (
          !bankFlowStagingIdsMatch(manifest.stagingFileIds, manifest.stagingFileId, inputIds)
        ) {
          return null;
        }
        if (manifest.phase === "OCR_PENDING") {
          resumeWorkspace = existing;
          return "ocr_pending";
        }
        if (manifest.source !== "ocr") return null;
        const needsBind = stagings.filter(
          (s) => s.status !== "ANALYZED" || s.sessionId !== workspaceId,
        );
        if (needsBind.length > 0) {
          try {
            await bindImportStagingBatchToSession({
              userId: actor.userId,
              sessionId: workspaceId,
              parserKey: IMPORT_PARSER_KEY.BANK_FLOW,
              items: needsBind.map((s) => ({
                stagingFileId: s.id,
                expectedSha256: s.sha256,
              })),
            });
          } catch (err) {
            if (err instanceof StagingError) mapStagingError(err);
            throw err;
          }
        }
        return buildOcrReuseResult(existing, manifest, {
          reused: true,
          recovered: needsBind.length > 0,
        });
      };

      const sessionCandidates = [
        ...new Set(
          stagings
            .map((s) => s.sessionId)
            .filter((id): id is string => typeof id === "string" && id.length > 0),
        ),
      ];
      for (const workspaceId of sessionCandidates) {
        const outcome = await tryReuseCompleted(workspaceId);
        if (outcome === "ocr_pending") break;
        if (outcome) return outcome;
      }

      // sessionId 尚未写上时：扫描近期 OCR_PENDING workspace（覆盖 create→attach 之间的崩溃）
      if (!resumeWorkspace) {
        const recent = await listActiveWorkspacesByKind({
          ownerUserId: actor.userId,
          kind: WORKSPACE_KIND.BANK_FLOW,
          limit: 30,
        });
        for (const ws of recent) {
          let manifest: BankFlowManifest;
          try {
            manifest = parseManifest(ws.manifestJson);
          } catch {
            continue;
          }
          if (manifest.phase !== "OCR_PENDING" || manifest.source !== "ocr") continue;
          if (
            !bankFlowStagingIdsMatch(manifest.stagingFileIds, manifest.stagingFileId, inputIds)
          ) {
            continue;
          }
          resumeWorkspace = ws;
          break;
        }
      }

      // 已有 ANALYZED 但无法匹配到同批次已完成 workspace：拒绝
      if (!resumeWorkspace) {
        const analyzed = stagings.filter((s) => s.status === "ANALYZED");
        if (analyzed.length > 0) {
          throw new ConflictError(
            analyzed.length === stagings.length
              ? "本批回单已分析但 workspace 批次不一致或不可用，请重新上传"
              : "本批回单状态不一致（部分已分析且无法从 workspace 恢复），请重新上传同一批文件",
          );
        }
      }

      const leaseOwner = newImportStagingLeaseOwner();

      // 确保本批处于 ANALYZING（或从 UPLOADED 重新 claim）
      let working: StagingRow[] = stagings;
      const needClaim = working.filter((s) => s.status === "UPLOADED");
      if (needClaim.length > 0) {
        if (needClaim.length !== working.length && !resumeWorkspace) {
          throw new ConflictError(
            `staging 状态无法 OCR：${working.map((s) => s.status).join(",")}`,
          );
        }
        const claim = await claimImportStagingBatchForAnalysis({
          userId: actor.userId,
          leaseOwner,
          items: needClaim.map((s) => ({
            stagingFileId: s.id,
            expectedSha256: s.sha256,
            expectedVersion: s.version,
          })),
        });
        if (!claim.claimed) {
          throw new ConflictError("staging 无法锁定（状态已变化或被占用）");
        }
        working = await Promise.all(
          inputIds.map((id) =>
            getOwnedImportStaging({ stagingFileId: id, userId: actor.userId }),
          ),
        );
      }
      if (working.some((s) => s.status !== "ANALYZING" && s.status !== "ANALYZED")) {
        throw new ConflictError(
          `staging 状态无法 OCR：${working.map((s) => s.status).join(",")}`,
        );
      }
      // 已全部 ANALYZED 且走到这里说明上面未命中完成态复用——不应再 OCR
      if (working.every((s) => s.status === "ANALYZED")) {
        throw new ConflictError(
          "本批回单已分析但 workspace 不可用，请重新上传",
        );
      }

      const analyzing = working.filter((s) => s.status === "ANALYZING");

      // 残留 ANALYZING（例如 recover 竞态）：仅 stale lease 可接管；fresh 一律拒绝
      const residualAnalyzing = analyzing.filter((s) =>
        stagings.some((orig) => orig.id === s.id && orig.status === "ANALYZING"),
      );
      if (residualAnalyzing.length > 0) {
        const took = await acquireImportStagingAnalyzingLeaseIfStale({
          userId: actor.userId,
          leaseOwner,
          items: residualAnalyzing.map((s) => ({
            stagingFileId: s.id,
            expectedSha256: s.sha256,
          })),
        });
        if (!took.ok) {
          throw new ConflictError("STAGING_IN_PROGRESS：其他请求正在 OCR");
        }
      }

      let workspace =
        resumeWorkspace ??
        (await createTaskWorkspace({
          ownerUserId: actor.userId,
          kind: WORKSPACE_KIND.BANK_FLOW,
          manifest: {
            stagingFileId: analyzing[0]!.id,
            stagingFileIds: inputIds,
            phase: "OCR_PENDING",
            headers: ["payerName", "amount", "date", "remark"],
            rowCount: 0,
            encoding: "utf-8",
            mapping: {
              payerName: "payerName",
              amount: "amount",
              date: "date",
              remark: "remark",
            },
            rows: [],
            source: "ocr",
            ocrProgress: { completed: [], warnings: [] },
          },
        }));

      // 外部 OCR 之前持久化批次→workspace；lease 过期回退 UPLOADED 后仍能凭 sessionId 找回
      try {
        await attachImportStagingSessionWhileAnalyzing({
          userId: actor.userId,
          sessionId: workspace.id,
          leaseOwner,
          items: analyzing.map((s) => ({
            stagingFileId: s.id,
            expectedSha256: s.sha256,
          })),
        });
      } catch (err) {
        if (!resumeWorkspace) {
          // 新建 workspace 尚未绑上：允许失败恢复为 UPLOADED 后重试
          for (const staging of analyzing) {
            await failImportStagingAnalysis({
              stagingFileId: staging.id,
              userId: actor.userId,
              expectedSha256: staging.sha256,
              leaseOwner,
              recoverable: true,
            }).catch(() => undefined);
          }
        }
        if (err instanceof StagingError) mapStagingError(err);
        throw err;
      }

      const priorManifest = resumeWorkspace
        ? parseManifest(workspace.manifestJson)
        : null;
      const completedEntries = [...(priorManifest?.ocrProgress?.completed ?? [])];
      const completedIds = new Set(completedEntries.map((c) => c.stagingFileId));
      const warnings: string[] = [...(priorManifest?.ocrProgress?.warnings ?? [])];
      const leaseItems = analyzing.map((s) => ({
        stagingFileId: s.id,
        expectedSha256: s.sha256,
      }));
      const needingOcrIds = new Set(
        stagingIdsNeedingOcr(
          analyzing.map((s) => s.id),
          completedEntries,
        ),
      );

      const assertLeaseAlive = async () => {
        const beat = await heartbeatImportStagingBatchLease({
          userId: actor.userId,
          leaseOwner,
          items: leaseItems,
        });
        if (!beat.ok) {
          throw new ConflictError(
            "OCR lease 已失效（可能被接管或回收），已停止以避免重复计费",
          );
        }
      };

      const persistOcrFileProgress = async () => {
        await assertLeaseAlive();
        const rowsSoFar = [...completedEntries]
          .sort((a, b) => a.row.index - b.row.index)
          .map((c) => c.row);
        const nextManifest: BankFlowManifest = {
          stagingFileId: analyzing[0]!.id,
          stagingFileIds: inputIds,
          phase: "OCR_PENDING",
          headers: ["payerName", "amount", "date", "remark"],
          rowCount: rowsSoFar.length,
          encoding: "utf-8",
          mapping: {
            payerName: "payerName",
            amount: "amount",
            date: "date",
            remark: "remark",
          },
          rows: rowsSoFar,
          source: "ocr",
          ocrProgress: {
            completed: completedEntries,
            warnings: [...warnings],
          },
        };
        const cas = await updateWorkspaceManifestCAS({
          workspaceId: workspace.id,
          userId: actor.userId,
          expectedVersion: workspace.version,
          manifest: nextManifest as unknown as Record<string, unknown>,
        });
        if (!cas.ok) {
          throw new ConflictError(
            "OCR 进度写入冲突（workspace 版本已变化），已停止以避免重复计费",
          );
        }
        workspace = { ...workspace, version: cas.newVersion, manifestJson: JSON.stringify(nextManifest) };
      };

      try {
        for (let i = 0; i < analyzing.length; i++) {
          const staging = analyzing[i]!;
          const globalIndex = inputIds.indexOf(staging.id);
          const rowIndex = globalIndex >= 0 ? globalIndex : i;
          if (!needingOcrIds.has(staging.id) || completedIds.has(staging.id)) {
            continue;
          }

          await assertLeaseAlive();
          const buffer = await readImportStagingBuffer(staging);
          try {
            // 计费语义：至少一次、逐文件最小重试窗口。
            // OCR 成功到 CAS 落盘之间若崩溃，恢复会对该未完成文件再请求一次；
            // GLM 无幂等键，无法消除该单文件窗口。已完成文件由 ocrProgress 跳过。
            const parsed = await ocrVoucherImage(buffer, staging.mimeType);
            await assertLeaseAlive();
            warnings.push(
              ...parsed.warnings.map((w) => `[${staging.originalName}] ${w}`),
            );
            const amountYuan = parsed.fields.amountYuan;
            const payerName = (parsed.fields.payerName || "").trim();
            const amountCents =
              amountYuan != null && Number.isFinite(amountYuan)
                ? yuanToCents(amountYuan)
                : 0;
            const missing: string[] = [];
            if (!payerName) missing.push("付款方");
            if (amountCents <= 0) missing.push("金额");
            if (missing.length > 0) {
              warnings.push(
                `[${staging.originalName}] 缺字段 ${missing.join("/")}，已标记跳过`,
              );
            }
            completedEntries.push({
              stagingFileId: staging.id,
              row: {
                index: rowIndex,
                payerName: payerName || `(未识别-${staging.originalName})`,
                amountCents,
                date: parsed.fields.receivedAt || undefined,
                remark: parsed.fields.remark || undefined,
                status: missing.length > 0 || amountCents <= 0 ? "SKIPPED" : "PENDING",
              },
            });
            completedIds.add(staging.id);
            await persistOcrFileProgress();
          } catch (err) {
            if (err instanceof GlmOcrClientError) mapGlmOcrError(err);
            throw err;
          }
        }

        const rows = [...completedEntries]
          .sort((a, b) => a.row.index - b.row.index)
          .map((c) => c.row);

        await assertLeaseAlive();
        const nextManifest: BankFlowManifest = {
          stagingFileId: analyzing[0]!.id,
          stagingFileIds: inputIds,
          phase: "MAPPED",
          headers: ["payerName", "amount", "date", "remark"],
          rowCount: rows.length,
          encoding: "utf-8",
          mapping: {
            payerName: "payerName",
            amount: "amount",
            date: "date",
            remark: "remark",
          },
          rows,
          source: "ocr",
          ocrProgress: {
            completed: completedEntries,
            warnings: [...warnings],
          },
        };
        const casFinal = await updateWorkspaceManifestCAS({
          workspaceId: workspace.id,
          userId: actor.userId,
          expectedVersion: workspace.version,
          manifest: nextManifest as unknown as Record<string, unknown>,
        });
        if (!casFinal.ok) {
          throw new ConflictError(
            "OCR 完成态写入冲突，已停止以避免重复计费",
          );
        }
        workspace = {
          ...workspace,
          version: casFinal.newVersion,
          manifestJson: JSON.stringify(nextManifest),
        };

        await completeImportStagingBatchAnalysis({
          userId: actor.userId,
          sessionId: workspace.id,
          parserKey: IMPORT_PARSER_KEY.BANK_FLOW,
          leaseOwner,
          items: analyzing.map((s) => ({
            stagingFileId: s.id,
            expectedSha256: s.sha256,
          })),
        });

        return {
          workspaceId: workspace.id,
          rowCount: rows.length,
          columns: ["payerName", "amount", "date", "remark"],
          mapping: {
            payerName: "payerName",
            amount: "amount",
            date: "date",
            remark: "remark",
          },
          preview: previewBankFlowRows(rows),
          encoding: "utf-8",
          warnings,
          version: workspace.version,
          expectedVersion: workspace.version,
          source: "ocr",
          stats: {
            reused: false,
            resumedOcrPending: Boolean(resumeWorkspace),
            ocrFiles: analyzing.length,
            ocrResumedFromProgress: (priorManifest?.ocrProgress?.completed ?? []).length,
            ocrNewlyProcessed:
              completedEntries.length -
              (priorManifest?.ocrProgress?.completed ?? []).length,
          },
        };
      } catch (err) {
        for (const staging of analyzing) {
          await failImportStagingAnalysis({
            stagingFileId: staging.id,
            userId: actor.userId,
            expectedSha256: staging.sha256,
            leaseOwner,
            recoverable: true,
          }).catch(() => undefined);
        }
        throw err;
      }
}

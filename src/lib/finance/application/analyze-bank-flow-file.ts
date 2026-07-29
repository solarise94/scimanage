/**
 * Canonical actor-aware bank-flow file analyze command (T7.1).
 *
 * Parses import-staging CSV/XLSX, guesses column mapping, creates BANK_FLOW workspace.
 * Shared by Agent `finance.analyze_bank_flow_file`.
 */
import type { BusinessActor } from "@/lib/application/actor";
import { ConflictError, ForbiddenError, ValidationError } from "@/lib/application/errors";
import {
  WORKSPACE_KIND,
  createTaskWorkspace,
  getOwnedWorkspace,
} from "@/lib/agent-task-workspace";
import {
  IMPORT_KIND,
  IMPORT_PARSER_KEY,
  StagingError,
  claimImportStagingForAnalysis,
  completeImportStagingAnalysis,
  failImportStagingAnalysis,
  getOwnedImportStaging,
  isBankFlowImageMime,
  readImportStagingBuffer,
  recoverStaleImportStaging,
} from "@/lib/import-staging";
import {
  STAGING_ANALYZING_LEASE_MS,
  isLeaseStale,
} from "@/lib/staging-common";
import {
  applyBankFlowMapping,
  guessBankFlowColumnMapping,
  parseBankFlowFile,
} from "@/lib/finance/bank-flow-parser";
import { canReadFinance } from "@/lib/finance/permissions";
import {
  parseBankFlowManifest,
  previewBankFlowRows,
  type BankFlowManifest,
  type BankFlowPhase,
} from "@/lib/finance/application/bank-flow-workspace-types";

export type AnalyzeBankFlowFileInput = {
  stagingFileId: string;
};

export type AnalyzeBankFlowFileResult = {
  workspaceId: string;
  rowCount: number;
  columns: string[];
  mapping: BankFlowManifest["mapping"];
  preview: ReturnType<typeof previewBankFlowRows>;
  encoding: BankFlowManifest["encoding"];
  version: number;
  expectedVersion: number;
  warnings: string[];
  stats: {
    reused: boolean;
    phase?: BankFlowPhase;
    encodingUnknown: boolean;
  };
};

function assertAnalyzeCapability(actor: BusinessActor): void {
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

function buildAnalyzeResult(
  workspaceId: string,
  manifest: BankFlowManifest,
  version: number,
  reused: boolean,
  warnings: string[],
  phase?: BankFlowPhase,
): AnalyzeBankFlowFileResult {
  return {
    workspaceId,
    rowCount: manifest.rowCount,
    columns: manifest.headers,
    mapping: manifest.mapping,
    preview: previewBankFlowRows(manifest.rows),
    encoding: manifest.encoding,
    version,
    expectedVersion: version,
    warnings,
    stats: {
      reused,
      phase,
      encodingUnknown: manifest.encoding === "unknown",
    },
  };
}

export async function analyzeBankFlowFileForActor(
  actor: BusinessActor,
  input: AnalyzeBankFlowFileInput,
): Promise<AnalyzeBankFlowFileResult> {
  assertAnalyzeCapability(actor);

  await recoverStaleImportStaging();

  let staging;
  try {
    staging = await getOwnedImportStaging({
      stagingFileId: input.stagingFileId,
      userId: actor.userId,
    });
  } catch (err) {
    if (err instanceof StagingError) mapStagingError(err);
    throw err;
  }

  if (staging.importKind !== IMPORT_KIND.BANK_FLOW) {
    throw new ValidationError("staging 文件类型不是 BANK_FLOW");
  }

  if (staging.status === "FAILED" || staging.status === "EXPIRED") {
    throw new ConflictError("staging 已失败或过期，请重新上传");
  }

  if (staging.status === "ANALYZING") {
    if (isLeaseStale(staging.leaseStartedAt, STAGING_ANALYZING_LEASE_MS)) {
      await recoverStaleImportStaging();
      try {
        staging = await getOwnedImportStaging({
          stagingFileId: input.stagingFileId,
          userId: actor.userId,
        });
      } catch (err) {
        if (err instanceof StagingError) mapStagingError(err);
        throw err;
      }
    } else {
      throw new ConflictError("STAGING_IN_PROGRESS：其他请求正在分析");
    }
  }

  if (staging.status === "ANALYZED" && staging.sessionId) {
    const existing = await getOwnedWorkspace({
      workspaceId: staging.sessionId,
      userId: actor.userId,
    });
    if (existing && existing.kind === WORKSPACE_KIND.BANK_FLOW) {
      const manifest = parseBankFlowManifest(existing.manifestJson);
      const warnings =
        manifest.encoding === "unknown"
          ? ["未能自动识别文件编码，请选择 UTF-8 或 GB18030 后重新应用映射"]
          : [];
      return buildAnalyzeResult(
        existing.id,
        manifest,
        existing.version,
        true,
        warnings,
      );
    }
  }

  if (staging.status !== "UPLOADED") {
    if (staging.status === "ANALYZED" && staging.sessionId) {
      throw new ConflictError("ANALYZED staging 的 workspace 不可用，请重新上传");
    }
    throw new ConflictError(`staging 状态为 ${staging.status}，无法分析`);
  }

  const claim = await claimImportStagingForAnalysis({
    stagingFileId: staging.id,
    userId: actor.userId,
    expectedSha256: staging.sha256,
    expectedVersion: staging.version,
  });
  if (!claim.claimed) {
    throw new ConflictError("staging 无法锁定（状态已变化或被占用）");
  }

  try {
    if (isBankFlowImageMime(staging.mimeType)) {
      throw new ValidationError("该文件是回单图片/PDF，请改用 finance.ocr_bank_flow_receipts");
    }

    const buffer = await readImportStagingBuffer(staging);
    const parsed = parseBankFlowFile(buffer, staging.originalName);
    const guessed = guessBankFlowColumnMapping(parsed.headers);

    let rows: BankFlowManifest["rows"] = parsed.rows.map((_, index) => ({
      index,
      payerName: "",
      amountCents: 0,
      status: "PENDING" as const,
    }));
    let mapping: BankFlowManifest["mapping"] = guessed;
    let warnings: string[] = [];

    if (guessed.payerName && guessed.amount) {
      const applied = applyBankFlowMapping(parsed, {
        payerName: guessed.payerName,
        amount: guessed.amount,
        date: guessed.date,
        remark: guessed.remark,
        payerAccount: guessed.payerAccount,
      });
      rows = applied.rows.map((r) => ({
        index: r.index,
        payerName: r.payerName,
        amountCents: r.amountCents,
        date: r.date,
        remark: r.remark,
        status: r.status,
      }));
      mapping = {
        payerName: guessed.payerName,
        amount: guessed.amount,
        date: guessed.date,
        remark: guessed.remark,
        payerAccount: guessed.payerAccount,
      };
      warnings = applied.warnings;
    }

    const phase: BankFlowPhase =
      mapping.payerName && mapping.amount ? "MAPPED" : "PARSED";

    const manifest: BankFlowManifest = {
      stagingFileId: staging.id,
      phase,
      headers: parsed.headers,
      rowCount: parsed.rowCount,
      encoding: parsed.encoding,
      mapping,
      rows,
    };

    const workspace = await createTaskWorkspace({
      ownerUserId: actor.userId,
      kind: WORKSPACE_KIND.BANK_FLOW,
      manifest: manifest as unknown as Record<string, unknown>,
    });

    await completeImportStagingAnalysis({
      stagingFileId: staging.id,
      userId: actor.userId,
      expectedSha256: staging.sha256,
      sessionId: workspace.id,
      parserKey: IMPORT_PARSER_KEY.BANK_FLOW,
    });

    if (parsed.encoding === "unknown") {
      warnings = [
        ...warnings,
        "未能自动识别文件编码，请选择 UTF-8 或 GB18030 后重新应用映射",
      ];
    }

    return buildAnalyzeResult(
      workspace.id,
      manifest,
      workspace.version,
      false,
      warnings,
      phase,
    );
  } catch (err) {
    await failImportStagingAnalysis({
      stagingFileId: staging.id,
      userId: actor.userId,
      expectedSha256: staging.sha256,
      recoverable: true,
    }).catch(() => undefined);
    if (err instanceof StagingError) mapStagingError(err);
    throw err;
  }
}

/**
 * 后台 Job worker（首版：进程内单消费者循环）。
 *
 * 见 docs/finance-invoice-ocr-orchestration-phase-c-implementation-2026-07-21.md §12.1
 * 与 docs/agent-sequential-order-import-upgrade-design-2026-07-21.md §3.2。
 *
 * 设计约束：
 * - agent-runtime 包是独立 ESM、无 Prisma/app-lib 访问，worker 不能放那里；
 *   因此 worker 以进程内 setInterval 循环实现，由 Next.js instrumentation
 *   `register()` hook 在服务端启动时拉起一次（process lifetime）。
 * - 单 active consumer：claim 走原子 lease（agent-background-jobs.ts），
 *   第二个 worker 无法抢走已 lease 的 Job；同时用 globalThis 单例 flag
 *   防止 dev hot-reload 重复起循环。
 * - 由进程管理器（systemd/podman restart）监督；这是首版 SQLite 单 worker 方案，
 *   未来迭代可拆为独立进程。
 * - handler 幂等（at-least-once）：重复处理 DONE/ANALYZED 安全跳过。
 * - 绝不调用 register；只做 safe OCR 分析。绝不写入原始 OCR 文本/税号/storageKey。
 *
 * 启停：
 *   startAgentBackgroundWorker()  在 instrumentation.register() 中按需调用。
 *   stopAgentBackgroundWorker()   用于测试 / 显式关闭（进程退出时无需手动停）。
 */

import { resolveCurrentBusinessActor } from "@/lib/application/actor";
import type { BusinessActor } from "@/lib/application/actor";
import {
  JOB_KIND,
  JOB_STATUS,
  claimNextJob,
  claimNextItem,
  heartbeatJob,
  markItemDone,
  markItemFailed,
  markItemSkipped,
  requeueItem,
  releaseJob,
  newWorkerId,
  isJobTerminal,
  getJobCycleState,
  finalizeCancelledJob,
  getJobCancelRequestedAt,
} from "@/lib/agent-background-jobs";
import { analyzeInvoiceFileForActor } from "@/lib/finance/application/analyze-invoice-file";
import {
  InvoiceStagingError,
  recoverStaleAnalyzingStaging,
  sweepExpiredInvoiceStaging,
  getInvoiceStagingForIngest,
  getInvoiceStagingExtracted,
} from "@/lib/finance/invoice-staging";
import { matchBankFlowRows } from "@/lib/finance/bank-flow-matcher";
import {
  loadBankFlowMatchWorkspace,
  mergeBankFlowMatchRow,
  parseBankFlowRowIndexFromStagingId,
  reconcileBankFlowMatchWorkspace,
} from "@/lib/finance/bank-flow-match-job";
import { updateWorkspaceManifestCAS } from "@/lib/agent-task-workspace";

/** 默认轮询间隔（ms）。 */
const WORKER_POLL_INTERVAL_MS = 5000;
/** 每隔多少轮做一次 staging 回收/过期清扫。 */
const STAGING_SWEEP_EVERY_N_CYCLES = 12;

type ClaimedJobRef = { id: string };
type ClaimedItemRef = {
  id: string;
  stagingType: string;
  stagingId: string;
  sequenceNo: number;
  attemptCount: number;
};

type JobRow = {
  id: string;
  ownerUserId: string;
  status: string;
  cancelRequestedAt: Date | null;
  kind?: string;
  workspaceId?: string | null;
};

async function resolveJobOwnerActor(ownerUserId: string): Promise<BusinessActor | null> {
  try {
    const actor = await resolveCurrentBusinessActor({
      userId: ownerUserId,
      channel: "agent",
      touchAgentRun: false,
    });
    // 后台 job：所有者必须有权访问当前门户，否则跳过（设计 §2.4）
    const { canActorAccessPortal } = await import("@/lib/portal/guard");
    if (!canActorAccessPortal(actor)) {
      return null;
    }
    return actor;
  } catch {
    return null;
  }
}

/**
 * 处理单个 INVOICE item：加载 staging，幂等判断状态，安全分析。
 * 绝不登记。失败按 attemptCount 走重试（markItemFailed 内决定）。
 */
export async function runInvoiceIngestItem(
  job: JobRow,
  item: ClaimedItemRef,
): Promise<void> {
  if (item.stagingType !== "INVOICE") {
    await markItemSkipped({ itemId: item.id });
    return;
  }

  const staging = await getInvoiceStagingForIngest(item.stagingId);

  if (!staging || staging.createdById !== job.ownerUserId) {
    await markItemSkipped({ itemId: item.id });
    return;
  }

  if (staging.status === "REGISTERED") {
    await markItemDone({
      itemId: item.id,
      resultSummary: { status: "REGISTERED", note: "already registered" },
    });
    return;
  }

  if (staging.status === "SKIPPED") {
    await markItemDone({
      itemId: item.id,
      resultSummary: { status: "SKIPPED" },
    });
    return;
  }

  if (staging.status === "EXPIRED" || staging.expiresAt.getTime() <= Date.now()) {
    await markItemDone({
      itemId: item.id,
      resultSummary: { status: "EXPIRED" },
    });
    return;
  }

  if (staging.status === "ANALYZING") {
    await requeueItem({
      itemId: item.id,
      attemptCount: item.attemptCount,
      soft: true,
    });
    return;
  }

  if (staging.status === "ANALYZED") {
    await markItemDone({
      itemId: item.id,
      resultSummary: await summarizeAnalyzed(staging.id),
    });
    return;
  }

  const ownerActor = await resolveJobOwnerActor(job.ownerUserId);
  if (!ownerActor) {
    await markItemFailed({
      itemId: item.id,
      errorCode: "OWNER_NOT_FOUND",
      attemptCount: item.attemptCount,
    });
    return;
  }

  try {
    const result = await analyzeInvoiceFileForActor(
      ownerActor,
      {
        stagingFileId: staging.id,
        expectedSha256: staging.sha256,
        expectedStagingVersion: staging.version,
      },
      {
        workerIngest: true,
        invocation: { channel: "agent" },
      },
    );

    await markItemDone({
      itemId: item.id,
      resultSummary: {
        status: "ANALYZED",
        matchStatus: result.match.status,
        candidateCount: result.match.candidates.length,
        hasInvoiceNumber: Boolean(result.extracted.invoiceNumber),
        hasIssuedAt: Boolean(result.extracted.issuedAt),
        hasTotalAmount: result.extracted.totalAmountCents != null,
        invoiceType: result.extracted.invoiceType,
        isRedInvoice: result.extracted.isRedInvoice,
        fileName: staging.originalFileName,
      },
    });
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err
        ? String((err as { code: string }).code)
        : "INVOICE_OCR_PROVIDER_ERROR";

    if (err instanceof InvoiceStagingError) {
      if (
        code === "INVOICE_STAGING_CHANGED" ||
        code === "INVOICE_STAGING_EXPIRED" ||
        code === "INVOICE_STAGING_NOT_FOUND"
      ) {
        await markItemSkipped({ itemId: item.id });
        return;
      }
    }

    await markItemFailed({
      itemId: item.id,
      errorCode: code,
      attemptCount: item.attemptCount,
    });
  }
}

/**
 * 处理单个 BANK_FLOW 匹配 item：解析 rowIndex → 匹配 → CAS 合并结果。
 */
export async function runBankFlowMatchItem(
  job: JobRow,
  item: ClaimedItemRef,
): Promise<void> {
  if (item.stagingType !== "BANK_FLOW") {
    await markItemSkipped({ itemId: item.id });
    return;
  }
  if (!job.workspaceId) {
    await markItemSkipped({ itemId: item.id });
    return;
  }

  const rowIndex = parseBankFlowRowIndexFromStagingId(item.stagingId);
  if (rowIndex == null) {
    await markItemSkipped({ itemId: item.id });
    return;
  }

  const loaded = await loadBankFlowMatchWorkspace({
    workspaceId: job.workspaceId,
    ownerUserId: job.ownerUserId,
  });
  if (!loaded) {
    await markItemSkipped({ itemId: item.id });
    return;
  }
  const { ws, manifest } = loaded;

  if (manifest.phase !== "MATCHING") {
    await markItemDone({
      itemId: item.id,
      resultSummary: { status: "SKIPPED_PHASE", phase: manifest.phase },
    });
    return;
  }
  if (manifest.matchJobId && manifest.matchJobId !== job.id) {
    await markItemSkipped({ itemId: item.id });
    return;
  }

  const row = manifest.rows.find((r) => r.index === rowIndex);
  if (!row) {
    await markItemSkipped({ itemId: item.id });
    return;
  }
  if (row.status === "CONFIRMED" || row.status === "SKIPPED") {
    await markItemDone({
      itemId: item.id,
      resultSummary: { status: row.status, rowIndex },
    });
    return;
  }
  if (row.status !== "PENDING") {
    await markItemDone({
      itemId: item.id,
      resultSummary: { status: row.status, rowIndex, note: "already matched" },
    });
    return;
  }

  const ownerActor = await resolveJobOwnerActor(job.ownerUserId);
  if (!ownerActor) {
    await markItemFailed({
      itemId: item.id,
      errorCode: "OWNER_NOT_FOUND",
      attemptCount: item.attemptCount,
    });
    return;
  }

  try {
    const { results, rowUpdates } = await matchBankFlowRows({
      userId: ownerActor.userId,
      role: ownerActor.role,
      rows: manifest.rows,
      rowIndices: [rowIndex],
    });
    const update = rowUpdates.find((u) => u.index === rowIndex);
    const match = results.find((m) => m.rowIndex === rowIndex) || { rowIndex };
    const status = update?.status || "NO_MATCH";

    let merged = false;
    let version = ws.version;
    let working = manifest;
    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt > 0) {
        const again = await loadBankFlowMatchWorkspace({
          workspaceId: job.workspaceId,
          ownerUserId: job.ownerUserId,
        });
        if (!again || again.manifest.phase !== "MATCHING") {
          await markItemDone({
            itemId: item.id,
            resultSummary: { status: "SKIPPED_PHASE", rowIndex },
          });
          return;
        }
        version = again.ws.version;
        working = again.manifest;
      }
      const next = mergeBankFlowMatchRow(working, rowIndex, status, match);
      const cas = await updateWorkspaceManifestCAS({
        workspaceId: job.workspaceId,
        userId: job.ownerUserId,
        expectedVersion: version,
        expectedBoundProposalId: null,
        manifest: next as unknown as Record<string, unknown>,
      });
      if (cas.ok) {
        merged = true;
        break;
      }
    }

    if (!merged) {
      await markItemFailed({
        itemId: item.id,
        errorCode: "WORKSPACE_CAS_FAILED",
        attemptCount: item.attemptCount,
      });
      return;
    }

    await markItemDone({
      itemId: item.id,
      resultSummary: { status, rowIndex },
    });
  } catch (err) {
    await markItemFailed({
      itemId: item.id,
      errorCode:
        err instanceof Error ? err.message.slice(0, 80) : "BANK_FLOW_MATCH_ERROR",
      attemptCount: item.attemptCount,
    });
  }
}

async function summarizeAnalyzed(
  stagingFileId: string,
): Promise<Record<string, unknown>> {
  try {
    const row = await getInvoiceStagingExtracted(stagingFileId);
    if (!row?.extractedJson) {
      return { status: "ANALYZED", note: "no extracted summary" };
    }
    const parsed = JSON.parse(row.extractedJson) as {
      match?: { status?: string; candidateIds?: unknown[] };
      extracted?: {
        invoiceNumber?: unknown;
        issuedAt?: unknown;
        totalAmountCents?: unknown;
        invoiceType?: unknown;
        isRedInvoice?: unknown;
      };
    };
    const match = parsed.match;
    return {
      status: "ANALYZED",
      matchStatus: match?.status ?? null,
      candidateCount: Array.isArray(match?.candidateIds)
        ? match!.candidateIds!.length
        : 0,
      hasInvoiceNumber: Boolean(parsed.extracted?.invoiceNumber),
      hasIssuedAt: Boolean(parsed.extracted?.issuedAt),
      hasTotalAmount: parsed.extracted?.totalAmountCents != null,
      invoiceType: parsed.extracted?.invoiceType ?? null,
      isRedInvoice: parsed.extracted?.isRedInvoice ?? null,
      fileName: row.originalFileName,
    };
  } catch {
    return { status: "ANALYZED", note: "summary parse failed" };
  }
}

/**
 * 处理一轮：FIFO claim 任意可运行 Job（INVOICE_INGEST / BANK_FLOW_MATCH）。
 */
export async function processOneJobCycle(workerId: string): Promise<boolean> {
  const claimed = await claimNextJob({ workerId });
  if (!claimed) return false;
  const jobRef = claimed as ClaimedJobRef;

  const job = await getJobCycleState(jobRef.id);
  if (!job) {
    await releaseJob({ jobId: jobRef.id, workerId });
    return true;
  }

  if (job.status === JOB_STATUS.CANCEL_REQUESTED || job.cancelRequestedAt) {
    await finalizeCancelledJob({ jobId: job.id, workerId });
    // Job 已终态后再 reconcile，崩溃后可按 matchJobId 重入解冻
    if (job.kind === JOB_KIND.BANK_FLOW_MATCH && job.workspaceId) {
      await reconcileBankFlowMatchWorkspace({
        workspaceId: job.workspaceId,
        ownerUserId: job.ownerUserId,
        jobId: job.id,
      }).catch(() => undefined);
    }
    return true;
  }

  const MAX_ITEMS_PER_CYCLE = 50;
  let processed = 0;
  let item: ClaimedItemRef | null;
  while (processed < MAX_ITEMS_PER_CYCLE) {
    const cancelRequestedAt = await getJobCancelRequestedAt(job.id);
    if (cancelRequestedAt) break;

    item = (await claimNextItem({
      jobId: job.id,
      workerId,
    })) as ClaimedItemRef | null;
    if (!item) break;

    await heartbeatJob({ jobId: job.id, workerId }).catch(() => undefined);

    if (job.kind === JOB_KIND.BANK_FLOW_MATCH) {
      await runBankFlowMatchItem(job, item);
    } else if (job.kind === JOB_KIND.INVOICE_INGEST) {
      await runInvoiceIngestItem(job, item);
    } else {
      await markItemSkipped({ itemId: item.id });
    }
    processed += 1;
  }

  await releaseJob({ jobId: job.id, workerId });

  // 终态 Job 不再被领取；用可重入 reconcile 解冻 MATCHING，覆盖崩溃/CAS 失败残留
  if (job.kind === JOB_KIND.BANK_FLOW_MATCH && job.workspaceId) {
    await reconcileBankFlowMatchWorkspace({
      workspaceId: job.workspaceId,
      ownerUserId: job.ownerUserId,
      jobId: job.id,
    }).catch(() => undefined);
  }

  return true;
}

// ─── 进程内循环 ──────────────────────────────────────────────

const GLOBAL_KEY = "__agentBackgroundWorkerStarted";

type GlobalWithWorker = typeof globalThis & {
  [GLOBAL_KEY]?: {
    workerId: string;
    timer: ReturnType<typeof setInterval>;
    cycleCount: number;
  } | null;
};

function isWorkerEnabled(): boolean {
  const flag = (process.env.AGENT_JOB_WORKER_ENABLED || "").trim().toLowerCase();
  if (flag === "false") return false;
  if (flag === "true") return true;
  // 部门隔离 §2.6：双门户部署中，只有主实例（FIELD_SALES，PORTAL_RUN_SCHEDULED_JOBS=true）
  // 承担唯一后台任务。ONLINE_OPS 副实例 PORTAL_RUN_SCHEDULED_JOBS=false 时禁用进程内 worker，
  // 避免两个 app 进程对同一共享 DB 的 AgentBackgroundJob 产生重复 claim。
  // 该开关与 systemd timer owner 一致，由 deploy-portals-prod.sh 协调。
  // 显式 AGENT_JOB_WORKER_ENABLED 仍可强制覆盖（测试/单实例场景）。
  const runScheduled = (process.env.PORTAL_RUN_SCHEDULED_JOBS ?? "").trim().toLowerCase();
  if (runScheduled === "false") return false;
  return process.env.NODE_ENV === "production";
}

export function startAgentBackgroundWorker(): void {
  if (!isWorkerEnabled()) {
    return;
  }
  const g = globalThis as GlobalWithWorker;
  if (g[GLOBAL_KEY]) {
    return;
  }

  const workerId = newWorkerId();
  let cycleCount = 0;
  let inFlight = false;

  const tick = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      const claimed = await processOneJobCycle(workerId);
      cycleCount += 1;
      if (cycleCount % STAGING_SWEEP_EVERY_N_CYCLES === 0) {
        await recoverStaleAnalyzingStaging().catch(() => 0);
        await sweepExpiredInvoiceStaging().catch(() => 0);
      }
      void claimed;
    } catch (err) {
      console.error(
        "[agent-background-worker] cycle error:",
        err instanceof Error ? err.message : err,
      );
    } finally {
      inFlight = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, WORKER_POLL_INTERVAL_MS);

  if (typeof timer.unref === "function") {
    timer.unref();
  }

  g[GLOBAL_KEY] = { workerId, timer, cycleCount };
  console.info(
    `[agent-background-worker] started workerId=${workerId} pollMs=${WORKER_POLL_INTERVAL_MS}`,
  );

  void tick();
}

export function stopAgentBackgroundWorker(): void {
  const g = globalThis as GlobalWithWorker;
  const state = g[GLOBAL_KEY];
  if (!state) return;
  clearInterval(state.timer);
  g[GLOBAL_KEY] = null;
  console.info("[agent-background-worker] stopped");
}

export function getWorkerState(): {
  workerId: string | null;
  cycleCount: number;
} {
  const g = globalThis as GlobalWithWorker;
  const state = g[GLOBAL_KEY];
  return {
    workerId: state?.workerId ?? null,
    cycleCount: state?.cycleCount ?? 0,
  };
}

export { isJobTerminal };

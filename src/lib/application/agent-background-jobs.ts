/**
 * 后台 Job 调度层（独立于聊天 session 与 HTTP 请求）。
 *
 * 见 docs/agent-sequential-order-import-upgrade-design-2026-07-21.md §3.2。
 * - ownerUserId 是所有权主权；initialAgentRunId/currentAgentRunId 只用于展示与接续。
 * - Job 创建后浏览器关闭、chat abort 或 AgentRun 结束都不取消任务。
 * - 独立 worker 使用原子 claim、lease、heartbeat；at-least-once，handler 必须幂等。
 * - 首版 SQLite 只运行一个 active worker consumer。
 * - Job/Item 只保存调度状态，不复制订单行、发票或 OCR 的业务事实。
 */

import { randomUUID } from "crypto";
import { prisma } from "@/lib/prisma";

export const JOB_KIND = {
  ORDER_IMPORT: "ORDER_IMPORT",
  INVOICE_INGEST: "INVOICE_INGEST",
  BANK_FLOW_MATCH: "BANK_FLOW_MATCH",
} as const;
export type JobKind = (typeof JOB_KIND)[keyof typeof JOB_KIND];

export const JOB_STATUS = {
  QUEUED: "QUEUED",
  RUNNING: "RUNNING",
  WAITING_CONFIRMATION: "WAITING_CONFIRMATION",
  PAUSED: "PAUSED",
  COMPLETED: "COMPLETED",
  COMPLETED_WITH_ERRORS: "COMPLETED_WITH_ERRORS",
  CANCEL_REQUESTED: "CANCEL_REQUESTED",
  CANCELLED: "CANCELLED",
  FAILED: "FAILED",
  EXPIRED: "EXPIRED",
} as const;
export type JobStatus = (typeof JOB_STATUS)[keyof typeof JOB_STATUS];

export const JOB_ITEM_STATUS = {
  QUEUED: "QUEUED",
  RUNNING: "RUNNING",
  DONE: "DONE",
  FAILED: "FAILED",
  SKIPPED: "SKIPPED",
} as const;

/** Job lease：worker claim 后的存活窗口，超时后可被回收。 */
export const JOB_LEASE_MS = 5 * 60 * 1000;
export const JOB_ITEM_MAX_ATTEMPTS = 3;

const JOB_TERMINAL = new Set<string>([
  JOB_STATUS.COMPLETED,
  JOB_STATUS.COMPLETED_WITH_ERRORS,
  JOB_STATUS.CANCELLED,
  JOB_STATUS.FAILED,
  JOB_STATUS.EXPIRED,
]);

export function isJobTerminal(status: string): boolean {
  return JOB_TERMINAL.has(status);
}

// ─── 创建 ────────────────────────────────────────────────────

export type CreateJobInput = {
  ownerUserId: string;
  kind: JobKind;
  workspaceId?: string | null;
  subjectType?: string | null;
  subjectId?: string | null;
  initialAgentRunId?: string | null;
  items: Array<{
    stagingType: string;
    stagingId: string;
  }>;
};

/** 在一个事务中创建 Job 与其 item 队列。 */
export async function createBackgroundJob(input: CreateJobInput) {
  return prisma.$transaction(async (tx) => {
    const job = await tx.agentBackgroundJob.create({
      data: {
        ownerUserId: input.ownerUserId,
        workspaceId: input.workspaceId ?? null,
        kind: input.kind,
        subjectType: input.subjectType ?? null,
        subjectId: input.subjectId ?? null,
        status: JOB_STATUS.QUEUED,
        initialAgentRunId: input.initialAgentRunId ?? null,
        currentAgentRunId: input.initialAgentRunId ?? null,
      },
    });
    if (input.items.length > 0) {
      await tx.agentBackgroundJobItem.createMany({
        data: input.items.map((it, idx) => ({
          jobId: job.id,
          sequenceNo: idx,
          stagingType: it.stagingType,
          stagingId: it.stagingId,
          status: JOB_ITEM_STATUS.QUEUED,
        })),
      });
    }
    return job;
  });
}

// ─── 所有权与查询 ────────────────────────────────────────────

export async function getOwnedJob(opts: { jobId: string; userId: string }) {
  const job = await prisma.agentBackgroundJob.findUnique({
    where: { id: opts.jobId },
    include: { items: { orderBy: { sequenceNo: "asc" } } },
  });
  if (!job || job.ownerUserId !== opts.userId) return null;
  return job;
}

/** 列出当前用户未完成的 Job（用于"我的未完成任务"接续）。 */
export async function listActiveJobs(opts: { userId: string; kind?: JobKind; limit?: number }) {
  return prisma.agentBackgroundJob.findMany({
    where: {
      ownerUserId: opts.userId,
      status: { notIn: [...JOB_TERMINAL] },
      ...(opts.kind ? { kind: opts.kind } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: Math.min(opts.limit ?? 20, 50),
  });
}

// ─── worker claim / heartbeat ────────────────────────────────

/**
 * 原子 claim 一个可运行的 Job：QUEUED/RUNNING（lease 空闲/超时）或
 * CANCEL_REQUESTED（由 worker 终态化为 CANCELLED，否则取消中的空闲 Job 永远无人收尾）。
 * 返回带 leaseOwner 的 job 或 null。
 *
 * 注意：必须"先选候选、再按 id 原子 claim"。直接 updateMany 会把所有可运行 Job
 * 一次性盖上本 worker 的 lease，而 worker 一轮只处理一个，其余 Job 被锁满整个
 * lease 窗口（5 分钟）不可见，吞吐塌陷为一 Job/5min。
 */
export async function claimNextJob(opts: {
  workerId: string;
  kind?: JobKind;
}): Promise<{ id: string } | null> {
  const now = new Date();
  const leaseExpiry = new Date(now.getTime() + JOB_LEASE_MS);
  const leaseFree = [
    { leaseOwner: null },
    { leaseExpiresAt: null },
    { leaseExpiresAt: { lte: now } },
  ] as const;
  const CLAIMABLE = [JOB_STATUS.QUEUED, JOB_STATUS.RUNNING, JOB_STATUS.CANCEL_REQUESTED] as const;

  // claim 竞争失败时重选候选（单 worker 下理论不发生，兜底 3 次）。
  for (let attempt = 0; attempt < 3; attempt++) {
    const candidate = await prisma.agentBackgroundJob.findFirst({
      where: {
        status: { in: [...CLAIMABLE] },
        ...(opts.kind ? { kind: opts.kind } : {}),
        OR: [...leaseFree],
      },
      select: { id: true },
      orderBy: { createdAt: "asc" },
    });
    if (!candidate) return null;

    const result = await prisma.agentBackgroundJob.updateMany({
      where: {
        id: candidate.id,
        status: { in: [...CLAIMABLE] },
        OR: [...leaseFree],
      },
      data: {
        status: JOB_STATUS.RUNNING,
        leaseOwner: opts.workerId,
        leaseExpiresAt: leaseExpiry,
        heartbeatAt: now,
      },
    });
    if (result.count === 1) {
      // 回收上个持有者崩溃遗留的 RUNNING item：lease 已归本 worker，
      // 任何 RUNNING item 必为孤儿（否则该 Job 永无可 claim item，空转死循环）。
      await resetOrphanedRunningItems(candidate.id);
      return { id: candidate.id };
    }
  }
  return null;
}

/**
 * 把 Job 内崩溃遗留的 RUNNING item 退回 QUEUED（带退避，不额外消耗 attempt——
 * claimNextItem 时已扣过一次）；达上限的转 FAILED，与 markItemFailed 终态分支一致。
 */
async function resetOrphanedRunningItems(jobId: string): Promise<void> {
  const stuck = await prisma.agentBackgroundJobItem.findMany({
    where: { jobId, status: JOB_ITEM_STATUS.RUNNING },
    select: { id: true, attemptCount: true },
  });
  for (const item of stuck) {
    const retryable = item.attemptCount < JOB_ITEM_MAX_ATTEMPTS;
    await prisma.agentBackgroundJobItem.updateMany({
      where: { id: item.id, status: JOB_ITEM_STATUS.RUNNING },
      data: retryable
        ? {
            status: JOB_ITEM_STATUS.QUEUED,
            errorCode: "WORKER_RESTART",
            nextAttemptAt: new Date(Date.now() + 30_000 * Math.max(item.attemptCount, 1)),
          }
        : { status: JOB_ITEM_STATUS.FAILED, errorCode: "WORKER_RESTART" },
    });
  }
}

/** 续约 lease 与 heartbeat；只有当前 leaseOwner 可续约。 */
export async function heartbeatJob(opts: {
  jobId: string;
  workerId: string;
}): Promise<boolean> {
  const now = new Date();
  const result = await prisma.agentBackgroundJob.updateMany({
    where: { id: opts.jobId, leaseOwner: opts.workerId },
    data: { heartbeatAt: now, leaseExpiresAt: new Date(now.getTime() + JOB_LEASE_MS) },
  });
  return result.count === 1;
}

/** claim Job 内下一个可执行 item（QUEUED 且到达重试时间）。 */
export async function claimNextItem(opts: {
  jobId: string;
  workerId: string;
}): Promise<{ id: string; stagingType: string; stagingId: string; sequenceNo: number; attemptCount: number } | null> {
  const now = new Date();
  const item = await prisma.agentBackgroundJobItem.findFirst({
    where: {
      jobId: opts.jobId,
      status: JOB_ITEM_STATUS.QUEUED,
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
    },
    orderBy: { sequenceNo: "asc" },
  });
  if (!item) return null;
  const result = await prisma.agentBackgroundJobItem.updateMany({
    where: { id: item.id, status: JOB_ITEM_STATUS.QUEUED },
    data: { status: JOB_ITEM_STATUS.RUNNING, attemptCount: { increment: 1 } },
  });
  if (result.count !== 1) return null;
  return {
    id: item.id,
    stagingType: item.stagingType,
    stagingId: item.stagingId,
    sequenceNo: item.sequenceNo,
    attemptCount: item.attemptCount + 1,
  };
}

export async function markItemDone(opts: {
  itemId: string;
  resultSummary?: Record<string, unknown>;
  proposalId?: string | null;
}): Promise<void> {
  await prisma.agentBackgroundJobItem.updateMany({
    where: { id: opts.itemId },
    data: {
      status: JOB_ITEM_STATUS.DONE,
      resultSummaryJson: opts.resultSummary ? JSON.stringify(opts.resultSummary) : null,
      proposalId: opts.proposalId ?? null,
    },
  });
}

export async function markItemFailed(opts: {
  itemId: string;
  errorCode?: string;
  attemptCount: number;
}): Promise<void> {
  const retryable = opts.attemptCount < JOB_ITEM_MAX_ATTEMPTS;
  await prisma.agentBackgroundJobItem.updateMany({
    where: { id: opts.itemId },
    data: retryable
      ? {
          status: JOB_ITEM_STATUS.QUEUED,
          errorCode: opts.errorCode ?? null,
          nextAttemptAt: new Date(Date.now() + 30_000 * opts.attemptCount),
        }
      : {
          status: JOB_ITEM_STATUS.FAILED,
          errorCode: opts.errorCode ?? null,
        },
  });
}

export async function markItemSkipped(opts: { itemId: string }): Promise<void> {
  await prisma.agentBackgroundJobItem.updateMany({
    where: { id: opts.itemId },
    data: { status: JOB_ITEM_STATUS.SKIPPED },
  });
}

/**
 * 非失败退回 QUEUED（如 staging 暂时处于 ANALYZING 被占）：带退避、不记错误。
 *
 * - 默认：达 attempt 上限转 SKIPPED，避免无限重排。
 * - `soft: true`：永不因 attempt 转入终态；并回退本次 claim 消耗的 attempt，
 *   用于等待 ANALYZING lease 恢复等非失败争用（lease 最长 10 分钟，
 *   远超 3×30s 的硬重试窗口）。
 */
export async function requeueItem(opts: {
  itemId: string;
  attemptCount: number;
  delayMs?: number;
  soft?: boolean;
}): Promise<void> {
  const soft = opts.soft === true;
  const retryable = soft || opts.attemptCount < JOB_ITEM_MAX_ATTEMPTS;
  await prisma.agentBackgroundJobItem.updateMany({
    where: { id: opts.itemId },
    data: retryable
      ? {
          status: JOB_ITEM_STATUS.QUEUED,
          nextAttemptAt: new Date(Date.now() + (opts.delayMs ?? 30_000)),
          // soft 争用：claimNextItem 已 +1，此处回退，避免空转烧尽重试预算。
          ...(soft
            ? { attemptCount: Math.max(0, opts.attemptCount - 1) }
            : {}),
        }
      : { status: JOB_ITEM_STATUS.SKIPPED },
  });
}

/** 仅允许向「无活跃 lease 的 QUEUED」Job 追加，避免与 releaseJob 竞态。 */
const APPENDABLE_JOB_STATUS = JOB_STATUS.QUEUED;

/**
 * 向已有 Job 追加 QUEUED items（用于批次幂等时补入尚未入队的 staging）。
 * sequenceNo 接在当前最大值之后；同 job 内已存在的 stagingId 跳过。
 *
 * 仅当 Job 为 QUEUED 且无活跃 lease 时可追加。RUNNING（worker 持有 lease）时
 * `accepted=false`，调用方须为缺失文件新建 Job——否则可能与 releaseJob 竞态，
 * 把新 item 永久留在 COMPLETED Job 里无法再被 claim。
 *
 * `accepted=true && appended=0`：Job 可追加，但目标 staging 已在队列中（并发补入），
 * 调用方应复用该 Job，勿再新建。
 */
export async function appendJobItems(opts: {
  jobId: string;
  items: Array<{ stagingType: string; stagingId: string }>;
}): Promise<{ accepted: boolean; appended: number }> {
  if (opts.items.length === 0) return { accepted: true, appended: 0 };

  return prisma.$transaction(async (tx) => {
    const now = new Date();
    // 先原子占住「可追加」条件：QUEUED + 无活跃 lease。失败则整笔放弃，不写 item。
    const claimed = await tx.agentBackgroundJob.updateMany({
      where: {
        id: opts.jobId,
        status: APPENDABLE_JOB_STATUS,
        OR: [
          { leaseOwner: null },
          { leaseExpiresAt: null },
          { leaseExpiresAt: { lte: now } },
        ],
      },
      data: { version: { increment: 1 } },
    });
    if (claimed.count !== 1) return { accepted: false, appended: 0 };

    const existing = await tx.agentBackgroundJobItem.findMany({
      where: { jobId: opts.jobId },
      select: { stagingId: true, sequenceNo: true },
    });
    const existingIds = new Set(existing.map((row) => row.stagingId));
    const nextItems = opts.items.filter((it) => !existingIds.has(it.stagingId));
    if (nextItems.length === 0) return { accepted: true, appended: 0 };

    const maxSeq = existing.reduce((max, row) => Math.max(max, row.sequenceNo), -1);
    await tx.agentBackgroundJobItem.createMany({
      data: nextItems.map((it, idx) => ({
        jobId: opts.jobId,
        sequenceNo: maxSeq + 1 + idx,
        stagingType: it.stagingType,
        stagingId: it.stagingId,
        status: JOB_ITEM_STATUS.QUEUED,
      })),
    });
    return { accepted: true, appended: nextItems.length };
  });
}

// ─── Job 状态推进 ────────────────────────────────────────────

/** 进入等待确认态（存在唯一待确认 proposal 时）。 */
export async function setJobWaitingConfirmation(opts: {
  jobId: string;
  workerId: string;
}): Promise<void> {
  await prisma.agentBackgroundJob.updateMany({
    where: { id: opts.jobId, leaseOwner: opts.workerId },
    data: { status: JOB_STATUS.WAITING_CONFIRMATION },
  });
}

/** 用户确认后由 confirm 路径唤醒 Job 继续（WAITING_CONFIRMATION → RUNNING）。 */
export async function resumeJobAfterConfirmation(opts: { jobId: string }): Promise<void> {
  await prisma.agentBackgroundJob.updateMany({
    where: { id: opts.jobId, status: JOB_STATUS.WAITING_CONFIRMATION },
    data: { status: JOB_STATUS.RUNNING, leaseOwner: null, leaseExpiresAt: null },
  });
}

/**
 * worker 完成一轮后释放 lease，并根据 item 汇总终态。
 * 读 items + 写 Job 在同一事务内，避免并发追加后用陈旧快照写成 COMPLETED。
 */
export async function releaseJob(opts: { jobId: string; workerId: string }): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const job = await tx.agentBackgroundJob.findUnique({
      where: { id: opts.jobId },
      select: { status: true, cancelRequestedAt: true, leaseOwner: true },
    });
    if (!job || job.leaseOwner !== opts.workerId) return;

    const items = await tx.agentBackgroundJobItem.findMany({
      where: { jobId: opts.jobId },
      select: { status: true },
    });
    const hasQueued = items.some(
      (i) => i.status === JOB_ITEM_STATUS.QUEUED || i.status === JOB_ITEM_STATUS.RUNNING,
    );
    const hasFailed = items.some((i) => i.status === JOB_ITEM_STATUS.FAILED);

    let nextStatus: string;
    if (job.cancelRequestedAt || job.status === JOB_STATUS.CANCEL_REQUESTED) {
      // 取消优先于 item 汇总：即使仍有未处理 item 也终态化为 CANCELLED。
      // 否则此处把 CANCEL_REQUESTED 改写成 QUEUED 后，worker 的取消终态化
      // （按 status=CANCEL_REQUESTED 匹配）会永远 0 行，Job 每 5s 被空转 reclaim。
      nextStatus = JOB_STATUS.CANCELLED;
    } else if (hasQueued) {
      nextStatus = JOB_STATUS.QUEUED; // 仍有待处理，释放 lease 等待下一轮
    } else if (items.length === 0) {
      nextStatus = JOB_STATUS.COMPLETED;
    } else if (hasFailed) {
      nextStatus = JOB_STATUS.COMPLETED_WITH_ERRORS;
    } else {
      nextStatus = JOB_STATUS.COMPLETED;
    }

    await tx.agentBackgroundJob.updateMany({
      where: { id: opts.jobId, leaseOwner: opts.workerId },
      data: { status: nextStatus, leaseOwner: null, leaseExpiresAt: null },
    });
  });
}

// ─── 取消与接续 ──────────────────────────────────────────────

/** 显式取消：只阻止领取新 item；已提交业务事实不回滚。 */
export async function requestCancelJob(opts: { jobId: string; userId: string }): Promise<boolean> {
  const result = await prisma.agentBackgroundJob.updateMany({
    where: {
      id: opts.jobId,
      ownerUserId: opts.userId,
      status: { notIn: [...JOB_TERMINAL] },
    },
    data: { status: JOB_STATUS.CANCEL_REQUESTED, cancelRequestedAt: new Date() },
  });
  return result.count === 1;
}

/** 新 AgentRun 经 owner 校验后接续 Job，只更新 currentAgentRunId。 */
export async function adoptJobToAgentRun(opts: {
  jobId: string;
  userId: string;
  agentRunId: string;
}): Promise<boolean> {
  const result = await prisma.agentBackgroundJob.updateMany({
    where: { id: opts.jobId, ownerUserId: opts.userId },
    data: { currentAgentRunId: opts.agentRunId },
  });
  return result.count === 1;
}

/** Worker 处理周期所需的 Job 状态快照（T9.1a：收敛 worker 对 prisma 的直连）。 */
export async function getJobCycleState(jobId: string) {
  return prisma.agentBackgroundJob.findUnique({
    where: { id: jobId },
    select: {
      id: true,
      ownerUserId: true,
      status: true,
      cancelRequestedAt: true,
      kind: true,
      workspaceId: true,
    },
  });
}

/**
 * 取消终态化：仅当前持锁 worker（leaseOwner）能把 CANCEL_REQUESTED 落为 CANCELLED。
 * T9.1a：原为 worker 内直连 updateMany，收敛到此并保留 lease 守卫语义。
 */
export async function finalizeCancelledJob(opts: { jobId: string; workerId: string }): Promise<boolean> {
  const result = await prisma.agentBackgroundJob.updateMany({
    where: { id: opts.jobId, leaseOwner: opts.workerId },
    data: { status: JOB_STATUS.CANCELLED, leaseOwner: null, leaseExpiresAt: null },
  });
  return result.count === 1;
}

/** Worker 每 item 轮询取消标志（T9.1a：收敛直连）。行不存在 -> undefined，按未取消处理。 */
export async function getJobCancelRequestedAt(jobId: string): Promise<Date | null | undefined> {
  const row = await prisma.agentBackgroundJob.findUnique({
    where: { id: jobId },
    select: { cancelRequestedAt: true },
  });
  return row?.cancelRequestedAt;
}

export function newWorkerId(): string {
  return `worker_${randomUUID().slice(0, 8)}`;
}

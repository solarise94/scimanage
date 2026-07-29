/**
 * INVOICE_INGEST 后台 Job 工厂。
 *
 * 见 docs/finance-invoice-orchestration-phase-c-implementation-2026-07-21.md §12.1。
 * - 受控工作空间（AgentTaskWorkspace, kind=INVOICE_INGEST）作为持久化任务边界。
 * - 后台 Job（AgentBackgroundJob, kind=INVOICE_INGEST）携带 item 队列，
 *   item.stagingId 指向 AgentInvoiceStagingFile.id。
 * - 幂等：同一批 staging 若已全部入队活跃 Job 则复用；若仅部分重叠，
 *   将未入队文件追加到可追加的 Job，或为剩余文件新建 Job——绝不静默丢弃。
 * - 只创建调度信封；worker 负责 safe OCR 分析；绝不在此登记发票。
 */

import { prisma } from "@/lib/prisma";
import {
  JOB_KIND,
  JOB_STATUS,
  appendJobItems,
  createBackgroundJob,
} from "@/lib/agent-background-jobs";
import {
  WORKSPACE_KIND,
  createTaskWorkspace,
} from "@/lib/agent-task-workspace";
import { INVOICE_STAGING_MAX_FILES_PER_MESSAGE } from "@/lib/finance/invoice-staging";

const JOB_TERMINAL_STATUSES = [
  "COMPLETED",
  "COMPLETED_WITH_ERRORS",
  "CANCELLED",
  "FAILED",
  "EXPIRED",
];

export type CreateInvoiceIngestJobResult = {
  jobId: string;
  workspaceId: string;
  created: boolean;
};

/**
 * 为一批发票 staging 文件创建 INVOICE_INGEST Job（幂等）。
 *
 * 调用方必须先完成所有权校验（assertAndBindStagingToAgentRun），
 * 此处仅创建调度信封，不再二次校验 staging 状态。
 */
export async function createInvoiceIngestJob(opts: {
  ownerUserId: string;
  stagingFileIds: string[];
  agentRunId?: string | null;
}): Promise<CreateInvoiceIngestJobResult | null> {
  const uniqueIds = [...new Set(opts.stagingFileIds)].slice(
    0,
    INVOICE_STAGING_MAX_FILES_PER_MESSAGE,
  );
  if (uniqueIds.length === 0) return null;

  // 查出这些 staging 已挂在哪些活跃 INVOICE_INGEST Job 上。
  const existingItems = await prisma.agentBackgroundJobItem.findMany({
    where: {
      stagingType: "INVOICE",
      stagingId: { in: uniqueIds },
      job: {
        ownerUserId: opts.ownerUserId,
        kind: JOB_KIND.INVOICE_INGEST,
        status: { notIn: JOB_TERMINAL_STATUSES },
      },
    },
    select: {
      stagingId: true,
      jobId: true,
      job: { select: { id: true, workspaceId: true, status: true } },
    },
  });

  const coveredIds = new Set(existingItems.map((row) => row.stagingId));
  const missingIds = uniqueIds.filter((id) => !coveredIds.has(id));

  // 全部已入队：复用（若分散在多个 Job，任取一个返回；文件本身都已在队列中）。
  if (missingIds.length === 0) {
    const existingJob = existingItems[0]?.job;
    if (existingJob) {
      return {
        jobId: existingJob.id,
        workspaceId: existingJob.workspaceId ?? "",
        created: false,
      };
    }
  }

  // 部分/全部未入队：优先追加到唯一可追加的重叠 Job。
  if (missingIds.length > 0 && existingItems.length > 0) {
    const jobIds = [...new Set(existingItems.map((row) => row.jobId))];
    if (jobIds.length === 1) {
      const target = existingItems[0]!.job;
      const appendResult = await appendJobItems({
        jobId: target.id,
        items: missingIds.map((stagingId) => ({
          stagingType: "INVOICE",
          stagingId,
        })),
      });
      if (appendResult.accepted) {
        return {
          jobId: target.id,
          workspaceId: target.workspaceId ?? "",
          created: false,
        };
      }
      // Job 不可追加（RUNNING 持有 lease / WAITING_CONFIRMATION / PAUSED / 竞态等）：
      // 下落到为 missingIds 新建 Job，避免追加后被 releaseJob 终态吞掉。
    }
    // 多 Job 部分重叠：不为了合并跨 Job 而改写已有队列，只为 missing 新建。
  }

  const idsToEnqueue = missingIds.length > 0 ? missingIds : uniqueIds;

  const workspace = await createTaskWorkspace({
    ownerUserId: opts.ownerUserId,
    kind: WORKSPACE_KIND.INVOICE_INGEST,
    manifest: {
      stagingFileIds: idsToEnqueue,
      fileCount: idsToEnqueue.length,
    },
  });

  const job = await createBackgroundJob({
    ownerUserId: opts.ownerUserId,
    kind: JOB_KIND.INVOICE_INGEST,
    workspaceId: workspace.id,
    subjectType: "AgentInvoiceStagingFile",
    subjectId: idsToEnqueue.length === 1 ? idsToEnqueue[0] : null,
    initialAgentRunId: opts.agentRunId ?? null,
    items: idsToEnqueue.map((stagingId) => ({
      stagingType: "INVOICE",
      stagingId,
    })),
  });

  return {
    jobId: job.id,
    workspaceId: workspace.id,
    created: true,
  };
}

/**
 * 列出当前用户活跃的 INVOICE_INGEST Job（用于"我的未完成任务"接续）。
 */
export async function listActiveInvoiceIngestJobs(opts: {
  userId: string;
  limit?: number;
}) {
  const jobs = await prisma.agentBackgroundJob.findMany({
    where: {
      ownerUserId: opts.userId,
      kind: JOB_KIND.INVOICE_INGEST,
      status: { notIn: JOB_TERMINAL_STATUSES },
    },
    orderBy: { createdAt: "desc" },
    take: Math.min(opts.limit ?? 20, 50),
    include: {
      items: {
        orderBy: { sequenceNo: "asc" },
        select: {
          id: true,
          sequenceNo: true,
          stagingType: true,
          stagingId: true,
          status: true,
          attemptCount: true,
          errorCode: true,
          resultSummaryJson: true,
        },
      },
    },
  });
  return jobs;
}

/** 仅用于类型导出：活跃 Job 的状态集合（避免字面量散落）。 */
export const INVOICE_INGEST_ACTIVE_STATUSES = JOB_TERMINAL_STATUSES.map(
  (s) => s as (typeof JOB_STATUS)[keyof typeof JOB_STATUS],
);

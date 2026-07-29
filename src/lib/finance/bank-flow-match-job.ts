/**
 * BANK_FLOW_MATCH 后台 Job 工厂。
 *
 * 行数 > 50（或显式 async）时，将 PENDING 行入队异步匹配；
 * workspace phase 进入 MATCHING，完成后回 MATCHED。
 */

import { prisma } from "@/lib/prisma";
import {
  JOB_KIND,
  JOB_STATUS,
  createBackgroundJob,
  isJobTerminal,
} from "@/lib/agent-background-jobs";
import {
  WORKSPACE_KIND,
  WORKSPACE_STATUS,
  getOwnedWorkspace,
  updateWorkspaceManifestCAS,
} from "@/lib/agent-task-workspace";
import type { BankFlowMatchResult, BankFlowRowStatus } from "@/lib/finance/bank-flow-matcher";
import {
  parseBankFlowManifest,
  type BankFlowManifest,
} from "@/lib/finance/application/bank-flow-workspace-types";

export const BANK_FLOW_SYNC_MATCH_MAX_ROWS = 50;

export type BankFlowMatchJobManifest = BankFlowManifest;

export type CreateBankFlowMatchJobResult = {
  jobId: string;
  workspaceId: string;
  version: number;
  rowCount: number;
  created: boolean;
};

function parseManifest(raw: string | null | undefined): BankFlowMatchJobManifest {
  return parseBankFlowManifest(raw);
}

export function parseBankFlowRowIndexFromStagingId(stagingId: string): number | null {
  // `${workspaceId}:${rowIndex}`
  const idx = stagingId.lastIndexOf(":");
  if (idx < 0) return null;
  const n = Number(stagingId.slice(idx + 1));
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

/**
 * 为 workspace 中待匹配行创建 BANK_FLOW_MATCH Job，并将 phase CAS 为 MATCHING。
 */
export async function createBankFlowMatchJob(opts: {
  ownerUserId: string;
  workspaceId: string;
  expectedVersion: number;
  rowIndices?: number[];
  agentRunId?: string | null;
}): Promise<CreateBankFlowMatchJobResult> {
  const ws = await getOwnedWorkspace({
    workspaceId: opts.workspaceId,
    userId: opts.ownerUserId,
  });
  if (!ws) throw Object.assign(new Error("WORKSPACE_NOT_FOUND"), { code: "WORKSPACE_NOT_FOUND" });
  if (ws.kind !== WORKSPACE_KIND.BANK_FLOW) {
    throw Object.assign(new Error("WORKSPACE_KIND_INVALID"), { code: "WORKSPACE_KIND_INVALID" });
  }
  if (ws.status !== WORKSPACE_STATUS.ACTIVE) {
    throw Object.assign(new Error("WORKSPACE_NOT_ACTIVE"), { code: "WORKSPACE_NOT_ACTIVE" });
  }
  if (ws.version !== opts.expectedVersion) {
    throw Object.assign(new Error("WORKSPACE_VERSION_CONFLICT"), {
      code: "WORKSPACE_VERSION_CONFLICT",
    });
  }

  let manifest = parseManifest(ws.manifestJson);
  let workspaceVersion = ws.version;

  // 已有活跃匹配 Job：复用；终态则先 reconcile 解冻再继续
  if (manifest.phase === "MATCHING" && manifest.matchJobId) {
    const existing = await prisma.agentBackgroundJob.findUnique({
      where: { id: manifest.matchJobId },
      select: { id: true, status: true, workspaceId: true },
    });
    if (existing && !isJobTerminal(existing.status)) {
      return {
        jobId: existing.id,
        workspaceId: opts.workspaceId,
        version: workspaceVersion,
        rowCount: 0,
        created: false,
      };
    }
    await reconcileBankFlowMatchWorkspace({
      workspaceId: opts.workspaceId,
      ownerUserId: opts.ownerUserId,
      jobId: manifest.matchJobId,
    });
    const refreshed = await getOwnedWorkspace({
      workspaceId: opts.workspaceId,
      userId: opts.ownerUserId,
    });
    if (!refreshed) {
      throw Object.assign(new Error("WORKSPACE_NOT_FOUND"), { code: "WORKSPACE_NOT_FOUND" });
    }
    manifest = parseManifest(refreshed.manifestJson);
    workspaceVersion = refreshed.version;
    if (opts.expectedVersion !== workspaceVersion) {
      // reconcile 推进了 version；调用方需用新 version 重试
      throw Object.assign(new Error("WORKSPACE_VERSION_CONFLICT"), {
        code: "WORKSPACE_VERSION_CONFLICT",
      });
    }
  }

  if (manifest.phase !== "MAPPED" && manifest.phase !== "MATCHED") {
    throw Object.assign(new Error(`phase=${manifest.phase}`), {
      code: "WORKSPACE_PHASE_INVALID",
    });
  }

  const targetSet =
    opts.rowIndices && opts.rowIndices.length > 0
      ? new Set(opts.rowIndices)
      : null;
  const pendingRows = manifest.rows.filter((r) => {
    if (r.status !== "PENDING") return false;
    if (targetSet && !targetSet.has(r.index)) return false;
    return r.amountCents > 0;
  });
  if (pendingRows.length === 0) {
    throw Object.assign(new Error("没有待匹配的 PENDING 行"), {
      code: "NO_PENDING_ROWS",
    });
  }

  const job = await createBackgroundJob({
    ownerUserId: opts.ownerUserId,
    kind: JOB_KIND.BANK_FLOW_MATCH,
    workspaceId: opts.workspaceId,
    subjectType: "AgentTaskWorkspace",
    subjectId: opts.workspaceId,
    initialAgentRunId: opts.agentRunId ?? null,
    items: pendingRows.map((r) => ({
      stagingType: "BANK_FLOW",
      stagingId: `${opts.workspaceId}:${r.index}`,
    })),
  });

  const next: BankFlowMatchJobManifest = {
    ...manifest,
    phase: "MATCHING",
    matchJobId: job.id,
  };
  const cas = await updateWorkspaceManifestCAS({
    workspaceId: opts.workspaceId,
    userId: opts.ownerUserId,
    expectedVersion: workspaceVersion,
    expectedBoundProposalId: null,
    manifest: next as unknown as Record<string, unknown>,
  });
  if (!cas.ok) {
    // Job 已创建但 CAS 失败：请求取消，避免孤儿 MATCHING
    await prisma.agentBackgroundJob.updateMany({
      where: { id: job.id, ownerUserId: opts.ownerUserId },
      data: {
        status: JOB_STATUS.CANCEL_REQUESTED,
        cancelRequestedAt: new Date(),
      },
    });
    throw Object.assign(new Error("WORKSPACE_VERSION_CONFLICT"), {
      code: "WORKSPACE_VERSION_CONFLICT",
    });
  }

  return {
    jobId: job.id,
    workspaceId: opts.workspaceId,
    version: cas.newVersion,
    rowCount: pendingRows.length,
    created: true,
  };
}

/** 合并单行匹配结果到 manifest（供 worker 使用）。 */
export function mergeBankFlowMatchRow(
  manifest: BankFlowMatchJobManifest,
  rowIndex: number,
  status: BankFlowRowStatus,
  match: BankFlowMatchResult,
): BankFlowMatchJobManifest {
  const rows = manifest.rows.map((r) =>
    r.index === rowIndex ? { ...r, status } : r,
  );
  const prev = new Map((manifest.matchResults || []).map((m) => [m.rowIndex, m]));
  prev.set(rowIndex, match);
  return {
    ...manifest,
    rows,
    matchResults: [...prev.values()].sort((a, b) => a.rowIndex - b.rowIndex),
  };
}

/**
 * 根据 Job 终态决定如何解冻 MATCHING workspace。
 * 纯函数，便于单测；实际写库走 reconcileBankFlowMatchWorkspace。
 */
export function decideBankFlowMatchReconcileAction(opts: {
  phase: string;
  matchJobId: string | null | undefined;
  jobId: string;
  jobStatus: string | null;
}): "finalize" | "revert" | "noop" {
  if (opts.phase !== "MATCHING") return "noop";
  if (!opts.matchJobId || opts.matchJobId !== opts.jobId) return "noop";
  if (
    opts.jobStatus === JOB_STATUS.COMPLETED ||
    opts.jobStatus === JOB_STATUS.COMPLETED_WITH_ERRORS
  ) {
    return "finalize";
  }
  if (
    opts.jobStatus == null ||
    opts.jobStatus === JOB_STATUS.CANCELLED ||
    opts.jobStatus === JOB_STATUS.FAILED ||
    opts.jobStatus === JOB_STATUS.EXPIRED
  ) {
    return "revert";
  }
  return "noop";
}

/**
 * Job 全部 item 终态后：MATCHING → MATCHED，清除 matchJobId。
 * 带短重试以应对并发 version 冲突。
 */
export async function finalizeBankFlowMatchWorkspace(opts: {
  workspaceId: string;
  ownerUserId: string;
  jobId: string;
}): Promise<boolean> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const ws = await getOwnedWorkspace({
      workspaceId: opts.workspaceId,
      userId: opts.ownerUserId,
    });
    if (!ws) return false;
    const manifest = parseManifest(ws.manifestJson);
    if (manifest.phase !== "MATCHING") return true;
    if (manifest.matchJobId && manifest.matchJobId !== opts.jobId) return false;

    const next: BankFlowMatchJobManifest = {
      ...manifest,
      phase: "MATCHED",
      matchJobId: null,
    };
    const cas = await updateWorkspaceManifestCAS({
      workspaceId: opts.workspaceId,
      userId: opts.ownerUserId,
      expectedVersion: ws.version,
      expectedBoundProposalId: null,
      manifest: next as unknown as Record<string, unknown>,
    });
    if (cas.ok) return true;
  }
  return false;
}

/**
 * 取消 Job：MATCHING → MAPPED，保留已写入的部分 matchResults。
 */
export async function revertBankFlowMatchOnCancel(opts: {
  workspaceId: string;
  ownerUserId: string;
  jobId: string;
}): Promise<boolean> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const ws = await getOwnedWorkspace({
      workspaceId: opts.workspaceId,
      userId: opts.ownerUserId,
    });
    if (!ws) return false;
    const manifest = parseManifest(ws.manifestJson);
    if (manifest.phase !== "MATCHING") return true;
    if (manifest.matchJobId && manifest.matchJobId !== opts.jobId) return false;

    const next: BankFlowMatchJobManifest = {
      ...manifest,
      phase: "MAPPED",
      matchJobId: null,
    };
    const cas = await updateWorkspaceManifestCAS({
      workspaceId: opts.workspaceId,
      userId: opts.ownerUserId,
      expectedVersion: ws.version,
      expectedBoundProposalId: null,
      manifest: next as unknown as Record<string, unknown>,
    });
    if (cas.ok) return true;
  }
  return false;
}

/**
 * 可重入 reconcile：按 matchJobId 对照 Job 终态解冻 MATCHING workspace。
 * 覆盖完成 / 取消 / 失败 / Job 丢失；Job 仍在跑时为 noop。
 * 在读取 workspace、创建新 match Job、worker 释放后调用，避免终态 Job 永久冻结。
 */
export async function reconcileBankFlowMatchWorkspace(opts: {
  workspaceId: string;
  ownerUserId: string;
  jobId: string;
}): Promise<"finalized" | "reverted" | "noop" | "failed"> {
  const ws = await getOwnedWorkspace({
    workspaceId: opts.workspaceId,
    userId: opts.ownerUserId,
  });
  if (!ws) return "noop";
  const manifest = parseManifest(ws.manifestJson);
  const job = await prisma.agentBackgroundJob.findUnique({
    where: { id: opts.jobId },
    select: { id: true, status: true },
  });
  const action = decideBankFlowMatchReconcileAction({
    phase: manifest.phase,
    matchJobId: manifest.matchJobId,
    jobId: opts.jobId,
    jobStatus: job?.status ?? null,
  });
  if (action === "noop") return "noop";
  if (action === "finalize") {
    const ok = await finalizeBankFlowMatchWorkspace(opts);
    return ok ? "finalized" : "failed";
  }
  const ok = await revertBankFlowMatchOnCancel(opts);
  return ok ? "reverted" : "failed";
}

/** 若 workspace 停在 MATCHING 且挂着 matchJobId，按 Job 终态解冻。 */
export async function reconcileBankFlowMatchIfNeeded(opts: {
  workspaceId: string;
  ownerUserId: string;
  matchJobId?: string | null;
}): Promise<"finalized" | "reverted" | "noop" | "failed"> {
  if (!opts.matchJobId) return "noop";
  return reconcileBankFlowMatchWorkspace({
    workspaceId: opts.workspaceId,
    ownerUserId: opts.ownerUserId,
    jobId: opts.matchJobId,
  });
}

/** 读取并解析 workspace（worker 用）。 */
export async function loadBankFlowMatchWorkspace(opts: {
  workspaceId: string;
  ownerUserId: string;
}) {
  const ws = await getOwnedWorkspace({
    workspaceId: opts.workspaceId,
    userId: opts.ownerUserId,
  });
  if (!ws) return null;
  return { ws, manifest: parseManifest(ws.manifestJson) };
}

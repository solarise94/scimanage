/**
 * 受控任务工作空间。
 *
 * 见 docs/agent-sequential-order-import-upgrade-design-2026-07-21.md §3.1。
 * 服务端管理的持久化文件边界，保存私有输入、manifest、中间结果和输出引用。
 * 不提供 shell / venv / 任意命令执行；Agent 只能通过固定 action 操作。
 */

import path from "path";
import { prisma } from "@/lib/prisma";
import {
  STAGING_MAX_TTL_MS,
  computeExpiresAt,
  ensureDir,
} from "@/lib/staging-common";

export const WORKSPACE_KIND = {
  ORDER_IMPORT: "ORDER_IMPORT",
  INVOICE_INGEST: "INVOICE_INGEST",
  BANK_FLOW: "BANK_FLOW",
} as const;
export type WorkspaceKind = (typeof WORKSPACE_KIND)[keyof typeof WORKSPACE_KIND];

export const WORKSPACE_STATUS = {
  ACTIVE: "ACTIVE",
  COMPLETED: "COMPLETED",
  EXPIRED: "EXPIRED",
  CANCELLED: "CANCELLED",
} as const;

export function getWorkspaceRoot(): string {
  const configured = (process.env.AGENT_WORKSPACE_DIR || "").trim();
  if (configured) return path.resolve(configured);
  return path.resolve(process.cwd(), ".agent-workspace");
}

export async function createTaskWorkspace(opts: {
  ownerUserId: string;
  kind: WorkspaceKind;
  manifest?: Record<string, unknown>;
  ttlMs?: number;
}) {
  const root = await ensureDir(getWorkspaceRoot());
  const id = `ws_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  const storagePrefix = path.posix.join(opts.ownerUserId, opts.kind, id);
  await ensureDir(path.join(root, storagePrefix));

  return prisma.agentTaskWorkspace.create({
    data: {
      ownerUserId: opts.ownerUserId,
      kind: opts.kind,
      storagePrefix,
      manifestJson: opts.manifest ? JSON.stringify(opts.manifest) : null,
      status: WORKSPACE_STATUS.ACTIVE,
      expiresAt: computeExpiresAt(opts.ttlMs ?? STAGING_MAX_TTL_MS),
    },
  });
}

export async function getOwnedWorkspace(opts: {
  workspaceId: string;
  userId: string;
}) {
  const ws = await prisma.agentTaskWorkspace.findUnique({
    where: { id: opts.workspaceId },
  });
  if (!ws || ws.ownerUserId !== opts.userId) return null;
  return ws;
}

/**
 * 列出某 owner 指定 kind 的 ACTIVE workspace（按 createdAt 倒序）。
 *
 * 用于崩溃恢复扫描（如 OCR_PENDING workspace 在 create→attach 之间中断），
 * 让 adapter 无需直连 Prisma。AgentTaskWorkspace 为 Agent 自身模型（§1.4）。
 */
export async function listActiveWorkspacesByKind(opts: {
  ownerUserId: string;
  kind: WorkspaceKind;
  limit?: number;
}) {
  return prisma.agentTaskWorkspace.findMany({
    where: {
      ownerUserId: opts.ownerUserId,
      kind: opts.kind,
      status: WORKSPACE_STATUS.ACTIVE,
    },
    orderBy: { createdAt: "desc" },
    take: Math.max(1, Math.min(opts.limit ?? 30, 100)),
  });
}

export async function updateWorkspaceManifest(opts: {
  workspaceId: string;
  userId: string;
  manifest: Record<string, unknown>;
}): Promise<void> {
  await prisma.agentTaskWorkspace.updateMany({
    where: { id: opts.workspaceId, ownerUserId: opts.userId },
    data: { manifestJson: JSON.stringify(opts.manifest), version: { increment: 1 } },
  });
}

/**
 * CAS 更新 workspace manifest（乐观锁）。
 * expectedVersion 必须匹配；可选 boundProposalId fencing（实体列）。
 */
export async function updateWorkspaceManifestCAS(opts: {
  workspaceId: string;
  userId: string;
  expectedVersion: number;
  manifest: Record<string, unknown>;
  /**
   * fencing 条件：要求 boundProposalId 实体列的当前值。
   * - string：要求当前等于该 proposalId
   * - null：要求当前为 null
   * - undefined：不参与 where 过滤
   */
  expectedBoundProposalId?: string | null;
  /**
   * 本次写入的 boundProposalId 新值。
   * - string：绑定到该 proposal
   * - null：清空绑定
   * - undefined：不修改该列
   */
  nextBoundProposalId?: string | null;
  /** 可选：同时更新 status（如 CONFIRMED 终态写 COMPLETED） */
  nextStatus?: string;
}): Promise<{ ok: boolean; newVersion: number }> {
  const where: {
    id: string;
    ownerUserId: string;
    version: number;
    status: string;
    boundProposalId?: string | null;
  } = {
    id: opts.workspaceId,
    ownerUserId: opts.userId,
    version: opts.expectedVersion,
    status: WORKSPACE_STATUS.ACTIVE,
  };
  if (opts.expectedBoundProposalId !== undefined) {
    where.boundProposalId = opts.expectedBoundProposalId;
  }

  const data: {
    manifestJson: string;
    version: { increment: number };
    boundProposalId?: string | null;
    status?: string;
  } = {
    manifestJson: JSON.stringify(opts.manifest),
    version: { increment: 1 },
  };
  if (opts.nextBoundProposalId !== undefined) {
    data.boundProposalId = opts.nextBoundProposalId;
  }
  if (opts.nextStatus !== undefined) {
    data.status = opts.nextStatus;
  }

  const result = await prisma.agentTaskWorkspace.updateMany({ where, data });
  if (result.count === 0) return { ok: false, newVersion: -1 };
  return { ok: true, newVersion: opts.expectedVersion + 1 };
}

export async function completeWorkspace(opts: {
  workspaceId: string;
  userId: string;
}): Promise<void> {
  await prisma.agentTaskWorkspace.updateMany({
    where: { id: opts.workspaceId, ownerUserId: opts.userId, status: WORKSPACE_STATUS.ACTIVE },
    data: { status: WORKSPACE_STATUS.COMPLETED },
  });
}

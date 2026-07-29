/**
 * 通用附件 → 业务目标的路由：幂等键、STALE CAS 重采纳、提升恢复（§4.1 / §5.1 / §6.3）。
 *
 * - 发票采纳（safe）：activeRouteKey=INVOICE_STAGING:{userId}:{stagingId} 互斥；
 *   目标失效后 CAS 标 STALE 清 key 再重采纳，历史 route 保留审计。
 * - 项目备注（confirm）：proposalItemKey=PROJECT_NOTE:{proposalId}:{stagingId} 逐文件唯一。
 * - 提升崩溃恢复：resumePendingAgentAttachmentRoutes() 覆盖 rename 前/后崩溃，不重复创建。
 */

import { prisma } from "@/lib/prisma";
import { StagingError } from "@/lib/staging-common";
import { getAttachmentForRouteResume } from "@/lib/projects/application/project-attachments";
import {
  NoteAttachmentPromoteError,
  promoteProjectNoteAttachment,
} from "@/lib/projects/application/note-attachment-promote";

export type AttachmentRouteState = "PENDING" | "PROCESSING" | "PROMOTED" | "FAILED" | "STALE";

export function invoiceAdoptionRouteKey(ownerUserId: string, stagingId: string): string {
  return `INVOICE_STAGING:${ownerUserId}:${stagingId}`;
}

export function projectNoteItemRouteKey(proposalId: string, stagingId: string): string {
  return `PROJECT_NOTE:${proposalId}:${stagingId}`;
}

function isP2002(err: unknown): boolean {
  return (
    typeof err === "object"
    && err !== null
    && (err as { code?: string }).code === "P2002"
  );
}

/** 创建带 activeRouteKey 的路由（发票采纳）。唯一键冲突时抛 StagingError(ROUTE_CONFLICT)。 */
export async function createActiveKeyRoute(opts: {
  stagingId: string;
  activeRouteKey: string;
  targetType: string;
  expectedSha256: string;
  expectedVersion: number;
  sourceProposalId?: string | null;
}) {
  try {
    return await prisma.agentAttachmentRoute.create({
      data: {
        stagingId: opts.stagingId,
        activeRouteKey: opts.activeRouteKey,
        targetType: opts.targetType,
        state: "PENDING",
        expectedSha256: opts.expectedSha256,
        expectedVersion: opts.expectedVersion,
        sourceProposalId: opts.sourceProposalId ?? null,
      },
    });
  } catch (err) {
    if (isP2002(err)) {
      throw new StagingError("ROUTE_CONFLICT", "路由唯一键冲突", 409);
    }
    throw err;
  }
}

export async function findRouteByActiveKey(activeRouteKey: string) {
  return prisma.agentAttachmentRoute.findUnique({ where: { activeRouteKey } });
}

/**
 * CAS 将旧 route 标为 STALE 并清空 activeRouteKey。
 * where 含 id + activeRouteKey + state，确保只更新自己认定的那条；并发只有一个赢家。
 */
export async function casMarkRouteStale(opts: {
  routeId: string;
  activeRouteKey: string;
  expectedStates: AttachmentRouteState[];
}): Promise<boolean> {
  const result = await prisma.agentAttachmentRoute.updateMany({
    where: {
      id: opts.routeId,
      activeRouteKey: opts.activeRouteKey,
      state: { in: opts.expectedStates },
    },
    data: { state: "STALE", activeRouteKey: null },
  });
  return result.count === 1;
}

/** 把 route 推进到 PROCESSING（提升开始），写入处理 proposal 与目标附件。 */
export async function markRouteProcessing(opts: {
  routeId: string;
  processingProposalId?: string | null;
  destinationAttachmentId?: string | null;
}) {
  return prisma.agentAttachmentRoute.update({
    where: { id: opts.routeId },
    data: {
      state: "PROCESSING",
      processingProposalId: opts.processingProposalId ?? null,
      destinationAttachmentId: opts.destinationAttachmentId ?? null,
    },
  });
}

export async function markRoutePromoted(routeId: string, targetId?: string | null) {
  return prisma.agentAttachmentRoute.update({
    where: { id: routeId },
    data: { state: "PROMOTED", targetId: targetId ?? undefined },
  });
}

/**
 * P1#4+fencing: CAS 把 route 从 PENDING 推进到 PROCESSING **并写入预分配 targetId**。
 *
 * 关键 fencing：updateMany 带 activeRouteKey + state=PENDING 条件。若恢复任务已把该 route
 * 标 FAILED 并清空 activeRouteKey（旧 worker 不再持有键），则 count=0 → 抛错，调用方不得继续
 * 创建 invoice staging，从而阻止旧 worker 重建第二个。
 *
 * @returns true=认领成功；false=已丢失 route（被恢复/并发接管），调用方应放弃或重试整个 adopt。
 */
export async function markRouteTargetBound(opts: {
  routeId: string;
  activeRouteKey: string;
  targetId: string;
}): Promise<boolean> {
  const result = await prisma.agentAttachmentRoute.updateMany({
    where: {
      id: opts.routeId,
      activeRouteKey: opts.activeRouteKey,
      state: "PENDING",
    },
    data: {
      state: "PROCESSING",
      targetId: opts.targetId,
    },
  });
  return result.count === 1;
}

export async function markRouteFailed(routeId: string, error: string) {
  return prisma.agentAttachmentRoute.update({
    where: { id: routeId },
    data: { state: "FAILED", error: error.slice(0, 500) },
  });
}

/**
 * 项目备注附件路由的崩溃恢复。
 * 扫描 PROCESSING 且 targetType=PROJECT_NOTE 的 route：
 *  - 目标附件 READY 或 PENDING_FILE → 共用 promoteProjectNoteAttachment（rename 前/后崩溃均可续接）；
 *  - 源暂不可读 → 保持 PENDING_FILE + PROCESSING，下次 sweep 重试（不标 attachment FAILED）。
 * 旧 proposal 只能更新自己绑定的 route（route.processingProposalId 约束由调用方传入）。
 */
export async function resumePendingAgentAttachmentRoutes(limit = 50): Promise<{
  promoted: number;
  failed: number;
}> {
  const routes = await prisma.agentAttachmentRoute.findMany({
    where: { state: "PROCESSING", targetType: "PROJECT_NOTE" },
    take: limit,
    select: {
      id: true,
      stagingId: true,
      destinationAttachmentId: true,
      expectedSha256: true,
      expectedVersion: true,
      staging: { select: { storageKey: true, sha256: true, version: true } },
    },
  });

  let promoted = 0;
  let failed = 0;

  for (const route of routes) {
    if (!route.destinationAttachmentId) {
      // DB 事务尚未创建目标附件（创建前崩溃）：标 FAILED，由用户重新 confirm。
      await markRouteFailed(route.id, "提升在创建目标附件前中断");
      failed += 1;
      continue;
    }

    // T9.1a：业务模型读取走 projects canonical service，不再直连 prisma.attachment
    const attachment = await getAttachmentForRouteResume(route.destinationAttachmentId);
    if (!attachment) {
      await markRouteFailed(route.id, "目标附件缺失");
      failed += 1;
      continue;
    }
    if (attachment.status === "READY" || attachment.status === "PENDING_FILE") {
      if (attachment.status === "PENDING_FILE" && !attachment.storageKey) {
        await markRouteFailed(route.id, "目标附件缺少存储键");
        failed += 1;
        continue;
      }
      try {
        const result = await promoteProjectNoteAttachment({
          attachmentId: attachment.id,
          projectId: attachment.projectId,
          storageKey: attachment.storageKey ?? "",
          stagingStorageKey: route.staging.storageKey,
          routeId: route.id,
          integrity: {
            expectedSha256: route.expectedSha256,
            expectedVersion: route.expectedVersion,
            stagingSha256: route.staging.sha256,
            stagingVersion: route.staging.version,
          },
        });
        if (result.outcome === "promoted" || result.outcome === "already_ready") {
          promoted += 1;
        }
      } catch (err) {
        if (err instanceof NoteAttachmentPromoteError && err.recoverable) {
          continue;
        }
        await markRouteFailed(
          route.id,
          err instanceof Error ? err.message.slice(0, 500) : "目标附件提升失败",
        );
        failed += 1;
      }
      continue;
    }
    // FAILED 附件：route 也标 FAILED。
    await markRouteFailed(route.id, "目标附件处于失败态");
    failed += 1;
  }

  return { promoted, failed };
}

/**
 * 发票采纳路由的崩溃恢复（fencing + 宽限）。
 *
 * 关键防竞态：只接管"过期"的 PROCESSING route（updatedAt 早于 PROCESSING_GRACE_MS），
 * 不抢占正活跃 worker 刚 markRouteTargetBound 但尚未建 staging 的 route。否则恢复会把活跃
 * PROCESSING 标 FAILED 清键，worker 随后建 staging 又丢失 route → 产生重复。
 *
 * 扫描规则（targetType=INVOICE_STAGING）：
 *  - PENDING 且无 targetId：采纳在创建 route 后、绑 targetId 前崩溃 → 宽限后标 FAILED 清键；
 *  - PROCESSING 且 targetId 指向"文件已就绪"的有效 staging → CAS 标 PROMOTED（复用）；
 *  - PROCESSING 但 targetId 缺失/过期/PENDING_FILE（文件未落盘）→ 宽限后标 FAILED 清键。
 *  - 未过宽限的活跃 route：跳过，留给 worker 继续推进。
 */
const INVOICE_ROUTE_PROCESSING_GRACE_MS = 5 * 60 * 1000; // 5 分钟：worker 文件写入与 staging 建表的合理上限

export async function resumePendingInvoiceRoutes(limit = 50): Promise<{
  promoted: number;
  failed: number;
}> {
  const now = Date.now();
  const graceCutoff = new Date(now - INVOICE_ROUTE_PROCESSING_GRACE_MS);
  const routes = await prisma.agentAttachmentRoute.findMany({
    where: {
      state: { in: ["PENDING", "PROCESSING"] },
      targetType: "INVOICE_STAGING",
    },
    take: limit,
    select: { id: true, targetId: true, activeRouteKey: true, state: true, updatedAt: true },
  });

  let promoted = 0;
  let failed = 0;

  for (const route of routes) {
    // 活跃 worker 的 route（updatedAt 在宽限内）不接管，避免抢占正在进行的采纳。
    if (route.updatedAt.getTime() > graceCutoff.getTime()) continue;

    if (!route.targetId) {
      // markRouteTargetBound 前崩溃：无可恢复目标，CAS 标 FAILED 并清互斥键。
      const r = await prisma.agentAttachmentRoute.updateMany({
        where: { id: route.id, state: { in: ["PENDING", "PROCESSING"] } },
        data: { state: "FAILED", error: "发票 staging 创建前中断", activeRouteKey: null },
      });
      if (r.count === 1) failed += 1;
      continue;
    }

    const invoice = await prisma.agentInvoiceStagingFile.findUnique({
      where: { id: route.targetId },
      select: { id: true, status: true, expiresAt: true },
    });
    // 仅当 staging 存在、未过期、且文件已落盘（非 PENDING_FILE）才 PROMOTED。
    const ready = invoice
      && invoice.status !== "EXPIRED"
      && invoice.status !== "PENDING_FILE"
      && invoice.expiresAt.getTime() > now;
    if (ready) {
      // CAS 标 PROMOTED（复用已有 invoice staging）；含 state 条件防覆盖活跃 worker。
      const r = await prisma.agentAttachmentRoute.updateMany({
        where: { id: route.id, state: { in: ["PENDING", "PROCESSING"] } },
        data: { state: "PROMOTED", targetId: invoice!.id },
      });
      if (r.count === 1) promoted += 1;
    } else {
      // 目标缺失/过期/PENDING_FILE（文件未落盘）：宽限后标 FAILED 并清互斥键，允许重新采纳。
      const reason = !invoice ? "发票 staging 缺失"
        : invoice.status === "PENDING_FILE" ? "发票 staging 文件未落盘"
        : "发票 staging 过期";
      const r = await prisma.agentAttachmentRoute.updateMany({
        where: { id: route.id, state: { in: ["PENDING", "PROCESSING"] } },
        data: { state: "FAILED", error: reason, activeRouteKey: null },
      });
      if (r.count === 1) failed += 1;
    }
  }

  return { promoted, failed };
}

/**
 * CrmVisitCheckin DRAFT 孤儿回收（GC）。
 *
 * 背景（P0-4）：Agent channel 的 prepare_visit_checkin 与 Web 路径都会先持久化
 * 一条 status='DRAFT' 的 CrmVisitCheckin 作为 intent 锚点（"我要在这家客户做签到"），
 * 用户随后调用 completeVisitCheckin（提交定位/照片/录音证据）把它原子转成 COMPLETED
 * 并落 VISIT interaction + 触发 lifecycle stage。
 *
 * 用户中途放弃 → DRAFT 行残留，无 GC。本模块按「48h 仍未提交证据」判定为孤儿，
 * 直接物理删除。
 *
 * 可见性（决定删除而非标记）：
 *  - 业务事实/时间线（representative-ops-facts / checkin-event-time /
 *    representative-communication-events）一律 `status='COMPLETED'` 过滤——
 *    DRAFT 对它们不可见；
 *  - VISIT interaction 只在 completeVisitCheckin 内创建——DRAFT 从未派生 interaction，
 *    不进入客户时间线；
 *  - lifecycle stage 仅在 completeVisitCheckin 内 transition——DRAFT 不影响客户阶段。
 *  唯一暴露 DRAFT 的入口是 `GET /api/crm/profiles/[id]/checkins`（签到列表未按 status 过滤），
 *  但 DRAFT 行无 media / 无 completedAt / 无 interactionId，48h 过期后即废弃意图，
 *  对审计与业务均无价值——删除安全。
 *
 * 调用：挂入 runAllReminders 的 Promise.all（safe 兜底）。
 */
import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/** DRAFT 超过该时长未完成即视为孤儿。 */
export const CHECKIN_DRAFT_SWEEP_AGE_MS = 48 * 60 * 60 * 1000;
/** 单轮回收上限，避免单次 cron 长事务 / 大量删除。 */
export const CHECKIN_DRAFT_SWEEP_BATCH_LIMIT = 200;

export interface CheckinDraftSweepOptions {
  /** 测试可注入时钟与上限。 */
  now?: Date;
  batchLimit?: number;
  /** 测试可注入 db（默认单例 prisma）。 */
  db?: PrismaClient;
}

export interface CheckinDraftSweepResult {
  /** 本轮删除的 DRAFT 行数。 */
  swept: number;
}

/**
 * 删除 status='DRAFT' 且 createdAt < now - 48h 的 CrmVisitCheckin 行，单轮最多 batchLimit 条。
 *
 * 实现：
 *  - 先 findMany 选 id（LIMIT 上限）——避免无界 DELETE；
 *  - 再 deleteMany by id IN(...) + status='DRAFT' 双校验——防止 findMany 与 delete 之间
 *    被并发 completeVisitCheckin 转成 COMPLETED 的行被误删（虽然 completeVisitCheckin
 *    原子改 status，findMany 已经过滤，这里再加一层 status 守卫）。
 *
 * Cascade：CrmVisitMedia.onDelete=Cascade，故 DRAFT 的 media（若有上传）一并清理。
 */
export async function sweepStaleCheckinDrafts(
  opts: CheckinDraftSweepOptions = {},
): Promise<CheckinDraftSweepResult> {
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - CHECKIN_DRAFT_SWEEP_AGE_MS);
  const batchLimit = opts.batchLimit ?? CHECKIN_DRAFT_SWEEP_BATCH_LIMIT;

  const stale = await db.crmVisitCheckin.findMany({
    where: {
      status: "DRAFT",
      createdAt: { lt: cutoff },
    },
    select: { id: true },
    take: batchLimit,
  });

  if (stale.length === 0) {
    return { swept: 0 };
  }

  const ids = stale.map((r) => r.id);
  const deleted = await db.crmVisitCheckin.deleteMany({
    where: {
      id: { in: ids },
      // 双校验：findMany 之后到 deleteMany 之间，若并发 completeVisitCheckin 已将其改为
      // COMPLETED（status 守卫会使其不匹配），则不会被误删。
      status: "DRAFT",
    },
  });

  if (deleted.count > 0) {
    console.log(
      `[REMINDER][CHECKIN_DRAFT_SWEEP] Swept ${deleted.count} stale DRAFT CrmVisitCheckin rows (cutoff=${cutoff.toISOString()})`,
    );
  }

  return { swept: deleted.count };
}

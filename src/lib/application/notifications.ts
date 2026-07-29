/**
 * Notification canonical service（T9.1a）。
 *
 * 正式业务模型 Notification 的写入入口。Agent proactive-tasks 原在自身事务内
 * 直连 tx.notification.create（indirect Agent consumer 触碰业务模型），现统一走本服务。
 * 仓库内其余约 15 处散落直连（business-email/notify、reminder、crm/supervisor、
 * representative-link、tickets/reply 等）后续可逐步收敛到此。
 */
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";

export type CreateNotificationInput = {
  userId: string;
  title: string;
  content: string;
  /** 默认 SYSTEM；proactive 提醒传 AGENT_PROACTIVE。 */
  type?: string;
  link?: string | null;
  /** 幂等去重键（唯一约束）；同一 key 重复创建由调用方按 P2002 处理。 */
  dedupeKey?: string | null;
};

/**
 * 事务内创建通知：tx 由调用方持有，与调用方其他写入同事务原子提交
 * （如 proactive-tasks 的「通知 + 任务置 SENT」同事务）。
 */
export async function createNotificationInTx(tx: Prisma.TransactionClient, input: CreateNotificationInput) {
  return tx.notification.create({
    data: {
      userId: input.userId,
      title: input.title,
      content: input.content,
      type: input.type ?? "SYSTEM",
      link: input.link ?? null,
      dedupeKey: input.dedupeKey ?? null,
    },
  });
}

/** 独立创建通知（不进调用方事务）。 */
export async function createNotification(input: CreateNotificationInput) {
  return createNotificationInTx(prisma, input);
}

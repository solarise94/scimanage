/**
 * 商务邮件通知 — cron 扫描（合并进 runAllReminders）
 * 见 docs/business-email-notification-design-2026-06-26.md §6.1 / §6.2 / §6.3
 *   及 docs/order-rep-notify-email-design-2026-07-26.md §6.1 / §6.2（H 下单代表通知）
 *
 * 四个扫描：
 *  - checkAndSendMilestoneReminders：邮件 A（到期前提醒，项目成员）+ B（逾期催办，外部部门）
 *  - checkArchiveReadyProjects：可归档站内提醒（项目 owner）
 *  - checkOverdueInvoiceNudges：邮件 F2（发票超期催办，财务部）
 *  - checkOrderRepNotifications：邮件 H（下单代表通知，Representative，按代表聚合分片）
 *
 * 锁机结构对标 src/lib/reminder.ts（PENDING/PROCESSING + 行级锁 + recoverStuck）。
 */
import { prisma } from "@/lib/prisma";
import {
  AUTO_NUDGE_DEDUP_MS,
  STUCK_LOCK_MS,
  SCAN_BATCH_LIMIT,
  INVOICE_OVERDUE_MS,
  INVOICE_OVERDUE_NUDGE_INTERVAL_MS,
  ARCHIVE_READY_ORDER_STATUSES,
  BUSINESS_EMAIL_TYPE,
  ORDER_REP_NOTIFY_MAX_ATTEMPTS,
  ORDER_REP_NOTIFY_CHUNK_SIZE,
} from "./constants";
import {
  buildMilestoneDueSoonEmail,
  buildInvoiceOverdueEmail,
  buildOrderRepNotifyEmail,
  type OrderRepNotifyOrder,
} from "./templates";
import {
  sendMilestoneNudge,
  sendExternalEmail,
  sendExternalEmailWithLogs,
  deliverMemberNotification,
} from "./notify";
import { resolveFinanceRecipients } from "./recipients";

/** Prisma 唯一约束冲突判定（P2002）。 */
function isP2002(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    "code" in e &&
    (e as { code: string }).code === "P2002"
  );
}

// ════════════════════════════════════════════════════════════════════════════
// §6.1 节点到期/逾期扫描（邮件 A + B）
// ════════════════════════════════════════════════════════════════════════════

async function recoverStuckMilestones(): Promise<number> {
  const cutoff = Date.now() - STUCK_LOCK_MS;
  const recovered = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
    `UPDATE Milestone
       SET nudgeStatus = 'PENDING',
           nudgeLockedAt = NULL,
           nudgeError = 'Recovered from stuck PROCESSING'
     WHERE nudgeStatus = 'PROCESSING'
       AND nudgeLockedAt IS NOT NULL
       AND nudgeLockedAt <= ?
     RETURNING id`,
    cutoff,
  );
  if (recovered.length > 0) {
    console.log(`[BIZ_EMAIL][MILESTONE] Recovered ${recovered.length} stuck PROCESSING`);
  }
  return recovered.length;
}

/** 锁定需要处理的节点：逾期(dueDate<=now) 或 到期前窗口(notifyBeforeHours 内、未逾期)。 */
async function lockMilestoneCandidates(nowMs: number, limit: number): Promise<string[]> {
  const cond = `dueDate IS NOT NULL
       AND doneAt IS NULL
       AND nudgeStatus IN ('PENDING','FAILED')
       AND (
         dueDate <= ?
         OR (notifyBeforeHours IS NOT NULL
             AND (dueDate - notifyBeforeHours * 3600000) <= ?
             AND dueDate > ?)
       )`;
  const locked = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
    `UPDATE Milestone
       SET nudgeStatus = 'PROCESSING', nudgeLockedAt = ?
     WHERE ${cond}
       AND id IN (SELECT id FROM Milestone WHERE ${cond} LIMIT ${limit})
     RETURNING id`,
    nowMs, // SET nudgeLockedAt
    nowMs, nowMs, nowMs, // outer WHERE
    nowMs, nowMs, nowMs, // inner subquery WHERE
  );
  return locked.map((r) => r.id);
}

export async function checkAndSendMilestoneReminders() {
  const nowMs = Date.now();
  await recoverStuckMilestones();

  const lockedIds = await lockMilestoneCandidates(nowMs, SCAN_BATCH_LIMIT);
  if (lockedIds.length === 0) {
    return { dueSoon: 0, nudged: 0, failed: 0 };
  }

  const milestones = await prisma.milestone.findMany({
    where: { id: { in: lockedIds } },
    include: {
      project: {
        select: {
          id: true,
          name: true,
          members: {
            select: {
              user: {
                select: { id: true, email: true, name: true, emailOnReminder: true },
              },
            },
          },
        },
      },
    },
  });

  let dueSoon = 0;
  let nudged = 0;
  let failed = 0;

  for (const m of milestones) {
    try {
      const due = m.dueDate;
      if (!due) {
        await prisma.milestone.update({
          where: { id: m.id },
          data: { nudgeStatus: "PENDING", nudgeLockedAt: null },
        });
        continue;
      }

      if (due.getTime() <= nowMs) {
        // ── 邮件 B：逾期自动催办（24h 去重，基于 nudgeLastSentAt） ──
        const lastSent = m.nudgeLastSentAt?.getTime() ?? 0;
        if (nowMs - lastSent > AUTO_NUDGE_DEDUP_MS) {
          const res = await sendMilestoneNudge({
            milestoneId: m.id,
            projectId: m.project.id,
            projectName: m.project.name,
            milestoneName: m.name,
            dueDate: due,
            manual: false,
          });
          // 无论本次是否有收件人都推进 nudgeLastSentAt：零收件人（全部静默/未配置）
          // 时若不推进，会被每轮 cron 反复重锁重扫，永不收敛。按 24h 节流后下轮再试。
          await prisma.milestone.update({
            where: { id: m.id },
            data: { nudgeLastSentAt: new Date(), nudgeError: null },
          });
          if (res.recipients > 0) nudged++;
        }
      } else {
        // ── 邮件 A：到期前提醒（项目成员，dedupeKey 去重） ──
        const email = buildMilestoneDueSoonEmail({
          projectId: m.project.id,
          projectName: m.project.name,
          milestoneName: m.name,
          dueDate: due,
        });
        const seen = new Set<string>();
        for (const pm of m.project.members) {
          const u = pm.user;
          if (!u || seen.has(u.id)) continue;
          seen.add(u.id);
          // 单成员失败隔离：一个成员的非 P2002 异常不应中断其余成员通知
          try {
            await deliverMemberNotification({
              userId: u.id,
              title: `项目节点即将到期: ${m.name}`,
              content: `项目「${m.project.name}」的节点「${m.name}」即将到期，请关注。`,
              type: BUSINESS_EMAIL_TYPE.MILESTONE_DUE_SOON,
              link: `/projects/${m.project.id}`,
              dedupeKey: `milestone-due-soon:${m.id}:${due.getTime()}:${u.id}`,
              recipient: { id: u.id, email: u.email, emailEnabled: u.emailOnReminder },
              email,
            });
          } catch (e) {
            console.error(
              `[BIZ_EMAIL][MILESTONE_DUE_SOON] member ${u.id} failed for ${m.id}:`,
              e instanceof Error ? e.message : e,
            );
          }
        }
        dueSoon++;
      }

      // 处理完毕，重置为 PENDING（节点级去重交给 dedupeKey / nudgeLastSentAt）
      await prisma.milestone.update({
        where: { id: m.id },
        data: { nudgeStatus: "PENDING", nudgeLockedAt: null },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "未知错误";
      console.error(`[BIZ_EMAIL][MILESTONE] Failed for ${m.id}:`, msg);
      await prisma.milestone
        .update({
          where: { id: m.id },
          data: { nudgeStatus: "FAILED", nudgeError: msg.slice(0, 500) },
        })
        .catch(() => {});
      failed++;
    }
  }

  console.log(`[BIZ_EMAIL][MILESTONE] Scan: dueSoon=${dueSoon} nudged=${nudged} failed=${failed}`);
  return { dueSoon, nudged, failed };
}

// ════════════════════════════════════════════════════════════════════════════
// §6.2 归档就绪扫描（可归档站内提醒）
// ════════════════════════════════════════════════════════════════════════════

export async function checkArchiveReadyProjects() {
  // 候选：未归档、未删除、尚无可归档记录、且至少关联 1 个订单
  const candidates = await prisma.project.findMany({
    where: {
      archived: false,
      deleted: false,
      archiveNotice: { is: null },
      orderLinks: { some: {} },
    },
    select: {
      id: true,
      name: true,
      orderLinks: { select: { orderId: true } },
      members: {
        where: { role: "OWNER" },
        select: { user: { select: { id: true, name: true } } },
      },
    },
  });

  let ready = 0;
  let failed = 0;

  for (const project of candidates) {
    try {
      const orderIds = project.orderLinks.map((l) => l.orderId);
      if (orderIds.length === 0) continue;

      // ── 订单态：全部 CLOSED / DELIVERED ──
      const orders = await prisma.order.findMany({
        where: { id: { in: orderIds } },
        select: { id: true, status: true },
      });
      const ordersOk =
        orders.length > 0 &&
        orders.every((o) =>
          (ARCHIVE_READY_ORDER_STATUSES as readonly string[]).includes(o.status),
        );
      if (!ordersOk) continue;

      // ── 发票态：项目关联订单的发票申请全部 ISSUED（≥1 张）。
      //    ProjectInvoice 不参与（§4.1）。直连 orderId + OrderInvoiceCoverage 两路合并去重。──
      const invoices = await prisma.externalOrderInvoiceRequest.findMany({
        where: {
          OR: [
            { orderId: { in: orderIds } },
            { orderCoverage: { some: { orderId: { in: orderIds } } } },
          ],
        },
        select: { id: true, status: true },
      });
      const invoicesOk =
        invoices.length > 0 && invoices.every((inv) => inv.status === "ISSUED");
      if (!invoicesOk) continue;

      // ── 合同态：有关联合同的，状态须 GENERATED；没有合同不阻塞 ──
      const contracts = await prisma.contractDocument.findMany({
        where: { orderCoverage: { some: { orderId: { in: orderIds } } } },
        select: { id: true, status: true },
      });
      const contractsOk = contracts.every((c) => c.status === "GENERATED");
      if (!contractsOk) continue;

      // ── 三态全齐：原子创建去重记录 + 通知所有 owner ──
      //   notice 与通知放进同一事务：若中途崩溃/失败则整体回滚，避免出现
      //   「已建 ProjectArchiveNotice（项目从此不再被扫描）但 owner 从未收到通知」
      //   的悬挂状态。banner 仍以 archiveNotice 存在为准，事务保证两者同生共死。
      const ownerUserIds = Array.from(
        new Set(
          project.members
            .map((om) => om.user?.id)
            .filter((x): x is string => !!x),
        ),
      );
      try {
        await prisma.$transaction(async (tx) => {
          await tx.projectArchiveNotice.create({ data: { projectId: project.id } });
          for (const uid of ownerUserIds) {
            try {
              await tx.notification.create({
                data: {
                  userId: uid,
                  title: `项目可归档: ${project.name}`,
                  content: `项目「${project.name}」的合同 / 发票 / 订单三态已全齐，可前往项目页归档。`,
                  type: BUSINESS_EMAIL_TYPE.ARCHIVE_READY,
                  link: `/projects/${project.id}`,
                  dedupeKey: `archive-ready:${project.id}:${uid}`,
                },
              });
            } catch (e) {
              // 同一 user 已有该项目可归档通知 → P2002 忽略；其它错误回滚整个事务
              if (!isP2002(e)) throw e;
            }
          }
        });
      } catch (e) {
        // ProjectArchiveNotice 的 P2002：并发扫描已创建，跳过该项目
        if (isP2002(e)) continue;
        throw e;
      }
      ready++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "未知错误";
      console.error(`[BIZ_EMAIL][ARCHIVE_READY] Failed for ${project.id}:`, msg);
      failed++;
    }
  }

  console.log(`[BIZ_EMAIL][ARCHIVE_READY] Scan: ready=${ready} failed=${failed}`);
  return { ready, failed };
}

// ════════════════════════════════════════════════════════════════════════════
// §6.3 发票超期催办扫描（邮件 F2）
// ════════════════════════════════════════════════════════════════════════════

async function recoverStuckInvoiceNudges(): Promise<number> {
  const cutoff = Date.now() - STUCK_LOCK_MS;
  const recovered = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
    `UPDATE ExternalOrderInvoiceRequest
       SET overdueNudgeStatus = 'PENDING',
           overdueNudgeLockedAt = NULL,
           overdueNudgeError = 'Recovered from stuck PROCESSING'
     WHERE overdueNudgeStatus = 'PROCESSING'
       AND overdueNudgeLockedAt IS NOT NULL
       AND overdueNudgeLockedAt <= ?
     RETURNING id`,
    cutoff,
  );
  if (recovered.length > 0) {
    console.log(`[BIZ_EMAIL][INVOICE_OVERDUE] Recovered ${recovered.length} stuck PROCESSING`);
  }
  return recovered.length;
}

async function lockInvoiceNudgeCandidates(nowMs: number, limit: number): Promise<string[]> {
  const overdueCutoff = nowMs - INVOICE_OVERDUE_MS;
  const intervalCutoff = nowMs - INVOICE_OVERDUE_NUDGE_INTERVAL_MS;
  const cond = `status = 'REQUESTED'
       AND createdAt <= ?
       AND overdueNudgeStatus IN ('PENDING','FAILED')
       AND (overdueNudgeLastSentAt IS NULL OR overdueNudgeLastSentAt <= ?)`;
  const locked = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
    `UPDATE ExternalOrderInvoiceRequest
       SET overdueNudgeStatus = 'PROCESSING', overdueNudgeLockedAt = ?
     WHERE ${cond}
       AND id IN (SELECT id FROM ExternalOrderInvoiceRequest WHERE ${cond} LIMIT ${limit})
     RETURNING id`,
    nowMs, // SET overdueNudgeLockedAt
    overdueCutoff, intervalCutoff, // outer WHERE
    overdueCutoff, intervalCutoff, // inner subquery WHERE
  );
  return locked.map((r) => r.id);
}

export async function checkOverdueInvoiceNudges() {
  const nowMs = Date.now();
  await recoverStuckInvoiceNudges();

  const lockedIds = await lockInvoiceNudgeCandidates(nowMs, SCAN_BATCH_LIMIT);
  if (lockedIds.length === 0) {
    return { nudged: 0, failed: 0 };
  }

  // 财务部收件人解析一次；缺失则释放锁并推进 overdueNudgeLastSentAt，
  // 否则同一批发票会被每轮 cron 反复重锁重扫（lockCandidates 条件含
  // overdueNudgeLastSentAt IS NULL OR <= intervalCutoff），永不收敛。
  const recipients = await resolveFinanceRecipients();
  if (recipients.length === 0) {
    console.warn("[BIZ_EMAIL][INVOICE_OVERDUE] no FINANCE recipient; throttling locks");
    await prisma.externalOrderInvoiceRequest.updateMany({
      where: { id: { in: lockedIds } },
      data: {
        overdueNudgeStatus: "PENDING",
        overdueNudgeLockedAt: null,
        overdueNudgeLastSentAt: new Date(),
      },
    });
    return { nudged: 0, failed: 0 };
  }

  const invoices = await prisma.externalOrderInvoiceRequest.findMany({
    where: { id: { in: lockedIds } },
    select: {
      id: true,
      buyerOrganizationName: true,
      totalAmount: true,
      createdAt: true,
    },
  });

  let nudged = 0;
  let failed = 0;

  for (const inv of invoices) {
    try {
      const overdueDays = Math.floor((nowMs - inv.createdAt.getTime()) / 86400000);
      const email = buildInvoiceOverdueEmail({
        invoiceId: inv.id,
        buyerName: inv.buyerOrganizationName,
        totalAmountCents: inv.totalAmount,
        requestedAt: inv.createdAt,
        overdueDays,
      });
      await sendExternalEmail(recipients, email, {
        type: BUSINESS_EMAIL_TYPE.INVOICE_OVERDUE_NUDGE,
        invoiceId: inv.id,
      });
      // 重置 PENDING（下一轮间隔到了才会再锁），记录已催办时间
      await prisma.externalOrderInvoiceRequest.update({
        where: { id: inv.id },
        data: {
          overdueNudgeStatus: "PENDING",
          overdueNudgeLockedAt: null,
          overdueNudgeLastSentAt: new Date(),
          overdueNudgeSent: true,
          overdueNudgeError: null,
        },
      });
      nudged++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "未知错误";
      console.error(`[BIZ_EMAIL][INVOICE_OVERDUE] Failed for ${inv.id}:`, msg);
      await prisma.externalOrderInvoiceRequest
        .update({
          where: { id: inv.id },
          data: { overdueNudgeStatus: "FAILED", overdueNudgeError: msg.slice(0, 500) },
        })
        .catch(() => {});
      failed++;
    }
  }

  console.log(`[BIZ_EMAIL][INVOICE_OVERDUE] Scan: nudged=${nudged} failed=${failed}`);
  return { nudged, failed };
}

// ════════════════════════════════════════════════════════════════════════════
// §6.1/§6.2 H 下单代表通知扫描（邮件 H，按代表聚合 + 50 单分片）
// 见 docs/order-rep-notify-email-design-2026-07-26.md §6.2 六步
// ════════════════════════════════════════════════════════════════════════════

/** 通知资格排除名单（source）：见设计 §5.4。 */
const ORDER_REP_NOTIFY_EXCLUDED_SOURCES = ["ACCRUAL_REVERSAL", "CONTRACT_LEDGER"] as const;

/** 将数组按 size 切片（分片发送用）。 */
function chunkBy<T>(arr: T[], size: number): T[][] {
  if (size <= 0) return [arr];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

export async function checkOrderRepNotifications(): Promise<{
  notified: number;
  skipped: number;
  failed: number;
  writebackFailed: number;
}> {
  const nowMs = Date.now();
  const excludedSrcList = ORDER_REP_NOTIFY_EXCLUDED_SOURCES.map((s) => `'${s}'`).join(",");
  let notified = 0;
  let skipped = 0;
  let failed = 0;
  let writebackFailed = 0;

  // ── 第 0 步：批量终结（不占发送批次） ──────────────────────────────────────
  // 0a. 删除/归档订单终结：这些订单不匹配第 2 步锁条件，不批量终结会永久滞留 PENDING。
  const finalizeDeleted = await prisma.order.updateMany({
    where: {
      repNotifyStatus: { in: ["PENDING", "FAILED"] },
      OR: [{ deleted: true }, { archived: true }],
    },
    data: {
      repNotifyStatus: "SKIPPED",
      repNotifyLockedAt: null,
      repNotifyError: "Order deleted or archived",
    },
  });
  skipped += finalizeDeleted.count;

  // 0b. 非业务 source 兜底终结（防创建点遗漏 / 历史数据双保险）。
  const finalizeNonBusiness = await prisma.order.updateMany({
    where: {
      repNotifyStatus: { in: ["PENDING", "FAILED"] },
      source: { in: [...ORDER_REP_NOTIFY_EXCLUDED_SOURCES] },
    },
    data: {
      repNotifyStatus: "SKIPPED",
      repNotifyLockedAt: null,
      repNotifyError: "Non-business source",
    },
  });
  skipped += finalizeNonBusiness.count;

  // ── 第 1 步：recoverStuck（PROCESSING 超 STUCK_LOCK_MS → FAILED，attempts 保留） ──
  // 注：卡死时 attempts 已在锁定时 +1；回收为 FAILED 后若 attempts>=3 自然不再被锁，
  // 卡死消耗的尝试不会绕过三次上限（设计 §4.1）。
  const stuckCutoff = nowMs - STUCK_LOCK_MS;
  const recoveredStuck = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
    `UPDATE "Order"
       SET repNotifyStatus = 'FAILED',
           repNotifyLockedAt = NULL,
           repNotifyError = 'stuck lock recovered'
     WHERE repNotifyStatus = 'PROCESSING'
       AND repNotifyLockedAt IS NOT NULL
       AND repNotifyLockedAt <= ?
     RETURNING id`,
    stuckCutoff,
  );
  if (recoveredStuck.length > 0) {
    console.log(`[BIZ_EMAIL][ORDER_REP] Recovered ${recoveredStuck.length} stuck PROCESSING`);
  }

  // ── 第 2 步：行级锁（UPDATE ... RETURNING id，SCAN_BATCH_LIMIT=200） ────────
  // SQLite: deleted/archived 为 Boolean（0/1）。资格：默认通知 + 显式排除名单（§5.4）。
  const cond = `representativeId IS NOT NULL
       AND deleted = 0 AND archived = 0
       AND source NOT IN (${excludedSrcList})
       AND repNotifyStatus IN ('PENDING', 'FAILED')
       AND repNotifyAttempts < ${ORDER_REP_NOTIFY_MAX_ATTEMPTS}`;
  const locked = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
    `UPDATE "Order"
       SET repNotifyStatus = 'PROCESSING',
           repNotifyLockedAt = ?,
           repNotifyAttempts = repNotifyAttempts + 1
     WHERE ${cond}
       AND id IN (SELECT id FROM "Order" WHERE ${cond} LIMIT ${SCAN_BATCH_LIMIT})
     RETURNING id`,
    nowMs,
  );
  const lockedIds = locked.map((r) => r.id);
  if (lockedIds.length === 0) {
    console.log(`[BIZ_EMAIL][ORDER_REP] Scan: notified=0 skipped=${skipped} failed=0`);
    return { notified, skipped, failed, writebackFailed };
  }

  // 本轮锁令牌：第 2 步行级锁把 repNotifyLockedAt 置为 nowMs。所有回写（SKIPPED/SENT/FAILED）
  // 的 CAS 条件必须同时包含 repNotifyStatus='PROCESSING' AND repNotifyLockedAt=lockToken——
  // 只查 PROCESSING 无法区分「本轮锁」与「卡死回收后另一轮重新取得的锁」（SMTP 超 10 分钟时
  // 旧 worker 可能覆盖新 worker 的结果）。count 不符即未回写：计入 writebackFailed，
  // 绝不计入 notified/failed/skipped（避免不可观测的重复邮件）。
  const lockToken = new Date(nowMs);
  const casWriteback = async (
    ids: string[],
    data: Record<string, unknown>,
    label: string,
  ): Promise<number> => {
    try {
      const wb = await prisma.order.updateMany({
        where: { id: { in: ids }, repNotifyStatus: "PROCESSING", repNotifyLockedAt: lockToken },
        data,
      });
      if (wb.count !== ids.length) {
        console.error(
          `[BIZ_EMAIL][ORDER_REP] ${label} writeback partial: expected=${ids.length} updated=${wb.count}`,
        );
      }
      return wb.count;
    } catch (err) {
      console.error(
        `[BIZ_EMAIL][ORDER_REP] ${label} writeback threw: ids=${ids.length}`,
        err instanceof Error ? err.message : err,
      );
      return 0;
    }
  };

  // ── 第 3 步：加载订单 + 代表（含生命周期复验字段 deleted/archived/source + rep archived/kind） ──
  const orders = await prisma.order.findMany({
    where: { id: { in: lockedIds } },
    select: {
      id: true,
      orderNo: true,
      title: true,
      buyerOrgNameSnapshot: true,
      totalAmount: true,
      status: true,
      createdAt: true,
      representativeId: true,
      deleted: true,
      archived: true,
      source: true,
      createdBy: { select: { name: true } },
      representative: { select: { id: true, name: true, email: true, archived: true, kind: true } },
    },
  });

  // ── 第 4 步：发送前复验（TOCTOU 收敛）——锁定与加载之间存在窗口 ────────────────
  type LoadedOrder = (typeof orders)[number];
  const toNotify: LoadedOrder[] = [];
  for (const o of orders) {
    if (o.deleted || o.archived) {
      const done = await casWriteback(
        [o.id],
        { repNotifyStatus: "SKIPPED", repNotifyLockedAt: null, repNotifyError: "Order deleted or archived" },
        "SKIPPED(deleted/archived)",
      );
      if (done === 1) skipped++;
      else writebackFailed++;
      continue;
    }
    if ((ORDER_REP_NOTIFY_EXCLUDED_SOURCES as readonly string[]).includes(o.source)) {
      const done = await casWriteback(
        [o.id],
        { repNotifyStatus: "SKIPPED", repNotifyLockedAt: null, repNotifyError: "Non-business source" },
        "SKIPPED(non-business source)",
      );
      if (done === 1) skipped++;
      else writebackFailed++;
      continue;
    }
    const rep = o.representative;
    if (!rep || rep.archived || rep.kind === "SYSTEM") {
      // 无代表理论不应出现（锁条件 representativeId IS NOT NULL），此处为防御；
      // 代表归档 / 系统代表 → SKIPPED（终态，§5.5）。
      const done = await casWriteback(
        [o.id],
        {
          repNotifyStatus: "SKIPPED",
          repNotifyLockedAt: null,
          repNotifyError: rep ? (rep.archived ? "Representative archived" : "System representative") : "No representative",
        },
        "SKIPPED(rep invalid)",
      );
      if (done === 1) skipped++;
      else writebackFailed++;
      continue;
    }
    toNotify.push(o);
  }

  // ── 第 5 步：按 representativeId 分组，50 单分片发送，检查返回值判定成败 ──────
  // sendExternalEmailWithLogs 吞异常、只返回计数；绝不能 try/catch 判成败（设计 §6.2 第 5 步）。
  const byRep = new Map<string, LoadedOrder[]>();
  for (const o of toNotify) {
    const rid = o.representativeId!;
    const arr = byRep.get(rid);
    if (arr) arr.push(o);
    else byRep.set(rid, [o]);
  }

  for (const [, group] of byRep) {
    const rep = group[0].representative!;
    const chunks = chunkBy(group, ORDER_REP_NOTIFY_CHUNK_SIZE);
    for (const [i, chunk] of chunks.entries()) {
      const orderInputs: OrderRepNotifyOrder[] = chunk.map((o) => ({
        id: o.id,
        orderNo: o.orderNo,
        title: o.title,
        buyerOrgNameSnapshot: o.buyerOrgNameSnapshot,
        totalAmount: o.totalAmount,
        status: o.status,
        createdAt: o.createdAt,
        creatorName: o.createdBy?.name ?? null,
      }));
      const email = buildOrderRepNotifyEmail({
        repName: rep.name,
        orders: orderInputs,
        batch: chunks.length > 1 ? { index: i + 1, total: chunks.length, totalOrders: group.length } : null,
      });
      const result = await sendExternalEmailWithLogs({
        recipient: { contactId: rep.id, email: rep.email, name: rep.name, ccEmails: [] },
        email,
        logContexts: chunk.map((o) => ({
          type: BUSINESS_EMAIL_TYPE.ORDER_REP_NOTIFIED,
          orderId: o.id,
          representativeId: rep.id,
        })),
      });

      if (result.sent === 1 && result.failed === 0) {
        // 仅本片订单置 SENT + repNotifySentAt=now + 清 error（§6.2 第 5 步）。
        // CAS 含本轮锁令牌（PROCESSING + repNotifyLockedAt=lockToken）：卡死回收后另一轮
        // 重新取得锁时，本轮（旧 worker）无法覆盖新 worker 的结果。
        // 只按实际回写行数计入 notified；未回写部分计 writebackFailed。
        const chunkIds = chunk.map((o) => o.id);
        const done = await casWriteback(
          chunkIds,
          { repNotifyStatus: "SENT", repNotifyLockedAt: null, repNotifySentAt: new Date(nowMs), repNotifyError: null },
          `SENT(repId=${rep.id})`,
        );
        notified += done;
        writebackFailed += chunkIds.length - done;
      } else {
        // 仅本片订单置 FAILED + repNotifyError = 真实 SMTP 错误（截断 500 字符）。
        // 同样 CAS 含本轮锁令牌。
        const errMsg = (result.error || "发送失败").slice(0, 500);
        const chunkIds = chunk.map((o) => o.id);
        const done = await casWriteback(
          chunkIds,
          { repNotifyStatus: "FAILED", repNotifyLockedAt: null, repNotifyError: errMsg },
          `FAILED(repId=${rep.id})`,
        );
        failed += done;
        writebackFailed += chunkIds.length - done;
      }
    }
  }

  // ── 第 6 步：结果回写与汇总 ─────────────────────────────────────────────────
  console.log(
    `[BIZ_EMAIL][ORDER_REP] Scan: notified=${notified} skipped=${skipped} failed=${failed} writebackFailed=${writebackFailed}`,
  );
  return { notified, skipped, failed, writebackFailed };
}

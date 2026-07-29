import { prisma } from "./prisma";
import { sendMailInBackground } from "./mail";
import {
  checkAndSendMilestoneReminders,
  checkArchiveReadyProjects,
  checkOverdueInvoiceNudges,
  checkOrderRepNotifications,
} from "./business-email/scans";
import { sweepStaleCheckinDrafts } from "./crm/application/checkin-draft-sweep";
import { resumeAttachmentMaintenance } from "./projects/application/project-attachments";

// ── Shared helpers ────────────────────────────────────────────────────────

/** Recover PROCESSING records stuck longer than 10 minutes. Returns count recovered. */
async function recoverStuckTicketReminders(): Promise<number> {
  const cutoff = new Date(Date.now() - 10 * 60 * 1000);
  const recovered = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
    `UPDATE Ticket
       SET reminderStatus = 'PENDING',
           reminderLockedAt = NULL,
           reminderError = 'Recovered from stuck PROCESSING'
     WHERE reminderStatus = 'PROCESSING'
       AND reminderLockedAt IS NOT NULL
       AND reminderLockedAt <= ?
     RETURNING id`,
    cutoff.getTime(),
  );
  if (recovered.length > 0) {
    console.log(`[REMINDER][TICKET] Recovered ${recovered.length} stuck PROCESSING records`);
  }
  return recovered.length;
}

async function recoverStuckCrmReminders(): Promise<number> {
  const cutoff = new Date(Date.now() - 10 * 60 * 1000);
  const recovered = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
    `UPDATE CrmFollowUpTask
       SET reminderStatus = 'PENDING',
           reminderLockedAt = NULL,
           reminderError = 'Recovered from stuck PROCESSING'
     WHERE reminderStatus = 'PROCESSING'
       AND reminderLockedAt IS NOT NULL
       AND reminderLockedAt <= ?
     RETURNING id`,
    cutoff.getTime(),
  );
  if (recovered.length > 0) {
    console.log(`[REMINDER][CRM] Recovered ${recovered.length} stuck PROCESSING records`);
  }
  return recovered.length;
}

/** Atomically lock up to `limit` PENDING/FAILED reminders → PROCESSING. */
async function lockTicketCandidates(nowMs: number, limit: number): Promise<string[]> {
  const locked = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
    `UPDATE Ticket
       SET reminderStatus = 'PROCESSING',
           reminderLockedAt = ?
     WHERE reminderDate IS NOT NULL
       AND reminderDate <= ?
       AND reminderStatus IN ('PENDING', 'FAILED')
       AND status != 'CLOSED'
       AND id IN (
         SELECT id FROM Ticket
         WHERE reminderDate IS NOT NULL
           AND reminderDate <= ?
           AND reminderStatus IN ('PENDING', 'FAILED')
           AND status != 'CLOSED'
         LIMIT ${limit}
       )
     RETURNING id`,
    nowMs, nowMs, nowMs,
  );
  return locked.map((r) => r.id);
}

async function lockCrmCandidates(nowMs: number, limit: number): Promise<string[]> {
  // CRM follow-ups remind when dueAt is within 30 min to give advance warning.
  const soonMs = nowMs + 30 * 60 * 1000;
  const locked = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
    `UPDATE CrmFollowUpTask
       SET reminderStatus = 'PROCESSING',
           reminderLockedAt = ?
     WHERE status = 'OPEN'
       AND dueAt <= ?
       AND reminderStatus IN ('PENDING', 'FAILED')
       AND id IN (
         SELECT id FROM CrmFollowUpTask
         WHERE status = 'OPEN'
           AND dueAt <= ?
           AND reminderStatus IN ('PENDING', 'FAILED')
         LIMIT ${limit}
       )
     RETURNING id`,
    nowMs, soonMs, soonMs,
  );
  return locked.map((r) => r.id);
}

/** Mark a single reminder as FAILED with a trimmed error message. */
async function markFailed(
  table: "ticket" | "crmFollowUpTask",
  id: string,
  err: unknown,
) {
  const msg = err instanceof Error ? err.message : "未知错误";
  const data = { reminderStatus: "FAILED" as const, reminderError: msg.slice(0, 500) };
  if (table === "ticket") {
    await prisma.ticket.update({ where: { id }, data }).catch((dbErr) => {
      console.error(`[REMINDER] markFailed(ticket ${id}) DB write failed:`, dbErr);
    });
  } else {
    await prisma.crmFollowUpTask.update({ where: { id }, data }).catch((dbErr) => {
      console.error(`[REMINDER] markFailed(crmFollowUpTask ${id}) DB write failed:`, dbErr);
    });
  }
}

interface EmailRecipient {
  id: string;
  email: string | null;
  name: string;
  emailOnReminder: boolean | null;
}

/**
 * Create a notification with dedupeKey.
 * Returns true if a new notification was created, false if one already exists.
 * On P2002 (duplicate), re-queues email if the existing notification is still "pending".
 */
async function deliverReminder(params: {
  userId: string;
  title: string;
  content: string;
  type: "REMINDER" | "CRM_FOLLOW_UP_REMINDER";
  link: string;
  dedupeKey: string;
  recipient: EmailRecipient;
  emailSubject: string;
  emailText: string;
  emailHtml: string;
}): Promise<boolean> {
  const shouldEmail = !!(params.recipient.email && params.recipient.emailOnReminder);

  try {
    const notification = await prisma.notification.create({
      data: {
        userId: params.userId,
        title: params.title,
        content: params.content,
        type: params.type,
        link: params.link,
        dedupeKey: params.dedupeKey,
        emailStatus: shouldEmail ? "pending" : null,
      },
    });

    if (shouldEmail) {
      sendMailInBackground({
        to: params.recipient.email!,
        subject: params.emailSubject,
        text: params.emailText,
        html: params.emailHtml,
      }, notification.id);
    }

    return true;
  } catch (e) {
    if (typeof e === "object" && e !== null && "code" in e && (e as { code: string }).code === "P2002") {
      // Notification already exists — re-queue email if it's still stuck in "pending"
      const existing = await prisma.notification.findUnique({
        where: { dedupeKey: params.dedupeKey },
        select: { id: true, emailStatus: true },
      });
      if (existing && existing.emailStatus === "pending" && shouldEmail) {
        sendMailInBackground({
          to: params.recipient.email!,
          subject: params.emailSubject,
          text: params.emailText,
          html: params.emailHtml,
        }, existing.id);
      }
      return false;
    }
    throw e;
  }
}

// ── Public exports ─────────────────────────────────────────────────────────

export async function checkAndSendReminders() {
  const nowMs = Date.now();

  await recoverStuckTicketReminders();

  const lockedIds = await lockTicketCandidates(nowMs, 200);
  if (lockedIds.length === 0) {
    console.log("[REMINDER][TICKET] No pending ticket reminders");
    return { processed: 0, failed: 0 };
  }

  const tickets = await prisma.ticket.findMany({
    where: { id: { in: lockedIds } },
    include: { project: { select: { name: true, id: true } } },
  });

  let processed = 0;
  let failed = 0;

  for (const ticket of tickets) {
    try {
      if (!ticket.createdBy) {
        await prisma.ticket.update({
          where: { id: ticket.id },
          data: { reminderStatus: "FAILED", reminderError: "Ticket has no createdBy" },
        });
        failed++;
        continue;
      }

      const creator = await prisma.user.findUnique({
        where: { id: ticket.createdBy },
        select: { id: true, email: true, name: true, emailOnReminder: true },
      });

      if (!creator?.id) {
        await prisma.ticket.update({
          where: { id: ticket.id },
          data: { reminderStatus: "FAILED", reminderError: `Creator user ${ticket.createdBy} not found` },
        });
        failed++;
        continue;
      }

      await deliverReminder({
        userId: creator.id,
        title: `工单提醒: ${ticket.title}`,
        content: `工单 "${ticket.title}"（项目: ${ticket.project.name}）即将到达提醒时间，请关注处理进度。`,
        type: "REMINDER",
        link: `/projects/${ticket.projectId}`,
        dedupeKey: `reminder:ticket:${ticket.id}:${ticket.reminderDate!.getTime()}`,
        recipient: creator,
        emailSubject: `[SciManage] 工单提醒: ${ticket.title}`,
        emailText: `您好，\n\n您创建的工单 "${ticket.title}"（项目: ${ticket.project.name}）即将到达提醒时间，请关注处理进度。\n\n---\nSciManage 科研项目管理平台`,
        emailHtml: `<div style="font-family: sans-serif; max-width: 500px; margin: 0 auto;">
  <h2 style="color: #2563eb;">SciManage 工单提醒</h2>
  <p>您好，</p>
  <p>您创建的工单 <strong>"${ticket.title}"</strong> 即将到达提醒时间。</p>
  <p>所属项目: <strong>${ticket.project.name}</strong></p>
  <p>请关注处理进度。</p>
  <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 24px 0;" />
  <p style="color: #64748b; font-size: 12px;">SciManage 科研项目管理平台</p>
</div>`,
      });

      await prisma.ticket.update({
        where: { id: ticket.id },
        data: { reminderStatus: "SENT", reminderSentAt: new Date(), reminderSent: true },
      });
      processed++;
    } catch (err) {
      console.error(`[REMINDER][TICKET] Failed for ticket ${ticket.id}:`, err instanceof Error ? err.message : "未知错误");
      await markFailed("ticket", ticket.id, err);
      failed++;
    }
  }

  console.log(`[REMINDER][TICKET] Scan complete: processed=${processed} failed=${failed}`);
  return { processed, failed };
}

export async function checkAndSendCrmFollowUpReminders() {
  const nowMs = Date.now();

  await recoverStuckCrmReminders();

  const lockedIds = await lockCrmCandidates(nowMs, 200);
  if (lockedIds.length === 0) {
    console.log("[REMINDER][CRM] No pending CRM follow-up reminders");
    return { processed: 0, failed: 0 };
  }

  const tasks = await prisma.crmFollowUpTask.findMany({
    where: { id: { in: lockedIds } },
    include: {
      ownerUser: { select: { id: true, name: true, email: true, emailOnReminder: true } },
      profile: { select: { name: true } },
    },
  });

  let processed = 0;
  let failed = 0;

  for (const task of tasks) {
    try {
      const user = task.ownerUser;
      const customerName = task.profile.name ?? "未命名客户";

      await deliverReminder({
        userId: user.id,
        title: `CRM 跟进提醒: ${task.title}`,
        content: `客户「${customerName}」的跟进任务「${task.title}」即将到期，请及时处理。`,
        type: "CRM_FOLLOW_UP_REMINDER",
        link: `/crm/follow-ups`,
        dedupeKey: `reminder:crm-follow-up:${task.id}:${task.dueAt.getTime()}`,
        recipient: user,
        emailSubject: `[SciManage] CRM 跟进提醒: ${task.title}`,
        emailText: `您好，\n\n客户「${customerName}」的跟进任务「${task.title}」即将到期，请及时处理。\n\n---\nSciManage 科研项目管理平台`,
        emailHtml: `<div style="font-family: sans-serif; max-width: 500px; margin: 0 auto;">
  <h2 style="color: #2563eb;">SciManage CRM 跟进提醒</h2>
  <p>您好，</p>
  <p>客户 <strong>「${customerName}」</strong> 的跟进任务 <strong>「${task.title}」</strong> 即将到期。</p>
  <p>请及时处理。</p>
  <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 24px 0;" />
  <p style="color: #64748b; font-size: 12px;">SciManage 科研项目管理平台</p>
</div>`,
      });

      await prisma.crmFollowUpTask.update({
        where: { id: task.id },
        data: { reminderStatus: "SENT", reminderSentAt: new Date(), reminderSent: true },
      });
      processed++;
    } catch (err) {
      console.error(`[REMINDER][CRM] Failed for task ${task.id}:`, err instanceof Error ? err.message : "未知错误");
      await markFailed("crmFollowUpTask", task.id, err);
      failed++;
    }
  }

  console.log(`[REMINDER][CRM] Scan complete: processed=${processed} failed=${failed}`);
  return { processed, failed };
}

export async function runAllReminders() {
  const start = Date.now();
  console.log("[REMINDER] Starting reminder scan...");

  // 每个扫描独立隔离：任一扫描顶层抛错（如 DB 不可达）不应连累其它扫描结果。
  // 用 Promise.allSettled + 各自兜底默认值，保证部分失败时其余照常完成。
  const safe = <T>(label: string, p: Promise<T>, fallback: T): Promise<T> =>
    p.catch((err) => {
      console.error(`[REMINDER] scan "${label}" threw:`, err instanceof Error ? err.message : err);
      return fallback;
    });

  const [ticketResult, crmResult, milestoneResult, archiveResult, invoiceNudgeResult, orderRepResult, checkinDraftSweepResult, attachmentMaintenanceResult] =
    await Promise.all([
      safe("tickets", checkAndSendReminders(), { processed: 0, failed: 0 }),
      safe("crm", checkAndSendCrmFollowUpReminders(), { processed: 0, failed: 0 }),
      safe("milestone", checkAndSendMilestoneReminders(), { dueSoon: 0, nudged: 0, failed: 0 }),
      safe("archiveReady", checkArchiveReadyProjects(), { ready: 0, failed: 0 }),
      safe("invoiceNudge", checkOverdueInvoiceNudges(), { nudged: 0, failed: 0 }),
      safe("orderRepNotify", checkOrderRepNotifications(), { notified: 0, skipped: 0, failed: 0, writebackFailed: 0 }),
      safe("checkinDraftSweep", sweepStaleCheckinDrafts(), { swept: 0 }),
      safe(
        "attachmentMaintenance",
        resumeAttachmentMaintenance(),
        { migrating: { migrated: 0, failed: 0 }, purging: { purged: 0, failed: 0 } },
      ),
    ]);

  const durationMs = Date.now() - start;
  console.log(
    `[REMINDER] Scan finished: tickets=${ticketResult.processed}/${ticketResult.processed + ticketResult.failed} crm=${crmResult.processed}/${crmResult.processed + crmResult.failed} milestone(dueSoon=${milestoneResult.dueSoon},nudged=${milestoneResult.nudged},failed=${milestoneResult.failed}) archiveReady=${archiveResult.ready} invoiceNudge=${invoiceNudgeResult.nudged} orderRepNotify(notified=${orderRepResult.notified},skipped=${orderRepResult.skipped},failed=${orderRepResult.failed},writebackFailed=${orderRepResult.writebackFailed}) checkinDraftSweep(swept=${checkinDraftSweepResult.swept}) attachmentMaintenance(migrated=${attachmentMaintenanceResult.migrating.migrated},purge=${attachmentMaintenanceResult.purging.purged}) durationMs=${durationMs}`,
  );

  return {
    ticketProcessed: ticketResult.processed,
    crmProcessed: crmResult.processed,
    ticketFailed: ticketResult.failed,
    crmFailed: crmResult.failed,
    milestoneDueSoon: milestoneResult.dueSoon,
    milestoneNudged: milestoneResult.nudged,
    milestoneFailed: milestoneResult.failed,
    archiveReady: archiveResult.ready,
    invoiceNudged: invoiceNudgeResult.nudged,
    invoiceNudgeFailed: invoiceNudgeResult.failed,
    orderRepNotified: orderRepResult.notified,
    orderRepSkipped: orderRepResult.skipped,
    orderRepFailed: orderRepResult.failed,
    orderRepWritebackFailed: orderRepResult.writebackFailed,
    checkinDraftSwept: checkinDraftSweepResult.swept,
    attachmentMigrated: attachmentMaintenanceResult.migrating.migrated,
    attachmentMigrationFailed: attachmentMaintenanceResult.migrating.failed,
    attachmentPurged: attachmentMaintenanceResult.purging.purged,
    attachmentPurgeFailed: attachmentMaintenanceResult.purging.failed,
    durationMs,
  };
}

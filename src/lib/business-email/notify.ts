/**
 * 商务邮件通知 — 发送编排
 * 见 docs/business-email-notification-design-2026-06-26.md
 *
 * 设计约束：
 * - 外部部门收件人（ExternalContact）不是系统 User，无 Notification 记录，直接 sendMail。
 * - 项目成员（User）邮件走 Notification + dedupeKey + 后台发送。
 * - 所有面向业务主流程的 wrapper 都 fail-closed：try/catch，绝不向调用方抛错（风险点 9）。
 */
import { prisma } from "@/lib/prisma";
import { sendMail, sendMailInBackground } from "@/lib/mail";
import {
  resolveMilestoneRecipients,
  resolveFinanceRecipients,
  type ExternalRecipient,
} from "./recipients";
import {
  buildMilestoneNudgeEmail,
  buildMilestoneCompletedEmail,
  buildInvoiceRequestedEmail,
  buildInvoiceAdjustedEmail,
  buildProjectArchivedEmail,
  type BuiltEmail,
} from "./templates";
import { BUSINESS_EMAIL_TYPE } from "./constants";

// ── 外部邮件日志上下文（item 4：邮件发送历史） ───────────────────────────────
export interface ExternalEmailLogContext {
  type: string; // BUSINESS_EMAIL_TYPE 之一
  projectId?: string | null;
  milestoneId?: string | null;
  invoiceId?: string | null;
  orderId?: string | null; // H 下单代表通知（§4.2）
  representativeId?: string | null; // H 下单代表通知（§4.2）
}

// ── 低层：单条外部邮件日志落库（fail-safe，绝不向调用方抛错） ──────────────────
async function logBusinessEmail(params: {
  ctx: ExternalEmailLogContext;
  recipient: ExternalRecipient;
  subject: string;
  status: "sent" | "failed";
  error?: string | null;
}): Promise<void> {
  try {
    await prisma.businessEmailLog.create({
      data: {
        type: params.ctx.type,
        toEmail: params.recipient.email,
        toName: params.recipient.name ?? null,
        ccEmails:
          params.recipient.ccEmails.length > 0
            ? params.recipient.ccEmails.join(", ")
            : null,
        subject: params.subject,
        status: params.status,
        error: params.error ? params.error.slice(0, 500) : null,
        contactId: params.recipient.contactId ?? null,
        projectId: params.ctx.projectId ?? null,
        milestoneId: params.ctx.milestoneId ?? null,
        invoiceId: params.ctx.invoiceId ?? null,
      },
    });
  } catch (e) {
    // 日志失败不能影响主发送流程
    console.error(
      "[BIZ_EMAIL][LOG] failed to persist send log:",
      e instanceof Error ? e.message : e,
    );
  }
}

// ── 低层：批量外部邮件日志落库（fail-safe，一次 createMany，绝不向调用方抛错） ───
// 聚合邮件（一封覆盖 N 单）需落 N 条同状态日志：用 createMany 把 §5.7 的重复投递窗口
// 压缩到两次 DB 往返，并在循环中途崩溃时避免留下部分日志。日志缺失可接受（只 console），
// 不得改变调用方的 sent/failed 判定。
async function logBusinessEmailMany(
  rows: Array<{
    ctx: ExternalEmailLogContext;
    recipient: ExternalRecipient;
    subject: string;
    status: "sent" | "failed";
    error?: string | null;
  }>,
): Promise<void> {
  if (rows.length === 0) return;
  try {
    await prisma.businessEmailLog.createMany({
      data: rows.map((r) => ({
        type: r.ctx.type,
        toEmail: r.recipient.email,
        toName: r.recipient.name ?? null,
        ccEmails:
          r.recipient.ccEmails.length > 0 ? r.recipient.ccEmails.join(", ") : null,
        subject: r.subject,
        status: r.status,
        error: r.error ? r.error.slice(0, 500) : null,
        contactId: r.recipient.contactId ?? null,
        projectId: r.ctx.projectId ?? null,
        milestoneId: r.ctx.milestoneId ?? null,
        invoiceId: r.ctx.invoiceId ?? null,
        orderId: r.ctx.orderId ?? null,
        representativeId: r.ctx.representativeId ?? null,
      })),
    });
  } catch (e) {
    console.error(
      "[BIZ_EMAIL][LOG] batch persist failed:",
      e instanceof Error ? e.message : e,
    );
  }
}

/**
 * 单收件人发送一次，按 logContexts 批量落 N 条同状态日志（聚合邮件专用）。
 *
 * 与 sendExternalEmail() 一样捕获异常、只返回计数不抛错——调用方必须检查返回值判定
 * 成败（绝不 try/catch 判成败，见设计 §6.2 第 5 步）。返回 error 供调用方写入业务侧
 * 状态字段（如 Order.repNotifyError）。日志写入 fail-safe：createMany 失败不改变判定。
 */
export async function sendExternalEmailWithLogs(p: {
  recipient: ExternalRecipient;
  email: BuiltEmail;
  logContexts: ExternalEmailLogContext[];
}): Promise<{ sent: number; failed: number; error?: string }> {
  try {
    await sendMail({
      to: p.recipient.email,
      cc: p.recipient.ccEmails.length > 0 ? p.recipient.ccEmails : undefined,
      subject: p.email.subject,
      text: p.email.text,
      html: p.email.html,
    });
    await logBusinessEmailMany(
      p.logContexts.map((ctx) => ({
        ctx,
        recipient: p.recipient,
        subject: p.email.subject,
        status: "sent" as const,
      })),
    );
    return { sent: 1, failed: 0 };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "未知错误";
    console.error(`[BIZ_EMAIL] send to ${p.recipient.email} failed:`, msg);
    await logBusinessEmailMany(
      p.logContexts.map((ctx) => ({
        ctx,
        recipient: p.recipient,
        subject: p.email.subject,
        status: "failed" as const,
        error: msg,
      })),
    );
    return { sent: 0, failed: 1, error: msg };
  }
}

// ── 低层：向外部收件人逐个发信（含抄送），每个独立 try/catch ──────────────────
export async function sendExternalEmail(
  recipients: ExternalRecipient[],
  built: BuiltEmail,
  logContext?: ExternalEmailLogContext,
): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;
  for (const r of recipients) {
    try {
      await sendMail({
        to: r.email,
        cc: r.ccEmails.length > 0 ? r.ccEmails : undefined,
        subject: built.subject,
        text: built.text,
        html: built.html,
      });
      sent++;
      if (logContext) {
        await logBusinessEmail({ ctx: logContext, recipient: r, subject: built.subject, status: "sent" });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "未知错误";
      console.error(`[BIZ_EMAIL] send to ${r.email} failed:`, msg);
      failed++;
      if (logContext) {
        await logBusinessEmail({ ctx: logContext, recipient: r, subject: built.subject, status: "failed", error: msg });
      }
    }
  }
  return { sent, failed };
}

// ── 低层：项目成员站内通知 + 后台邮件（dedupeKey 去重，对标 deliverReminder） ──
export interface MemberRecipient {
  id: string;
  email: string | null;
  emailEnabled: boolean | null;
}

export async function deliverMemberNotification(params: {
  userId: string;
  title: string;
  content: string;
  type: string;
  link: string;
  dedupeKey: string;
  recipient: MemberRecipient;
  email: BuiltEmail;
}): Promise<boolean> {
  const shouldEmail = !!(params.recipient.email && params.recipient.emailEnabled);
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
      sendMailInBackground(
        {
          to: params.recipient.email!,
          subject: params.email.subject,
          text: params.email.text,
          html: params.email.html,
        },
        notification.id,
      );
    }
    return true;
  } catch (e) {
    if (
      typeof e === "object" &&
      e !== null &&
      "code" in e &&
      (e as { code: string }).code === "P2002"
    ) {
      const existing = await prisma.notification.findUnique({
        where: { dedupeKey: params.dedupeKey },
        select: { id: true, emailStatus: true },
      });
      if (existing && existing.emailStatus === "pending" && shouldEmail) {
        sendMailInBackground(
          {
            to: params.recipient.email!,
            subject: params.email.subject,
            text: params.email.text,
            html: params.email.html,
          },
          existing.id,
        );
      }
      return false;
    }
    throw e;
  }
}

// ── 节点催办（B 自动 / C 手动） ───────────────────────────────────────────────
/**
 * 向节点收件人发催办邮件。
 * @param ignoreSuppress 手动催办为 true（忽略 suppressUntil）。
 * 返回收件人数 + 发送统计（供 API 反馈 + scan 统计）。
 */
export async function sendMilestoneNudge(p: {
  milestoneId: string;
  projectId: string;
  projectName: string;
  milestoneName: string;
  dueDate: Date | null;
  manual: boolean;
}): Promise<{ recipients: number; sent: number; failed: number }> {
  const recipients = await resolveMilestoneRecipients(p.milestoneId, {
    ignoreSuppress: p.manual,
  });
  if (recipients.length === 0) {
    return { recipients: 0, sent: 0, failed: 0 };
  }
  const built = buildMilestoneNudgeEmail({
    projectId: p.projectId,
    projectName: p.projectName,
    milestoneName: p.milestoneName,
    dueDate: p.dueDate,
    manual: p.manual,
  });
  const { sent, failed } = await sendExternalEmail(recipients, built, {
    type: p.manual
      ? BUSINESS_EMAIL_TYPE.MILESTONE_MANUAL_NUDGE
      : BUSINESS_EMAIL_TYPE.MILESTONE_OVERDUE_NUDGE,
    projectId: p.projectId,
    milestoneId: p.milestoneId,
  });
  return { recipients: recipients.length, sent, failed };
}

// ── D 节点逾期后完成通知（自动/完成尊重 suppress） ───────────────────────────
export async function sendMilestoneCompleted(p: {
  milestoneId: string;
  projectId: string;
  projectName: string;
  milestoneName: string;
  dueDate: Date | null;
  doneAt: Date;
}): Promise<{ recipients: number; sent: number; failed: number }> {
  const recipients = await resolveMilestoneRecipients(p.milestoneId, {
    ignoreSuppress: false,
  });
  if (recipients.length === 0) {
    return { recipients: 0, sent: 0, failed: 0 };
  }
  const built = buildMilestoneCompletedEmail({
    projectId: p.projectId,
    projectName: p.projectName,
    milestoneName: p.milestoneName,
    dueDate: p.dueDate,
    doneAt: p.doneAt,
  });
  const { sent, failed } = await sendExternalEmail(recipients, built, {
    type: BUSINESS_EMAIL_TYPE.MILESTONE_COMPLETED,
    projectId: p.projectId,
    milestoneId: p.milestoneId,
  });
  return { recipients: recipients.length, sent, failed };
}

// ── E 发票申请提交（fail-closed wrapper） ─────────────────────────────────────
export async function sendInvoiceRequestedEmail(invoiceId: string): Promise<void> {
  try {
    const invoice = await prisma.externalOrderInvoiceRequest.findUnique({
      where: { id: invoiceId },
      select: {
        id: true,
        buyerOrganizationName: true,
        totalAmount: true,
        contentSummary: true,
        createdBy: { select: { name: true } },
      },
    });
    if (!invoice) return;
    const recipients = await resolveFinanceRecipients();
    if (recipients.length === 0) {
      console.warn("[BIZ_EMAIL][INVOICE_REQUESTED] no FINANCE recipient configured");
      return;
    }
    const built = buildInvoiceRequestedEmail({
      invoiceId: invoice.id,
      buyerName: invoice.buyerOrganizationName,
      totalAmountCents: invoice.totalAmount,
      contentSummary: invoice.contentSummary,
      requesterName: invoice.createdBy?.name ?? "未知",
    });
    await sendExternalEmail(recipients, built, {
      type: BUSINESS_EMAIL_TYPE.INVOICE_REQUESTED,
      invoiceId: invoice.id,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "未知错误";
    console.error(`[BIZ_EMAIL][INVOICE_REQUESTED] failed for ${invoiceId}:`, msg);
  }
}

// ── F 发票冲红/重开（fail-closed wrapper） ────────────────────────────────────
export async function sendInvoiceAdjustedEmail(p: {
  invoiceId: string;
  kind: "RED" | "REISSUE";
  reason: string | null;
  operatorName: string;
}): Promise<void> {
  try {
    const invoice = await prisma.externalOrderInvoiceRequest.findUnique({
      where: { id: p.invoiceId },
      select: { id: true, buyerOrganizationName: true, totalAmount: true },
    });
    if (!invoice) return;
    const recipients = await resolveFinanceRecipients();
    if (recipients.length === 0) {
      console.warn("[BIZ_EMAIL][INVOICE_ADJUSTED] no FINANCE recipient configured");
      return;
    }
    const built = buildInvoiceAdjustedEmail({
      invoiceId: invoice.id,
      kind: p.kind,
      buyerName: invoice.buyerOrganizationName,
      totalAmountCents: invoice.totalAmount,
      reason: p.reason,
      operatorName: p.operatorName,
    });
    await sendExternalEmail(recipients, built, {
      type: BUSINESS_EMAIL_TYPE.INVOICE_ADJUSTED,
      invoiceId: invoice.id,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "未知错误";
    console.error(`[BIZ_EMAIL][INVOICE_ADJUSTED] failed for ${p.invoiceId}:`, msg);
  }
}

// ── G 项目归档通知（fail-closed wrapper，发给项目成员 + 操作人） ───────────────
export async function sendProjectArchivedEmail(p: {
  projectId: string;
  projectName: string;
  archivedByName: string;
}): Promise<void> {
  try {
    const members = await prisma.projectMember.findMany({
      where: { projectId: p.projectId },
      select: {
        user: {
          select: { id: true, email: true, name: true, emailOnStatusChange: true },
        },
      },
    });
    const built = buildProjectArchivedEmail({
      projectId: p.projectId,
      projectName: p.projectName,
      archivedByName: p.archivedByName,
    });
    const seen = new Set<string>();
    for (const m of members) {
      const u = m.user;
      if (!u || seen.has(u.id)) continue;
      seen.add(u.id);
      // 单成员失败隔离 + per-user dedupeKey（project 级 dedupeKey 会令仅首位成员
      // 拿到站内通知，其余命中 P2002 被跳过）。
      try {
        await deliverMemberNotification({
          userId: u.id,
          title: `项目已归档: ${p.projectName}`,
          content: `项目「${p.projectName}」已由 ${p.archivedByName} 归档。`,
          type: BUSINESS_EMAIL_TYPE.PROJECT_ARCHIVED,
          link: `/projects/${p.projectId}`,
          dedupeKey: `project-archived:${p.projectId}:${u.id}`,
          recipient: { id: u.id, email: u.email, emailEnabled: u.emailOnStatusChange },
          email: built,
        });
      } catch (e) {
        console.error(
          `[BIZ_EMAIL][PROJECT_ARCHIVED] member ${u.id} failed for ${p.projectId}:`,
          e instanceof Error ? e.message : e,
        );
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "未知错误";
    console.error(`[BIZ_EMAIL][PROJECT_ARCHIVED] failed for ${p.projectId}:`, msg);
  }
}

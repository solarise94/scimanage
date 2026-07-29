/**
 * 商务邮件通知 — 收件人解析
 * 见 docs/business-email-notification-design-2026-06-26.md §8.2
 */
import { prisma } from "@/lib/prisma";
import { FINANCE_DEPARTMENT } from "./constants";

export interface ExternalRecipient {
  contactId: string;
  name: string;
  email: string;
  ccEmails: string[];
}

/** 解析逗号/分号/空白分隔的抄送邮箱字符串为去重数组 */
export function parseCcEmails(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const parts = raw
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.includes("@"));
  return Array.from(new Set(parts));
}

/**
 * 解析某节点的外部催办收件人。
 * - 统一过滤：ExternalContact.archived=false && enabled=true
 * - 自动催办 / 完成通知：尊重 suppressUntil（> now 则跳过）
 * - 手动催办：ignoreSuppress=true，忽略 suppressUntil（用户明确意图）
 */
export async function resolveMilestoneRecipients(
  milestoneId: string,
  opts: { ignoreSuppress: boolean },
): Promise<ExternalRecipient[]> {
  const now = new Date();
  const links = await prisma.milestoneContact.findMany({
    where: {
      milestoneId,
      externalContact: { archived: false, enabled: true },
    },
    include: {
      externalContact: {
        select: { id: true, name: true, email: true, ccEmails: true },
      },
    },
  });

  const result: ExternalRecipient[] = [];
  for (const link of links) {
    if (!opts.ignoreSuppress) {
      // suppressUntil > now → 临时静默，跳过
      if (link.suppressUntil && link.suppressUntil.getTime() > now.getTime()) {
        continue;
      }
    }
    const c = link.externalContact;
    if (!c.email) continue;
    result.push({
      contactId: c.id,
      name: c.name,
      email: c.email,
      ccEmails: parseCcEmails(c.ccEmails),
    });
  }
  return result;
}

/**
 * 解析财务部收件人（发票邮件 E / F / F2）。
 * department=FINANCE 固定值 + archived=false + enabled=true。
 */
export async function resolveFinanceRecipients(): Promise<ExternalRecipient[]> {
  const contacts = await prisma.externalContact.findMany({
    where: {
      department: FINANCE_DEPARTMENT,
      archived: false,
      enabled: true,
    },
    select: { id: true, name: true, email: true, ccEmails: true },
  });
  return contacts
    .filter((c) => !!c.email)
    .map((c) => ({
      contactId: c.id,
      name: c.name,
      email: c.email,
      ccEmails: parseCcEmails(c.ccEmails),
    }));
}

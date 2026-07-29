/**
 * 商务邮件通知 — 邮件内容模板
 * 见 docs/business-email-notification-design-2026-06-26.md §8
 *
 * 所有 builder 返回 { subject, text, html }，动态内容一律 escapeHtml。
 * HTML 内联样式，对标 deploy-notify 模板。
 */
import { getAppUrl } from "@/lib/app-url";
import { centsToYuan } from "@/lib/finance/money";

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface BuiltEmail {
  subject: string;
  text: string;
  html: string;
}

/** 分 → 元字符串（带千分位） */
export function formatYuan(cents: number): string {
  const yuan = centsToYuan(cents);
  return `¥${yuan.toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function fmtDate(d: Date | null | undefined): string {
  if (!d) return "未设置";
  return d.toLocaleString("zh-CN", { hour12: false });
}

/** 统一 HTML 外壳：标题 + 强调色 + 内容 + 页脚链接 */
function wrapHtml(opts: {
  heading: string;
  accent: string;
  rows: Array<{ label: string; value: string }>;
  intro: string;
  outro?: string;
  ctaLabel?: string;
  ctaUrl?: string;
}): string {
  const rowsHtml = opts.rows
    .map(
      (r) =>
        `<tr><td style="padding: 6px 0; color: #64748b; width: 110px; vertical-align: top;">${escapeHtml(
          r.label,
        )}</td><td style="padding: 6px 0;">${r.value}</td></tr>`,
    )
    .join("");

  const cta =
    opts.ctaLabel && opts.ctaUrl
      ? `<p style="margin: 24px 0;"><a href="${escapeHtml(
          opts.ctaUrl,
        )}" style="display: inline-block; background: ${opts.accent}; color: #fff; text-decoration: none; padding: 10px 20px; border-radius: 6px; font-size: 14px;">${escapeHtml(
          opts.ctaLabel,
        )}</a></p>`
      : "";

  return `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>${escapeHtml(opts.heading)}</title></head>
<body style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; color: #1e293b;">
  <h2 style="color: ${opts.accent}; border-bottom: 2px solid #e2e8f0; padding-bottom: 12px;">${escapeHtml(
    opts.heading,
  )}</h2>
  <p>${escapeHtml(opts.intro)}</p>
  <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">${rowsHtml}</table>
  ${opts.outro ? `<p>${escapeHtml(opts.outro)}</p>` : ""}
  ${cta}
  <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 32px 0;" />
  <p style="color: #94a3b8; font-size: 12px;">SciManage 科研项目管理平台</p>
</body>
</html>`.trim();
}

// ── A 节点到期前提醒（项目成员） ──────────────────────────────────────────────
export function buildMilestoneDueSoonEmail(p: {
  projectId: string;
  projectName: string;
  milestoneName: string;
  dueDate: Date;
}): BuiltEmail {
  const url = getAppUrl(`/projects/${p.projectId}`, { tab: "milestones" });
  const subject = `[SciManage] 项目节点即将到期: ${p.projectName} - ${p.milestoneName}`;
  const text = `您好，\n\n项目「${p.projectName}」的周期节点「${p.milestoneName}」即将到期（计划到期 ${fmtDate(
    p.dueDate,
  )}），请关注处理进度。\n\n${url}\n\n---\nSciManage 科研项目管理平台`;
  const html = wrapHtml({
    heading: "项目节点即将到期",
    accent: "#2563eb",
    intro: `项目「${p.projectName}」的周期节点即将到期，请关注处理进度。`,
    rows: [
      { label: "项目", value: escapeHtml(p.projectName) },
      { label: "节点", value: `<strong>${escapeHtml(p.milestoneName)}</strong>` },
      { label: "计划到期", value: escapeHtml(fmtDate(p.dueDate)) },
    ],
    ctaLabel: "查看项目节点",
    ctaUrl: url,
  });
  return { subject, text, html };
}

// ── B/C 节点逾期催办（外部部门，自动 + 手动共用模板，标题区分） ─────────────────
export function buildMilestoneNudgeEmail(p: {
  projectId: string;
  projectName: string;
  milestoneName: string;
  dueDate: Date | null;
  manual: boolean;
}): BuiltEmail {
  const url = getAppUrl(`/projects/${p.projectId}`, { tab: "milestones" });
  const kind = p.manual ? "催办" : "逾期催办";
  const subject = `[SciManage] 项目节点${kind}: ${p.projectName} - ${p.milestoneName}`;
  const overdueNote = p.dueDate
    ? `该节点计划到期 ${fmtDate(p.dueDate)}，目前尚未完成。`
    : "该节点目前尚未完成。";
  const text = `您好，\n\n项目「${p.projectName}」的周期节点「${p.milestoneName}」${kind}。${overdueNote}请尽快推进。\n\n${url}\n\n---\nSciManage 科研项目管理平台`;
  const html = wrapHtml({
    heading: `项目节点${kind}`,
    accent: "#dc2626",
    intro: `项目「${p.projectName}」的周期节点需要您尽快推进。`,
    rows: [
      { label: "项目", value: escapeHtml(p.projectName) },
      { label: "节点", value: `<strong>${escapeHtml(p.milestoneName)}</strong>` },
      { label: "计划到期", value: escapeHtml(fmtDate(p.dueDate)) },
    ],
    outro: overdueNote,
    ctaLabel: "查看项目节点",
    ctaUrl: url,
  });
  return { subject, text, html };
}

// ── D 节点逾期后完成通知（外部部门） ──────────────────────────────────────────
export function buildMilestoneCompletedEmail(p: {
  projectId: string;
  projectName: string;
  milestoneName: string;
  dueDate: Date | null;
  doneAt: Date;
}): BuiltEmail {
  const url = getAppUrl(`/projects/${p.projectId}`, { tab: "milestones" });
  const subject = `[SciManage] 项目节点已完成: ${p.projectName} - ${p.milestoneName}`;
  const text = `您好，\n\n此前催办的项目「${p.projectName}」周期节点「${p.milestoneName}」已于 ${fmtDate(
    p.doneAt,
  )} 完成，特此通知。\n\n${url}\n\n---\nSciManage 科研项目管理平台`;
  const html = wrapHtml({
    heading: "项目节点已完成",
    accent: "#16a34a",
    intro: `此前催办的项目节点已完成，特此通知。`,
    rows: [
      { label: "项目", value: escapeHtml(p.projectName) },
      { label: "节点", value: `<strong>${escapeHtml(p.milestoneName)}</strong>` },
      { label: "计划到期", value: escapeHtml(fmtDate(p.dueDate)) },
      { label: "完成时间", value: escapeHtml(fmtDate(p.doneAt)) },
    ],
    ctaLabel: "查看项目节点",
    ctaUrl: url,
  });
  return { subject, text, html };
}

// ── E 发票申请提交（财务部） ──────────────────────────────────────────────────
export function buildInvoiceRequestedEmail(p: {
  invoiceId: string;
  buyerName: string;
  totalAmountCents: number;
  contentSummary: string | null;
  requesterName: string;
}): BuiltEmail {
  const url = getAppUrl(`/finance/invoices`, { focus: p.invoiceId });
  const subject = `[SciManage] 发票申请: ${p.buyerName} ${formatYuan(p.totalAmountCents)}`;
  const text = `您好，\n\n收到一笔新的发票申请，请财务部及时处理：\n\n购方：${p.buyerName}\n金额：${formatYuan(
    p.totalAmountCents,
  )}\n开票内容：${p.contentSummary || "（未填写）"}\n申请人：${p.requesterName}\n\n${url}\n\n---\nSciManage 科研项目管理平台`;
  const html = wrapHtml({
    heading: "新发票申请",
    accent: "#2563eb",
    intro: "收到一笔新的发票申请，请财务部及时处理。",
    rows: [
      { label: "购方", value: `<strong>${escapeHtml(p.buyerName)}</strong>` },
      { label: "金额", value: `<strong>${escapeHtml(formatYuan(p.totalAmountCents))}</strong>` },
      { label: "开票内容", value: escapeHtml(p.contentSummary || "（未填写）") },
      { label: "申请人", value: escapeHtml(p.requesterName) },
    ],
    ctaLabel: "查看发票申请",
    ctaUrl: url,
  });
  return { subject, text, html };
}

// ── F 发票冲红/重开（财务部） ────────────────────────────────────────────────
export function buildInvoiceAdjustedEmail(p: {
  invoiceId: string;
  kind: "RED" | "REISSUE";
  buyerName: string;
  totalAmountCents: number;
  reason: string | null;
  operatorName: string;
}): BuiltEmail {
  const kindLabel = p.kind === "RED" ? "冲红" : "重开";
  const url = getAppUrl(`/finance/invoices`, { focus: p.invoiceId });
  const subject = `[SciManage] 发票${kindLabel}: ${p.buyerName} ${formatYuan(p.totalAmountCents)}`;
  const text = `您好，\n\n一张发票被${kindLabel}，请财务部知悉并处理：\n\n购方：${p.buyerName}\n金额：${formatYuan(
    p.totalAmountCents,
  )}\n操作：${kindLabel}\n原因：${p.reason || "（未填写）"}\n操作人：${p.operatorName}\n\n${url}\n\n---\nSciManage 科研项目管理平台`;
  const html = wrapHtml({
    heading: `发票${kindLabel}`,
    accent: "#d97706",
    intro: `一张发票被${kindLabel}，请财务部知悉并处理。`,
    rows: [
      { label: "购方", value: `<strong>${escapeHtml(p.buyerName)}</strong>` },
      { label: "金额", value: escapeHtml(formatYuan(p.totalAmountCents)) },
      { label: "操作", value: `<strong>${escapeHtml(kindLabel)}</strong>` },
      { label: "原因", value: escapeHtml(p.reason || "（未填写）") },
      { label: "操作人", value: escapeHtml(p.operatorName) },
    ],
    ctaLabel: "查看发票",
    ctaUrl: url,
  });
  return { subject, text, html };
}

// ── F2 发票超期催办（财务部） ────────────────────────────────────────────────
export function buildInvoiceOverdueEmail(p: {
  invoiceId: string;
  buyerName: string;
  totalAmountCents: number;
  requestedAt: Date;
  overdueDays: number;
}): BuiltEmail {
  const url = getAppUrl(`/finance/invoices`, { focus: p.invoiceId });
  const subject = `[SciManage] 发票超期催办: ${p.buyerName} 已 ${p.overdueDays} 天未开`;
  const text = `您好，\n\n一笔发票申请已提交超过 ${p.overdueDays} 天仍未开具，请财务部尽快处理：\n\n购方：${p.buyerName}\n金额：${formatYuan(
    p.totalAmountCents,
  )}\n申请时间：${fmtDate(p.requestedAt)}\n\n${url}\n\n---\nSciManage 科研项目管理平台`;
  const html = wrapHtml({
    heading: "发票超期催办",
    accent: "#dc2626",
    intro: `一笔发票申请已提交超过 ${p.overdueDays} 天仍未开具，请财务部尽快处理。`,
    rows: [
      { label: "购方", value: `<strong>${escapeHtml(p.buyerName)}</strong>` },
      { label: "金额", value: escapeHtml(formatYuan(p.totalAmountCents)) },
      { label: "申请时间", value: escapeHtml(fmtDate(p.requestedAt)) },
      { label: "超期天数", value: `<strong>${p.overdueDays} 天</strong>` },
    ],
    ctaLabel: "查看发票申请",
    ctaUrl: url,
  });
  return { subject, text, html };
}

// ── G 项目归档通知（项目成员） ────────────────────────────────────────────────
export function buildProjectArchivedEmail(p: {
  projectId: string;
  projectName: string;
  archivedByName: string;
}): BuiltEmail {
  const url = getAppUrl(`/projects/${p.projectId}`);
  const subject = `[SciManage] 项目已归档: ${p.projectName}`;
  const text = `您好，\n\n项目「${p.projectName}」已由 ${p.archivedByName} 归档（合同 / 发票 / 订单三态全齐）。\n\n${url}\n\n---\nSciManage 科研项目管理平台`;
  const html = wrapHtml({
    heading: "项目已归档",
    accent: "#0f172a",
    intro: `项目「${p.projectName}」已归档（合同 / 发票 / 订单三态全齐）。`,
    rows: [
      { label: "项目", value: `<strong>${escapeHtml(p.projectName)}</strong>` },
      { label: "归档人", value: escapeHtml(p.archivedByName) },
    ],
    ctaLabel: "查看项目",
    ctaUrl: url,
  });
  return { subject, text, html };
}

// ── H 下单代表通知（Representative，聚合邮件） ──────────────────────────────
// 见 docs/order-rep-notify-email-design-2026-07-26.md §6.3
// Subject 三分支：单片且 1 单 / 单片多单 / 分片批次。
// 正文：称呼 + 订单表格（订单号深链 /orders?focus=<id>、标题、购买方机构、金额、状态、下单人、
// 登记时间）+ 分片标注 + 页脚。金额只放订单总额；不放成本/利润/提成字段。
export interface OrderRepNotifyOrder {
  id: string;
  orderNo: string;
  title: string;
  buyerOrgNameSnapshot: string | null;
  totalAmount: number; // 分
  status: string;
  createdAt: Date;
  creatorName: string | null;
}

export function buildOrderRepNotifyEmail(p: {
  repName: string;
  orders: OrderRepNotifyOrder[];
  batch: { index: number; total: number; totalOrders: number } | null;
}): BuiltEmail {
  const orders = p.orders;
  const n = orders.length;
  const isBatched = p.batch !== null;

  // ── Subject 三分支 ──
  let subject: string;
  if (isBatched) {
    subject = `【SciManage】新订单登记通知（第 ${p.batch!.index}/${p.batch!.total} 批，共 ${p.batch!.totalOrders} 单）`;
  } else if (n === 1) {
    subject = `【SciManage】新订单登记通知：${orders[0].orderNo}`;
  } else {
    subject = `【SciManage】新订单登记通知（${n} 单）`;
  }

  // 订单号深链（base 用 @/lib/app-url，禁止手拼 NEXTAUTH_URL）
  const orderLink = (id: string) => getAppUrl(`/orders`, { focus: id });

  const rowsToLine = (o: OrderRepNotifyOrder) =>
    `- 订单号：${o.orderNo}（${orderLink(o.id)}）\n` +
    `  标题：${o.title}\n` +
    `  购买方机构：${o.buyerOrgNameSnapshot || "（未填写）"}\n` +
    `  金额：${formatYuan(o.totalAmount)}\n` +
    `  订单状态：${o.status}\n` +
    `  下单人：${o.creatorName || "未知"}\n` +
    `  登记时间：${fmtDate(o.createdAt)}`;

  const batchNoteText = isBatched
    ? `\n本批第 ${p.batch!.index}/${p.batch!.total} 批，共 ${p.batch!.totalOrders} 单。\n`
    : "";
  const batchNoteHtml = isBatched
    ? `<p style="color:#64748b;font-size:13px;">本批第 ${p.batch!.index}/${p.batch!.total} 批，共 ${p.batch!.totalOrders} 单。</p>`
    : "";

  const text =
    `${p.repName} 您好，\n\n` +
    `您名下登记了 ${n} 笔新订单，特此通知：\n${batchNoteText}\n` +
    orders.map(rowsToLine).join("\n\n") +
    `\n\n---\nSciManage 科研项目管理平台 · 本邮件由系统自动发送`;

  // ── HTML 表格 ──
  const th =
    'style="padding:8px 10px;text-align:left;border-bottom:1px solid #e2e8f0;background:#f8fafc;font-size:12px;color:#475569;"';
  const td =
    'style="padding:8px 10px;border-bottom:1px solid #f1f5f9;font-size:13px;vertical-align:top;"';
  const headRow =
    `<tr>` +
    `<th ${th}>订单号</th><th ${th}>标题</th><th ${th}>购买方机构</th>` +
    `<th ${th}>金额</th><th ${th}>状态</th><th ${th}>下单人</th><th ${th}>登记时间</th>` +
    `</tr>`;
  const bodyRows = orders
    .map((o) => {
      const link = orderLink(o.id);
      const orderNoCell = `<a href="${escapeHtml(link)}" style="color:#2563eb;text-decoration:none;">${escapeHtml(o.orderNo)}</a>`;
      return (
        `<tr>` +
        `<td ${td}>${orderNoCell}</td>` +
        `<td ${td}>${escapeHtml(o.title)}</td>` +
        `<td ${td}>${escapeHtml(o.buyerOrgNameSnapshot || "（未填写）")}</td>` +
        `<td ${td}>${escapeHtml(formatYuan(o.totalAmount))}</td>` +
        `<td ${td}>${escapeHtml(o.status)}</td>` +
        `<td ${td}>${escapeHtml(o.creatorName || "未知")}</td>` +
        `<td ${td}>${escapeHtml(fmtDate(o.createdAt))}</td>` +
        `</tr>`
      );
    })
    .join("");

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>${escapeHtml(subject)}</title></head>
<body style="font-family:sans-serif;max-width:760px;margin:0 auto;padding:24px;color:#1e293b;">
  <h2 style="color:#2563eb;border-bottom:2px solid #e2e8f0;padding-bottom:12px;">新订单登记通知</h2>
  <p>${escapeHtml(p.repName)} 您好，</p>
  <p>您名下登记了 <strong>${n}</strong> 笔新订单，特此通知。</p>
  ${batchNoteHtml}
  <table style="width:100%;border-collapse:collapse;margin:16px 0;">${headRow}${bodyRows}</table>
  <hr style="border:none;border-top:1px solid #e2e8f0;margin:32px 0;" />
  <p style="color:#94a3b8;font-size:12px;">SciManage 科研项目管理平台 · 本邮件由系统自动发送</p>
</body>
</html>`.trim();

  return { subject, text, html };
}

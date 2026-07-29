/**
 * 合同台账导出（src/lib/orders/contract-ledger-export.ts）
 *
 * TSV 先行 + 飞书 API 预留（见设计文档 §11）。
 * 44 列与参考台账对齐。进度款/成本分期按公式重算（不读库存值，§11.4）：
 *   - 商品：立项款 0%，交付款 100%
 *   - 服务 / 其它（混合、预存款抵扣等）：立项款 30%，交付款 70%
 * 金额从分（cents）→ 元，导出时 centsToYuan。分期全程用整数分（ratioCents）运算，
 * 保证 立项款 + 交付款 == 项目金额，且交付款列(R/AO)两处永远同值。
 */

import { centsToYuan, ratioCents } from "@/lib/finance/money";
import { getProjectTypeLabel } from "@/lib/project-type";

// ─── 抽象导出接口（§11.1）────────────────────────────────────────
export interface ExportResult {
  format: "tsv" | "feishu_base";
  content?: string;
  feishuToken?: string;
  rowCount: number;
}

export interface LedgerExporter {
  export(rows: LedgerExportRow[]): ExportResult;
}

// ─── 导出行结构（从 DB 反查组装，金额已是分）────────────────────
export interface LedgerExportInvoice {
  amountCents: number;
  issuedAt: Date | string | null;
  invoiceNo: string | null;
}
export interface LedgerExportReceipt {
  amountCents: number;
  receivedAt: Date | string | null;
  account: string | null;
}
export interface LedgerExportRow {
  projectNo: string | null;
  orderNumber: string | null;
  organization: string | null;
  client: string | null;
  representative: string | null;
  techSupport: string | null;
  projectType: string | null;
  projectContent: string | null;
  quantity: number | null;
  procurementSource: string | null;
  brand: string | null;
  status: string | null;
  startDate: Date | string | null;
  deliveredAt: Date | string | null;
  terminatedAt: Date | string | null;
  projectAmountCents: number | null;
  projectCostCents: number | null;
  commissionPaidCents: number | null;
  quarterlyBonusCents: number | null;
  remark: string | null;
  receiptRemark: string | null;
  sellerName: string | null;
  buyerInvoiceOrgName: string | null;
  invoices: LedgerExportInvoice[];
  receipts: LedgerExportReceipt[];
  totalReceivableCents: number | null;
  finalReceivableCents: number | null;
  totalPayableCents: number | null;
  attachmentFileName: string | null;
  parentProjectNo: string | null;
}

export const LEDGER_EXPORT_HEADERS = [
  "项目编号", "高精立项编号", "对方单位", "客户", "代表", "技术支持",
  "项目类型", "项目内容", "数量", "采购渠道", "品牌", "项目进度",
  "立项时间", "交付时间", "终止时间",
  "项目金额（元）", "立项进度款（30%/0%）", "交付进度款（70%/100%）",
  "项目成本（元）", "立项成本（30%/0%）", "交付成本（70%/100%）", "项目利润",
  "打款|提成", "季度超指标奖励", "备注",
  "我方开票单位", "对方开票单位",
  "开票金额1", "开票时间1", "开票金额2", "开票时间2", "发票号",
  "到款备注", "到款1", "到款时间1", "到款账户1", "到款2", "到款时间2", "到款账户2",
  "总应收款", "交付应收款", "总应付款",
  "合同&出库单附件", "父记录",
];

const STATUS_MAP: Record<string, string> = {
  NOT_STARTED: "预实验",
  IN_PROGRESS: "已签单",
  COMPLETED: "已交付",
  ON_HOLD: "暂停",
  TERMINATED: "终止",
};

function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return "";
  const date = typeof d === "string" ? new Date(d) : d;
  if (isNaN(date.getTime())) return "";
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${y}/${m}/${day}`;
}

function fmtCents(c: number | null | undefined): string {
  if (c == null) return "";
  return centsToYuan(c).toFixed(2);
}

function safe(v: string | number | null | undefined): string {
  if (v == null) return "";
  return String(v).replace(/[\t\n\r]/g, " ");
}

/**
 * 台账导出口径下的"商品"判定：经 getProjectTypeLabel 规范化后等于"商品"。
 * 商品走 0/100 分期，其它（服务/预存款抵扣等）走 30/70——与 commit 的 ledgerCategory 一致。
 * 导出路由的应收分期计算也应复用此函数，避免分叉。
 */
export function isLedgerProductType(projectType: string | null | undefined): boolean {
  return getProjectTypeLabel(projectType) === "商品";
}

/**
 * 立项分期金额（分）：商品 0%，其它 30%。整数分运算（ratioCents，银行家舍入），符合 AGENTS.md 财务口径。
 */
export function depositCents(amountCents: number | null | undefined, projectType: string | null | undefined): number | null {
  if (amountCents == null) return null;
  if (isLedgerProductType(projectType)) return 0;
  return ratioCents(amountCents, 3, 10);
}

/**
 * 交付分期金额（分）：商品 100%，其它 70%。
 * 用 total − deposit 保证 立项款 + 交付款 == 项目金额（尾差吸收进交付款），
 * 且导出 AO 列（交付应收）与 R 列（交付进度款）永远同源同值。
 */
export function finalReceivableCents(amountCents: number | null | undefined, projectType: string | null | undefined): number | null {
  if (amountCents == null) return null;
  const deposit = depositCents(amountCents, projectType) ?? 0;
  return amountCents - deposit;
}

/** 进度款分期（导出列 Q/R、T/U）：分→元，整数分运算，立项+交付严格等于全额。 */
function progressPayment(cents: number | null | undefined, projectType: string | null | undefined, phase: "deposit" | "final"): string {
  if (cents == null) return "";
  const part = phase === "deposit" ? depositCents(cents, projectType) : finalReceivableCents(cents, projectType);
  return centsToYuan(part ?? 0).toFixed(2);
}

export function ledgerRowToTsv(r: LedgerExportRow): string {
  const inv0 = r.invoices[0];
  const inv1 = r.invoices[1];
  const rec0 = r.receipts[0];
  const rec1 = r.receipts[1];
  const invoiceNos = r.invoices.map((i) => i.invoiceNo).filter(Boolean).join("\\");

  const cols = [
    safe(r.projectNo),
    safe(r.orderNumber),
    safe(r.organization),
    safe(r.client),
    safe(r.representative),
    safe(r.techSupport),
    safe(getProjectTypeLabel(r.projectType)),
    safe(r.projectContent),
    r.quantity != null ? String(r.quantity) : "",
    safe(r.procurementSource),
    safe(r.brand),
    STATUS_MAP[r.status || ""] || safe(r.status),
    fmtDate(r.startDate),
    fmtDate(r.deliveredAt),
    fmtDate(r.terminatedAt),
    fmtCents(r.projectAmountCents),
    progressPayment(r.projectAmountCents, r.projectType, "deposit"),
    progressPayment(r.projectAmountCents, r.projectType, "final"),
    fmtCents(r.projectCostCents),
    progressPayment(r.projectCostCents, r.projectType, "deposit"),
    progressPayment(r.projectCostCents, r.projectType, "final"),
    r.projectAmountCents != null ? fmtCents((r.projectAmountCents) - (r.projectCostCents ?? 0)) : "",
    fmtCents(r.commissionPaidCents),
    fmtCents(r.quarterlyBonusCents),
    safe(r.remark),
    safe(r.sellerName),
    safe(r.buyerInvoiceOrgName),
    inv0 ? fmtCents(inv0.amountCents) : "",
    inv0 ? fmtDate(inv0.issuedAt) : "",
    inv1 ? fmtCents(inv1.amountCents) : "",
    inv1 ? fmtDate(inv1.issuedAt) : "",
    safe(invoiceNos),
    safe(r.receiptRemark),
    rec0 ? fmtCents(rec0.amountCents) : "",
    rec0 ? fmtDate(rec0.receivedAt) : "",
    rec0 ? safe(rec0.account) : "",
    rec1 ? fmtCents(rec1.amountCents) : "",
    rec1 ? fmtDate(rec1.receivedAt) : "",
    rec1 ? safe(rec1.account) : "",
    fmtCents(r.totalReceivableCents),
    fmtCents(r.finalReceivableCents),
    fmtCents(r.totalPayableCents),
    safe(r.attachmentFileName),
    safe(r.parentProjectNo),
  ];
  return cols.join("\t");
}

/** TSV 导出实现（§11.2）。 */
export class TsvLedgerExporter implements LedgerExporter {
  export(rows: LedgerExportRow[]): ExportResult {
    const lines = [LEDGER_EXPORT_HEADERS.join("\t"), ...rows.map(ledgerRowToTsv)];
    return { format: "tsv", content: lines.join("\n"), rowCount: rows.length };
  }
}

/**
 * 飞书 API 导出（§11.3，预留）。调用 lark-base 创建多维表格 + 写入记录。
 * 走"发送内容到外部服务"，执行前需用户确认；实现延后。
 */
export class FeishuLedgerExporter implements LedgerExporter {
  export(_rows: LedgerExportRow[]): ExportResult {
    void _rows;
    throw new Error("飞书 API 导出尚未实现（§11.3 预留）");
  }
}

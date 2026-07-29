import { getProjectTypeLabel } from "@/lib/project-type";

const FEISHU_PROJECT_HEADERS = [
  "项目号", "订单号", "对方单位", "客户", "代表", "技术支持",
  "项目类型", "项目内容", "数量", "采购渠道", "品牌", "项目进度",
  "立项时间", "交付时间", "终止时间",
  "项目金额（元）", "立项进度款（30%/0%）", "交付进度款（70%/100%）",
  "项目成本（元）", "立项成本（30%/0%）", "交付成本（70%/100%）",
];

const STATUS_MAP: Record<string, string> = {
  NOT_STARTED: "未开始",
  IN_PROGRESS: "进行中",
  COMPLETED: "已交付",
  ON_HOLD: "暂停",
  TERMINATED: "终止",
};

const ORDER_STATUS_MAP: Record<string, string> = {
  NONE: "未开票",
  DRAFT: "草稿",
  REQUESTED: "已申请",
  ISSUED: "已开票",
};

function fmtDate(d: string | Date | null | undefined): string {
  if (!d) return "";
  const date = typeof d === "string" ? new Date(d) : d;
  if (isNaN(date.getTime())) return "";
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${y}/${m}/${day}`;
}

function fmtAmount(n: number | null | undefined): string {
  if (n == null) return "";
  return n.toFixed(2);
}

function safe(v: string | number | null | undefined): string {
  if (v == null) return "";
  return String(v).replace(/[\t\n\r]/g, " ");
}

function progressPayment(amount: number | null | undefined, projectType: string | null | undefined, ratio: number): string {
  if (amount == null) return "";
  const type = getProjectTypeLabel(projectType);
  if (type === "商品") return ratio === 0 ? "0.00" : fmtAmount(amount);
  if (type === "服务") return ratio === 0 ? fmtAmount(amount * 0.3) : fmtAmount(amount * 0.7);
  return "";
}

export interface ProjectExportData {
  projectNo?: string | null;
  orderNumber?: string | null;
  organization?: string | null;
  client?: string | null;
  representative?: string | null;
  techSupport?: string | null;
  projectType?: string | null;
  projectContent?: string | null;
  description?: string | null;
  quantity?: number | null;
  procurementSource?: string | null;
  brand?: string | null;
  status?: string | null;
  startDate?: string | Date | null;
  endDate?: string | Date | null;
  budgetAmount?: number | null;
  budgetCost?: number | null;
}

export interface ExternalOrderExportData {
  externalOrderNo?: string | null;
  receiverName?: string | null;
  productNamesRaw?: string | null;
  itemCount?: number | null;
  orderAt?: string | Date | null;
  paidAmount?: number | null;
  invoiceStatus?: string | null;
}

export function getFeishuProjectHeader(): string {
  return FEISHU_PROJECT_HEADERS.join("\t");
}

export function projectToFeishuRow(p: ProjectExportData): string {
  const cols = [
    safe(p.projectNo),
    safe(p.orderNumber),
    safe(p.organization),
    safe(p.client),
    safe(p.representative),
    safe(p.techSupport),
    safe(getProjectTypeLabel(p.projectType)),
    safe(p.projectContent || p.description),
    p.quantity != null ? String(p.quantity) : "",
    safe(p.procurementSource),
    safe(p.brand),
    STATUS_MAP[p.status || ""] || safe(p.status),
    fmtDate(p.startDate),
    fmtDate(p.endDate),
    "",
    fmtAmount(p.budgetAmount),
    progressPayment(p.budgetAmount, p.projectType, 0),
    progressPayment(p.budgetAmount, p.projectType, 1),
    fmtAmount(p.budgetCost),
    progressPayment(p.budgetCost, p.projectType, 0),
    progressPayment(p.budgetCost, p.projectType, 1),
  ];
  return cols.join("\t");
}

export function projectsToFeishuText(projects: ProjectExportData[]): string {
  return projects.map(projectToFeishuRow).join("\n");
}

export function externalOrderToFeishuRow(o: ExternalOrderExportData): string {
  const cols = [
    safe(o.externalOrderNo),
    "",
    safe(o.receiverName),
    safe(o.receiverName),
    "",
    "",
    "商品",
    safe(o.productNamesRaw),
    o.itemCount != null ? String(o.itemCount) : "",
    "",
    "",
    ORDER_STATUS_MAP[o.invoiceStatus || ""] || "",
    fmtDate(o.orderAt),
    fmtDate(o.orderAt),
    "",
    fmtAmount(o.paidAmount),
    "0.00",
    fmtAmount(o.paidAmount),
    "",
    "",
    "",
  ];
  return cols.join("\t");
}

export function externalOrdersToFeishuText(orders: ExternalOrderExportData[]): string {
  return orders.map(externalOrderToFeishuRow).join("\n");
}


import type { CollectionSummaryMetrics } from "./collection-analysis";
import { isProductProjectType } from "@/lib/project-type";

export interface FinanceSummary {
  totalOnlineOrderAmount: number;
  matchedOnlineOrderAmount: number;
  unmatchedOnlineOrderAmount: number;
  totalProjectBudgetAmount: number;
  projectLinkedOrderAmount: number;
  standaloneOnlineOrderAmount: number;
  effectiveBusinessAmount: number;
  projectInvoicedAmount: number;
  orderInvoicedAmount: number;
  totalReceiptAmount: number;
  pendingInvoiceCount: number;
  customerCount: number;
  projectCount: number;
  receiptCount: number;
  weekProgressReceivable: number;
  monthProgressReceivable: number;
  weekServiceDeposit: number;
  weekServiceFinal: number;
  weekProductReceivable: number;
  monthServiceDeposit: number;
  monthServiceFinal: number;
  monthProductReceivable: number;
  costAmount: number;
  profitAmount: number;
  profitRate: number | null;
  unmatchedOrderCount: number;
  unmatchedOrderAmount: number;
  /** @deprecated 兼容旧字段；语义接近「无已登记票」的可开票订单，新口径请用 invoiceable* */
  uninvoicedOrderCount: number;
  uninvoicedOrderAmount: number;
  /** 可开票订单：remaining > 0；金额为剩余可开合计（订单分摊轴） */
  invoiceableOrderCount: number;
  invoiceableOrderAmount: number;
  /** 待提交：DRAFT 发票申请张数/整张金额（发票轴） */
  draftInvoiceCount: number;
  draftInvoiceAmount: number;
  /** 待登记：REQUESTED 发票申请张数/整张金额（发票轴） */
  requestedInvoiceCount: number;
  requestedInvoiceAmount: number;
  invoicedUnpaidOrderCount: number;
  invoicedUnpaidOrderAmount: number;
  /** 已结清订单：issued>=capacity 且无 DRAFT/REQUESTED 且 received>=issued */
  settledOrderCount: number;
  settledOrderAmount: number;
  advanceRefundPendingCount: number;
  advanceRefundPendingAmount: number;
  monthBusinessAmount: number;
  weekBusinessAmount: number;
  monthInvoicedAmount: number;
  monthReceiptAmount: number;
  monthReceiptCount: number;
  /**
   * 回款健康度：按「可见客户 ∪ 可见 standalone 订单」聚合（不含项目维度）。
   * ADMIN 全量；非 ADMIN 见 computeFinanceSummaryCollectionHealth。
   */
  avgCollectionCycleDays: number | null;
  collectionPairCount: number;
  rollingReceiptRate: number | null;
}

export interface CustomerFinanceItem {
  id: string;
  name: string;
  customerCode: string;
  organization: string | null;
  onlineOrderCount: number;
  onlineOrderTotalAmount: number;
  projectLinkedOrderAmount: number;
  standaloneOnlineOrderAmount: number;
  projectCount: number;
  projectBudgetTotalAmount: number;
  effectiveBusinessAmount: number;
  receivableAmount: number;
  projectInvoicedAmount: number;
  orderInvoicedAmount: number;
  totalReceiptAmount: number;
  outstandingAmount: number;
  avgCollectionCycleDays?: number | null;
  collectionPairCount?: number;
}

export interface CustomerFinanceDetail {
  customer: {
    id: string;
    name: string;
    customerCode: string;
    organization: string | null;
    wechat: string | null;
    principal: string | null;
  };
  summary: {
    onlineOrderTotal: number;
    standaloneOnlineOrderAmount: number;
    projectLinkedOrderAmount: number;
    projectBudgetTotal: number;
    effectiveBusinessAmount: number;
    receivableAmount: number;
    projectInvoicedAmount: number;
    orderInvoicedAmount: number;
    totalReceiptAmount: number;
    outstandingAmount: number;
  };
  onlineOrders: Array<{
    id: string;
    orderNo: string;
    totalAmount: number;
    orderedAt: string | null;
    customerMatchStatus: string;
    source: string;
    category: string;
    financeTreatment: string;
    financeAmountOverride: number | null;
  }>;
  projects: Array<{
    id: string;
    name: string;
    budgetAmount: number | null;
    status: string;
    progress: number;
  }>;
  projectInvoices: Array<{
    id: string;
    totalAmount: number;
    status: string;
    invoiceType: string;
    createdAt: string;
  }>;
  orderInvoices: Array<{
    id: string;
    totalAmount: number;
    status: string;
    invoiceType: string;
    createdAt: string;
  }>;
  receipts: Array<{
    id: string;
    amount: number;
    receivedAt: string;
    source: string;
    remark: string | null;
  }>;
  collectionSummary?: CollectionSummaryMetrics;
  hasMergedHistory?: boolean;
}

export interface MatchResult {
  orderId: string;
  externalOrderNo: string;
  status: "MATCHED" | "CONFLICT" | "UNMATCHED" | "MANUAL";
  score: number | null;
  matchedProfileId: string | null;
  matchedCustomerName: string | null;
  reason: string | null;
  candidates?: Array<{ profileId: string; name: string; score: number }>;
}

export interface MatchScanResult {
  scanned: number;
  matched: number;
  conflicted: number;
  unmatched: number;
  details: MatchResult[];
}

export interface FinanceCustomerListResponse {
  customers: CustomerFinanceItem[];
  total: number;
  page: number;
  pageSize: number;
}

export type MatchStatus = "UNMATCHED" | "AUTO_MATCHED" | "MANUAL_MATCHED" | "CONFLICT";

export function isProjectCompleted(project: { status: string; progress: number }): boolean {
  return project.status === "COMPLETED" || project.progress >= 100;
}

export function isProductProject(projectType: string | null | undefined): boolean {
  if (!projectType) return false;
  if (isProductProjectType(projectType)) return true;
  const t = projectType.toLowerCase();
  return t.includes("耗材") || t.includes("设备");
}

export function computeProjectReceivable(project: { budgetAmount?: number | null; projectType?: string | null; status: string; progress: number }): number {
  const budget = project.budgetAmount || 0;
  if (isProductProject(project.projectType)) return budget;
  if (isProjectCompleted(project)) return budget;
  return budget * 0.3;
}

import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { ORDER_FINANCE_TREATMENT } from "@/lib/orders/constants";
import { getOrderEffectiveTreatment } from "./progress";
import { getOrderInvoiceOccupancy } from "./order-invoice-amounts";
import { loadInvoiceOccupiedAmounts } from "./invoice-outstanding";
import { INVOICE_SOURCE_PRIORITY, type InvoiceDedupSource } from "./invoice-dedup";
export type InvoiceLinkType = InvoiceDedupSource;

export interface UnifiedOrderInvoice {
  id: string;
  status: string;
  totalAmount: number;
  allocatedAmount: number;
  invoiceType: string;
  contentSummary: string | null;
  buyerOrganizationName: string;
  buyerTaxId: string | null;
  sellerName: string | null;
  actualInvoiceNo: string | null;
  actualIssuedAt: Date | null;
  remark: string | null;
  createdAt: Date;
  createdBy: { id: string; name: string } | null;
  linkType: InvoiceLinkType;
  isLegacyLinked: boolean;
  orderId: string | null;
  externalOrderId: string | null;
  coveredOrders: Array<{ id: string; orderNo: string }>;
  items: Array<{
    id: string;
    itemName: string;
    spec: string | null;
    unit: string | null;
    quantity: number | null;
    amount: number;
    sortOrder: number;
  }>;
  _documentCount: number;
  _receiptAmount: number;
  adjustments?: Array<{ id: string; kind: string; reason: string | null; createdAt: Date }>;
}

const INVOICE_SELECT = {
  id: true,
  status: true,
  totalAmount: true,
  invoiceType: true,
  contentSummary: true,
  buyerOrganizationName: true,
  buyerTaxId: true,
  sellerName: true,
  actualInvoiceNo: true,
  actualIssuedAt: true,
  remark: true,
  createdAt: true,
  createdBy: { select: { id: true, name: true } },
  orderId: true,
  externalOrderId: true,
  items: { select: { id: true, itemName: true, spec: true, unit: true, quantity: true, amount: true, sortOrder: true }, orderBy: { sortOrder: "asc" } },
  orderCoverage: { select: { orderId: true, amount: true, order: { select: { id: true, orderNo: true } } } },
  coverage: { select: { externalOrder: { select: { id: true } } } },
  documents: { select: { id: true } },
  receipts: { where: { deleted: false }, select: { amount: true } },
  allocations: { where: { receipt: { deleted: false } }, select: { amount: true } },
  adjustmentsAsOriginal: { select: { id: true, kind: true, reason: true, createdAt: true } },
} as const;

export async function getInvoicesForOrder(
  orderId: string,
): Promise<UnifiedOrderInvoice[]> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { legacyExternalOrderId: true },
  });
  const legacyExtId = order?.legacyExternalOrderId ?? null;

  // 收集四路发票及其来源，统一按优先级去重：COVERAGE > DIRECT > LEGACY_DIRECT > LEGACY_COVERAGE
  const candidates = new Map<string, { source: InvoiceLinkType; raw: typeof INVOICE_SELECT extends object ? unknown : never }>();
  const sourceOf = new Map<string, InvoiceLinkType>();

  const tryInsert = (invoiceId: string, source: InvoiceLinkType, raw: unknown) => {
    const existing = sourceOf.get(invoiceId);
    if (!existing || INVOICE_SOURCE_PRIORITY[source] < INVOICE_SOURCE_PRIORITY[existing]) {
      sourceOf.set(invoiceId, source);
      candidates.set(invoiceId, { source, raw });
    }
  };

  // 1. Direct orderId invoices
  const directInvoices = await prisma.externalOrderInvoiceRequest.findMany({
    where: { orderId },
    select: INVOICE_SELECT,
    orderBy: { createdAt: "desc" },
  });
  for (const inv of directInvoices) {
    tryInsert(inv.id, "DIRECT", inv);
  }

  // 2. OrderInvoiceCoverage invoices（分摊表事实源，优先级最高）
  const coverageRecords = await prisma.orderInvoiceCoverage.findMany({
    where: { orderId },
    select: { invoiceRequest: { select: INVOICE_SELECT } },
  });
  for (const c of coverageRecords) {
    const inv = c.invoiceRequest;
    if (!inv) continue;
    tryInsert(inv.id, "COVERAGE", inv);
  }

  // 3. Legacy direct externalOrderId invoices
  if (legacyExtId) {
    const legacyDirect = await prisma.externalOrderInvoiceRequest.findMany({
      where: { externalOrderId: legacyExtId },
      select: INVOICE_SELECT,
      orderBy: { createdAt: "desc" },
    });
    for (const inv of legacyDirect) {
      tryInsert(inv.id, "LEGACY_DIRECT", inv);
    }

    // 4. Legacy ExternalOrderInvoiceCoverage invoices
    const legacyCoverageRecords = await prisma.externalOrderInvoiceCoverage.findMany({
      where: { externalOrderId: legacyExtId },
      select: { invoiceRequest: { select: INVOICE_SELECT } },
    });
    for (const c of legacyCoverageRecords) {
      const inv = c.invoiceRequest;
      if (!inv) continue;
      tryInsert(inv.id, "LEGACY_COVERAGE", inv);
    }
  }

  const invoices: UnifiedOrderInvoice[] = [];
  for (const [invoiceId, { source, raw }] of candidates) {
    invoices.push(normalizeInvoice(raw as Parameters<typeof normalizeInvoice>[0], source, orderId));
  }

  return invoices.sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
  );
}

function normalizeInvoice(
  raw: {
    id: string;
    status: string;
    totalAmount: number;
    invoiceType: string;
    contentSummary: string | null;
    buyerOrganizationName: string;
    buyerTaxId: string | null;
    sellerName: string | null;
    actualInvoiceNo: string | null;
    actualIssuedAt: Date | null;
    remark: string | null;
    createdAt: Date;
    createdBy: { id: string; name: string } | null;
    orderId: string | null;
    externalOrderId: string | null;
    items: Array<{
      id: string;
      itemName: string;
      spec: string | null;
      unit: string | null;
      quantity: number | null;
      amount: number;
      sortOrder: number;
    }>;
    orderCoverage: Array<{ order: { id: string; orderNo: string } | null; amount: number | null }>;
    coverage: Array<{ externalOrder: { id: string } | null }>;
    documents: Array<{ id: string }>;
    receipts: Array<{ amount: number }>;
    allocations?: Array<{ amount: number }>;
    adjustmentsAsOriginal?: Array<{ id: string; kind: string; reason: string | null; createdAt: Date }>;
  },
  linkType: InvoiceLinkType,
  targetOrderId: string,
): UnifiedOrderInvoice {
  const coveredOrders = raw.orderCoverage
    .map((c) => c.order)
    .filter((o): o is { id: string; orderNo: string } => o != null);

  // §4.1: 直接读取当前订单对应的 coverage.amount 作为 allocatedAmount
  const selfCoverage = raw.orderCoverage.find((c) => c.order?.id === targetOrderId);
  const allocatedAmount = selfCoverage?.amount ?? raw.totalAmount;

  return {
    id: raw.id,
    status: raw.status,
    totalAmount: raw.totalAmount,
    allocatedAmount,
    invoiceType: raw.invoiceType,
    contentSummary: raw.contentSummary,
    buyerOrganizationName: raw.buyerOrganizationName,
    buyerTaxId: raw.buyerTaxId,
    sellerName: raw.sellerName,
    actualInvoiceNo: raw.actualInvoiceNo,
    actualIssuedAt: raw.actualIssuedAt,
    remark: raw.remark,
    createdAt: raw.createdAt,
    createdBy: raw.createdBy,
    linkType,
    isLegacyLinked: linkType.startsWith("LEGACY"),
    orderId: raw.orderId,
    externalOrderId: raw.externalOrderId,
    coveredOrders,
    items: raw.items,
    _documentCount: raw.documents.length,
    _receiptAmount:
      raw.receipts.reduce((s, r) => s + r.amount, 0) +
      (raw.allocations || []).reduce((s, a) => s + a.amount, 0),
    adjustments: raw.adjustmentsAsOriginal,
  };
}

/**
 * Check if an invoice is occupied by any receipt (new allocation or legacy 1-to-1).
 * Returns the occupied amount, or 0 if the invoice is free.
 * Per §9.1 / invoice-outstanding：allocation + 无 allocation 的 legacy receipt。
 */
export async function getInvoiceOccupiedAmount(invoiceId: string): Promise<number> {
  const map = await loadInvoiceOccupiedAmounts([invoiceId]);
  return map.get(invoiceId) || 0;
}

/**
 * Assert invoice is not occupied. Throws { status: 409, body } if occupied.
 * Used by RED / REISSUE routes per §9.1.
 */
export async function assertInvoiceNotOccupied(invoiceId: string): Promise<void> {
  const occupied = await getInvoiceOccupiedAmount(invoiceId);
  if (occupied > 0) {
    throw Object.assign(new Error("INVOICE_OCCUPIED"), {
      status: 409,
      body: {
        error: "INVOICE_OCCUPIED",
        message: "该发票已有回款核销，请先撤销核销再冲红",
        occupiedAmount: occupied,
      },
    });
  }
}

/**
 * 校验被发票覆盖的所有订单（touched orders）满足开票前置条件：
 *  - 订单存在且未删除
 *  - financeTreatment 有效：EXCLUDED 默认禁止开票；PROJECT_INCLUDED 默认禁止订单侧单独开票
 *    （除非显式传入 allowProjectIncludedInvoice=true）
 *  - 有结构化购买方机构 buyerOrganizationId（机构不猜测，§0.1）
 *  - 本次开票金额不超过每个订单的剩余可开票额度
 *  - 除非 allowCrossOrgInvoice，否则所有 touched 订单必须同属一个购买方机构
 *
 * 共享给 POST（创建）与 REISSUE（重开）路由，保证两条路径校验一致。
 * reissue 时传入 excludeInvoiceId 跳过"正在被重开的原发票"自身额度占用。
 *
 * 返回 { ok: true } 或 { ok: false, status, body }（可直接作为 NextResponse 参数）。
 */
export async function validateTouchedOrders(
  touchedOrderIds: string[],
  allocations: Map<string, number>,
  opts: { allowCrossOrgInvoice?: boolean; allowProjectIncludedInvoice?: boolean; excludeInvoiceId?: string; tx?: Prisma.TransactionClient } = {},
): Promise<{ ok: true } | { ok: false; status: number; body: Record<string, unknown> }> {
  const { allowCrossOrgInvoice = false, allowProjectIncludedInvoice = false, excludeInvoiceId } = opts;
  const client = opts.tx ?? prisma;

  const touchedOrgs = new Map<string, string>();
  const touchedOrgNames = new Set<string>();

  for (const cid of touchedOrderIds) {
    const co = await client.order.findUnique({
      where: { id: cid, deleted: false },
      select: {
        id: true,
        buyerOrganizationId: true,
        financeTreatment: true,
        _count: { select: { projectLinks: true } },
        buyerOrganization: { select: { canonicalName: true } },
      },
    });
    if (!co) {
      return { ok: false, status: 400, body: { error: `订单 ${cid.slice(-6)} 不存在` } };
    }

    const effectiveTreatment = getOrderEffectiveTreatment(co.financeTreatment, co._count.projectLinks > 0);
    if (effectiveTreatment === ORDER_FINANCE_TREATMENT.EXCLUDED) {
      return {
        ok: false,
        status: 400,
        body: {
          error: `订单 ${cid.slice(-6)} 财务处理方式为 EXCLUDED，默认不允许开票`,
          code: "FINANCE_TREATMENT_EXCLUDED",
          orderId: cid,
        },
      };
    }
    if (effectiveTreatment === ORDER_FINANCE_TREATMENT.PROJECT_INCLUDED && !allowProjectIncludedInvoice) {
      return {
        ok: false,
        status: 400,
        body: {
          error: `订单 ${cid.slice(-6)} 金额已计入项目侧，订单侧默认不允许单独开票，请联系财务/产品确认`,
          code: "PROJECT_INCLUDED_INVOICE_BLOCKED",
          orderId: cid,
        },
      };
    }

    if (!co.buyerOrganizationId) {
      return {
        ok: false,
        status: 400,
        body: { error: `订单 ${cid.slice(-6)} 缺少结构化购买方机构，请先补绑`, code: "ORDER_BUYER_ORG_REQUIRED", orderId: cid },
      };
    }
    touchedOrgs.set(cid, co.buyerOrganizationId);
    if (co.buyerOrganization?.canonicalName) touchedOrgNames.add(co.buyerOrganization.canonicalName);

    // 剩余可开票额度校验：本次分摊金额不得超过剩余额度
    const occupancy = await getOrderInvoiceOccupancy(cid, {
      activeOnly: true,
      excludeInvoiceId,
      tx: opts.tx,
    });
    const allocating = allocations.get(cid) ?? 0;
    if (allocating > occupancy.remaining) {
      return {
        ok: false,
        status: 400,
        body: {
          code: "INVOICEABLE_EXCEEDED",
          orderId: cid,
          capacity: occupancy.capacity,
          occupied: occupancy.occupied,
          remaining: occupancy.remaining,
          allocating,
          activeInvoices: occupancy.rows,
        },
      };
    }
  }

  // 跨购买方机构校验：touched orders 必须同属一个 buyerOrganizationId，除非显式 allowCrossOrgInvoice。
  const distinctOrgIds = [...new Set([...touchedOrgs.values()].filter(Boolean))];
  if (distinctOrgIds.length > 1 && !allowCrossOrgInvoice) {
    return {
      ok: false,
      status: 400,
      body: {
        error: "选中订单分属多个购买方机构，默认不能合并成一张发票。请按购买方机构分组，或确认第三方/代付合单。",
        code: "CROSS_ORG_INVOICE",
        distinctOrgs: [...touchedOrgNames],
      },
    };
  }

  return { ok: true };
}

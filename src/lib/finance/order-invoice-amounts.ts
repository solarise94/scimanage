import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { ORDER_FINANCE_TREATMENT } from "@/lib/orders/constants";
import { getOrderEffectiveTreatment } from "./progress";
import { collectByChunks } from "./query-chunk";
import { deduplicateInvoicesByPriority, type InvoiceDedupSource, type InvoiceDedupEntry } from "./invoice-dedup";

export type OrderInvoiceOccupancySource = InvoiceDedupSource;

export type OrderInvoiceOccupancy = {
  invoiceId: string;
  status: string;
  amountCents: number;
  source: OrderInvoiceOccupancySource;
};

type InvoiceAdjustmentDto = { kind: string };

const ACTIVE_STATUSES = ["DRAFT", "REQUESTED", "ISSUED"];

function isInvoiceActive(status: string, adjustments: InvoiceAdjustmentDto[]): boolean {
  if (!ACTIVE_STATUSES.includes(status)) return false;
  return !adjustments.some((a) => a.kind === "RED" || a.kind === "REISSUE");
}

/**
 * 计算某个订单当前被发票占用的额度。
 *
 * 收集四路可能触达该订单的发票：
 * 1. DIRECT: ExternalOrderInvoiceRequest.orderId
 * 2. COVERAGE: OrderInvoiceCoverage.orderId（分摊表事实源，优先于 DIRECT）
 * 3. LEGACY_DIRECT: ExternalOrderInvoiceRequest.externalOrderId = order.legacyExternalOrderId
 * 4. LEGACY_COVERAGE: ExternalOrderInvoiceCoverage.externalOrderId = order.legacyExternalOrderId
 *
 * 去重规则：按 invoiceId 去重；coverage 金额覆盖 direct 金额；legacy coverage 无 amount 字段，
 * fallback 到发票 totalAmount（与 legacy direct 一致）。
 *
 * active 定义：status 为 DRAFT/REQUESTED/ISSUED 且没有被 RED/REISSUE 调整。
 */
export async function getOrderInvoiceOccupancy(
  orderId: string,
  opts?: {
    statuses?: string[];
    excludeInvoiceId?: string;
    activeOnly?: boolean;
    tx?: Prisma.TransactionClient;
  },
): Promise<{ capacity: number; occupied: number; remaining: number; rows: OrderInvoiceOccupancy[] }> {
  const client = opts?.tx ?? prisma;

  const order = await client.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      deleted: true,
      legacyExternalOrderId: true,
      totalAmount: true,
      financeAmountOverride: true,
      financeTreatment: true,
      _count: { select: { projectLinks: true } },
    },
  });

  if (!order || order.deleted) {
    return { capacity: 0, occupied: 0, remaining: 0, rows: [] };
  }

  const effectiveTreatment = getOrderEffectiveTreatment(order.financeTreatment, order._count.projectLinks > 0);
  const capacity =
    effectiveTreatment === ORDER_FINANCE_TREATMENT.EXCLUDED || effectiveTreatment === ORDER_FINANCE_TREATMENT.PROJECT_INCLUDED
      ? 0
      : (order.financeAmountOverride ?? order.totalAmount);
  const allRows: (InvoiceDedupEntry & { adjustments: InvoiceAdjustmentDto[] })[] = [];
  const adjustmentSelect = { select: { kind: true } } as const;

  // 1. Direct orderId invoices
  const directInvoices = await client.externalOrderInvoiceRequest.findMany({
    where: { orderId },
    select: { id: true, status: true, totalAmount: true, adjustmentsAsOriginal: adjustmentSelect },
  });
  for (const inv of directInvoices) {
    allRows.push({ invoiceId: inv.id, status: inv.status, amountCents: inv.totalAmount, source: "DIRECT", adjustments: inv.adjustmentsAsOriginal });
  }

  // 2. OrderInvoiceCoverage invoices（分摊表事实源，优先级最高）
  const coverageRecords = await client.orderInvoiceCoverage.findMany({
    where: { orderId },
    select: {
      amount: true,
      invoiceRequest: { select: { id: true, status: true, totalAmount: true, adjustmentsAsOriginal: adjustmentSelect } },
    },
  });
  for (const c of coverageRecords) {
    if (!c.invoiceRequest) continue;
    allRows.push({ invoiceId: c.invoiceRequest.id, status: c.invoiceRequest.status, amountCents: c.amount, source: "COVERAGE", adjustments: c.invoiceRequest.adjustmentsAsOriginal });
  }

  // 3. Legacy invoices
  if (order.legacyExternalOrderId) {
    const legacyId = order.legacyExternalOrderId;

    const legacyDirect = await client.externalOrderInvoiceRequest.findMany({
      where: { externalOrderId: legacyId },
      select: { id: true, status: true, totalAmount: true, adjustmentsAsOriginal: adjustmentSelect },
    });
    for (const inv of legacyDirect) {
      allRows.push({ invoiceId: inv.id, status: inv.status, amountCents: inv.totalAmount, source: "LEGACY_DIRECT", adjustments: inv.adjustmentsAsOriginal });
    }

    const legacyCoverageRecords = await client.externalOrderInvoiceCoverage.findMany({
      where: { externalOrderId: legacyId },
      select: {
        invoiceRequest: { select: { id: true, status: true, totalAmount: true, adjustmentsAsOriginal: adjustmentSelect } },
      },
    });
    for (const c of legacyCoverageRecords) {
      if (!c.invoiceRequest) continue;
      allRows.push({ invoiceId: c.invoiceRequest.id, status: c.invoiceRequest.status, amountCents: c.invoiceRequest.totalAmount, source: "LEGACY_COVERAGE", adjustments: c.invoiceRequest.adjustmentsAsOriginal });
    }
  }

  // 统一去重：COVERAGE > DIRECT > LEGACY_DIRECT > LEGACY_COVERAGE
  const deduped = deduplicateInvoicesByPriority(allRows);

  let rows: OrderInvoiceOccupancy[] = deduped.map((r) => ({
    invoiceId: r.invoiceId,
    status: r.status,
    amountCents: r.amountCents,
    source: r.source,
  }));

  if (opts?.activeOnly) {
    const adjMap = new Map(deduped.map((r) => [r.invoiceId, r.adjustments]));
    rows = rows.filter((r) => isInvoiceActive(r.status, adjMap.get(r.invoiceId)!));
  }
  if (opts?.statuses) {
    rows = rows.filter((r) => opts.statuses!.includes(r.status));
  }
  if (opts?.excludeInvoiceId) {
    rows = rows.filter((r) => r.invoiceId !== opts.excludeInvoiceId);
  }

  const occupied = rows.reduce((sum, r) => sum + r.amountCents, 0);
  const remaining = Math.max(0, capacity - occupied);

  return { capacity, occupied, remaining, rows };
}

export interface OrderInvoiceSummary {
  invoiceCount: number;
  invoiceStatusSummary: Record<string, number>;
  /** 订单可开票额度（capacity），单位元。PROJECT_INCLUDED/EXCLUDED 为 0。 */
  invoiceCapacityAmount: number;
  /** 已开票金额（ISSUED），单位元。 */
  invoicedAmount: number;
  /** 待开票申请金额（REQUESTED），单位元。 */
  invoiceRequestedAmount: number;
  /** 草稿占用金额（DRAFT），单位元。 */
  invoiceDraftAmount: number;
  /** 活跃发票占用的总开票额度（DRAFT+REQUESTED+ISSUED），单位元。 */
  invoiceOccupiedAmount: number;
  /** 剩余可开票额度，单位元。 */
  invoiceRemainingAmount: number;
}

/**
 * 批量计算多个订单的发票摘要。
 *
 * 复用 getOrderInvoiceOccupancy 的四路收集与去重优先级：
 * COVERAGE > DIRECT > LEGACY_COVERAGE > LEGACY_DIRECT。
 * 仅统计 active 发票：status 为 DRAFT/REQUESTED/ISSUED 且未被 RED/REISSUE 调整。
 *
 * 返回金额均为元（centsToYuan），方便 API 直接输出给 UI。
 */
export async function getOrderInvoiceSummaryBatch(
  orderIds: string[],
  opts?: { tx?: Prisma.TransactionClient },
): Promise<Map<string, OrderInvoiceSummary>> {
  const client = opts?.tx ?? prisma;
  const result = new Map<string, OrderInvoiceSummary>();
  if (orderIds.length === 0) return result;

  const orders = await client.order.findMany({
    where: { id: { in: orderIds }, deleted: false },
    select: {
      id: true,
      totalAmount: true,
      financeAmountOverride: true,
      financeTreatment: true,
      legacyExternalOrderId: true,
      _count: { select: { projectLinks: true } },
    },
  });

  // capacityCents per order
  const capacityMap = new Map<string, number>();
  for (const o of orders) {
    const effectiveTreatment = getOrderEffectiveTreatment(o.financeTreatment, o._count.projectLinks > 0);
    const capacity =
      effectiveTreatment === ORDER_FINANCE_TREATMENT.EXCLUDED || effectiveTreatment === ORDER_FINANCE_TREATMENT.PROJECT_INCLUDED
        ? 0
        : (o.financeAmountOverride ?? o.totalAmount);
    capacityMap.set(o.id, capacity);
  }

  type RawRow = InvoiceDedupEntry & { adjustments: InvoiceAdjustmentDto[] };

  // per-order rows before dedup
  const rowsByOrder = new Map<string, RawRow[]>();
  const appendRow = (orderId: string | null, row: RawRow) => {
    if (!orderId) return;
    let arr = rowsByOrder.get(orderId);
    if (!arr) { arr = []; rowsByOrder.set(orderId, arr); }
    arr.push(row);
  };

  const adjustmentSelect = { select: { kind: true } } as const;

  // COVERAGE（分摊表事实源，优先级最高）
  const coverageRows = await collectByChunks(orderIds, (chunk) =>
    client.orderInvoiceCoverage.findMany({
      where: { orderId: { in: chunk } },
      select: {
        orderId: true,
        amount: true,
        invoiceRequest: {
          select: { id: true, status: true, totalAmount: true, adjustmentsAsOriginal: adjustmentSelect },
        },
      },
    })
  );
  for (const c of coverageRows) {
    if (!c.invoiceRequest || !c.orderId) continue;
    appendRow(c.orderId, {
      invoiceId: c.invoiceRequest.id,
      status: c.invoiceRequest.status,
      amountCents: c.amount,
      source: "COVERAGE",
      adjustments: c.invoiceRequest.adjustmentsAsOriginal,
    });
  }

  // DIRECT
  const directRows = await collectByChunks(orderIds, (chunk) =>
    client.externalOrderInvoiceRequest.findMany({
      where: { orderId: { in: chunk } },
      select: {
        id: true,
        orderId: true,
        status: true,
        totalAmount: true,
        adjustmentsAsOriginal: adjustmentSelect,
      },
    })
  );
  for (const inv of directRows) {
    if (!inv.orderId) continue;
    appendRow(inv.orderId, {
      invoiceId: inv.id,
      status: inv.status,
      amountCents: inv.totalAmount,
      source: "DIRECT",
      adjustments: inv.adjustmentsAsOriginal,
    });
  }

  // Legacy mapping
  const legacyIdToOrderIds = new Map<string, string[]>();
  for (const o of orders) {
    if (!o.legacyExternalOrderId) continue;
    const list = legacyIdToOrderIds.get(o.legacyExternalOrderId) ?? [];
    list.push(o.id);
    legacyIdToOrderIds.set(o.legacyExternalOrderId, list);
  }
  const legacyIds = [...legacyIdToOrderIds.keys()];

  if (legacyIds.length > 0) {
    // LEGACY_DIRECT
    const legacyDirectRows = await collectByChunks(legacyIds, (chunk) =>
      client.externalOrderInvoiceRequest.findMany({
        where: { externalOrderId: { in: chunk } },
        select: {
          id: true,
          externalOrderId: true,
          status: true,
          totalAmount: true,
          adjustmentsAsOriginal: adjustmentSelect,
        },
      })
    );
    for (const inv of legacyDirectRows) {
      if (!inv.externalOrderId) continue;
      for (const oid of legacyIdToOrderIds.get(inv.externalOrderId) ?? []) {
        appendRow(oid, {
          invoiceId: inv.id,
          status: inv.status,
          amountCents: inv.totalAmount,
          source: "LEGACY_DIRECT",
          adjustments: inv.adjustmentsAsOriginal,
        });
      }
    }

    // LEGACY_COVERAGE
    const legacyCoverageRows = await collectByChunks(legacyIds, (chunk) =>
      client.externalOrderInvoiceCoverage.findMany({
        where: { externalOrderId: { in: chunk } },
        select: {
          externalOrderId: true,
          invoiceRequest: {
            select: { id: true, status: true, totalAmount: true, adjustmentsAsOriginal: adjustmentSelect },
          },
        },
      })
    );
    for (const c of legacyCoverageRows) {
      if (!c.invoiceRequest || !c.externalOrderId) continue;
      for (const oid of legacyIdToOrderIds.get(c.externalOrderId) ?? []) {
        appendRow(oid, {
          invoiceId: c.invoiceRequest.id,
          status: c.invoiceRequest.status,
          amountCents: c.invoiceRequest.totalAmount,
          source: "LEGACY_COVERAGE",
          adjustments: c.invoiceRequest.adjustmentsAsOriginal,
        });
      }
    }
  }

  // 统一去重：COVERAGE > DIRECT > LEGACY_DIRECT > LEGACY_COVERAGE
  for (const o of orders) {
    const rows = rowsByOrder.get(o.id) ?? [];
    const deduped = deduplicateInvoicesByPriority(rows);

    const activeRows = deduped.filter((r) =>
      ACTIVE_STATUSES.includes(r.status) && !r.adjustments.some((a) => a.kind === "RED" || a.kind === "REISSUE"),
    );

    const statusSummary: Record<string, number> = {};
    let invoicedCents = 0;
    let requestedCents = 0;
    let draftCents = 0;
    for (const r of activeRows) {
      statusSummary[r.status] = (statusSummary[r.status] ?? 0) + 1;
      if (r.status === "ISSUED") invoicedCents += r.amountCents;
      else if (r.status === "REQUESTED") requestedCents += r.amountCents;
      else if (r.status === "DRAFT") draftCents += r.amountCents;
    }

    const occupiedCents = invoicedCents + requestedCents + draftCents;
    const capacity = capacityMap.get(o.id) ?? 0;
    const remainingCents = Math.max(0, capacity - occupiedCents);

    result.set(o.id, {
      invoiceCount: activeRows.length,
      invoiceStatusSummary: statusSummary,
      invoiceCapacityAmount: capacity / 100,
      invoicedAmount: invoicedCents / 100,
      invoiceRequestedAmount: requestedCents / 100,
      invoiceDraftAmount: draftCents / 100,
      invoiceOccupiedAmount: occupiedCents / 100,
      invoiceRemainingAmount: remainingCents / 100,
    });
  }

  return result;
}

/** 分 → 元比较用：把元金额还原为整数分，避免浮点误判。 */
export function yuanAmountToCents(yuan: number): number {
  return Math.round(yuan * 100);
}

/** 已结清：票按 capacity 登满、无在途申请、款相对已登记票已齐。 */
export function isOrderSettled(args: {
  profileId: string | null | undefined;
  capacityYuan: number;
  issuedYuan: number;
  draftYuan: number;
  requestedYuan: number;
  receivedYuan: number;
}): boolean {
  if (args.profileId == null) return false;
  const capacity = yuanAmountToCents(args.capacityYuan);
  const issued = yuanAmountToCents(args.issuedYuan);
  const draft = yuanAmountToCents(args.draftYuan);
  const requested = yuanAmountToCents(args.requestedYuan);
  const received = yuanAmountToCents(args.receivedYuan);
  return (
    capacity > 0 &&
    issued >= capacity &&
    draft === 0 &&
    requested === 0 &&
    received >= issued
  );
}

/** 可开票：有客户且剩余可开额度 > 0。 */
export function isOrderInvoiceable(args: {
  profileId: string | null | undefined;
  remainingYuan: number;
}): boolean {
  return args.profileId != null && yuanAmountToCents(args.remainingYuan) > 0;
}

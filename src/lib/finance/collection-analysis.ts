import { prisma } from "@/lib/prisma";
import { ratioCents } from "@/lib/finance/money";
import {
  computeOrderFinanceAmount,
  getOrderDate,
  getOrderEffectiveTreatment,
  getProjectStartDate,
  getQuarterRange,
  getYearRange,
} from "@/lib/finance/progress";
import { isProductProject } from "@/lib/finance/types";
import { buildOrderProjectLinkMap } from "@/lib/finance/order-project-links";

export const DEFAULT_COLLECTION_WINDOW_MONTHS = 24;
export const RECEIVABLE_BELOW_THRESHOLD_CENTS = 1_000_000;
export const MIN_CYCLE_PAIR_COUNT = 3;

const ACTIVE_INVOICE_ADJUSTMENT_FILTER = {
  none: { kind: { in: ["RED", "REISSUE"] } },
};

export type CollectionPair = {
  receiptId: string;
  invoiceId: string;
  issuedAt: Date;
  receivedAt: Date;
  cycleDays: number;
  usedFallback: boolean;
  amount: number;
  organizationId: string | null;
  orderId: string | null;
  profileId: string | null;
};

/**
 * Aggregation scope for receivable/receipt totals.
 *
 * 支持 Profile 主权与订单两个维度：
 * - `profileIds`：财务客户视图使用的 Profile 主权口径。
 * - `orderIds`：standalone 订单维度（机构维度经 buyerOrganizationId→orderId 归属后传入）。
 *
 * 不提供 `projectIds`：回款配对（CollectionPair）没有 projectId 维度，
 * 项目维度的应收/回款无法对称配对，强行支持会得到"应收有、回款恒为 0"的半成品口径。
 * 如未来要做项目维度，需先给 CollectionPair 补 projectId 并打通项目侧回款归属。
 */
export type CollectionScope = {
  profileIds?: string[];
  orderIds?: string[];
};

export type CollectionCycleStats = {
  avgCycleDays: number | null;
  pairCount: number;
  excludedNegativeCycleCount: number;
  usedFallbackCount: number;
};

export type PeriodReceivableResult = {
  receivableCents: number;
  belowThreshold: boolean;
};

export type CollectionRateMetrics = {
  receiptRate: number | null;
  receiptAmount: number;
  receivableAmount: number;
  belowThreshold: boolean;
};

export type CollectionSummaryMetrics = {
  avgCollectionCycleDays: number | null;
  collectionPairCount: number;
  excludedNegativeCycleCount: number;
  usedFallbackCount: number;
  quarterlyReceiptRate: number | null;
  quarterlyReceiptAmount: number;
  quarterlyReceivableAmount: number;
  quarterlyBelowThreshold: boolean;
  yearlyReceiptRate: number | null;
  yearlyReceiptAmount: number;
  yearlyReceivableAmount: number;
  yearlyBelowThreshold: boolean;
  rollingReceiptRate?: number | null;
  rollingReceiptAmount?: number;
  rollingReceivableAmount?: number;
  rollingBelowThreshold?: boolean;
};

export function getDefaultReceivedSince(now = new Date()): Date {
  const d = new Date(now);
  d.setMonth(d.getMonth() - DEFAULT_COLLECTION_WINDOW_MONTHS);
  d.setHours(0, 0, 0, 0);
  return d;
}

export function getRollingWindowRanges(now = new Date()) {
  const receivedStart = new Date(now);
  receivedStart.setDate(receivedStart.getDate() - 90);
  receivedStart.setHours(0, 0, 0, 0);
  const orderStart = new Date(now);
  orderStart.setDate(orderStart.getDate() - 180);
  orderStart.setHours(0, 0, 0, 0);
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  return { receivedStart, orderStart, end };
}

function pairMatchesScope(pair: CollectionPair, scope?: CollectionScope): boolean {
  if (!scope) return true;
  const { profileIds, orderIds } = scope;
  if (!profileIds?.length && !orderIds?.length) return true;
  if (profileIds?.length && pair.profileId && profileIds.includes(pair.profileId)) return true;
  if (orderIds?.length && pair.orderId && orderIds.includes(pair.orderId)) return true;
  return false;
}

function computeCollectionRate(
  receiptCents: number,
  receivableCents: number,
  belowThreshold: boolean,
): CollectionRateMetrics {
  return {
    receiptAmount: receiptCents,
    receivableAmount: receivableCents,
    belowThreshold,
    receiptRate:
      belowThreshold || receivableCents <= 0
        ? null
        : receiptCents / receivableCents,
  };
}

export function getCollectionCycleStats(pairs: CollectionPair[]): CollectionCycleStats {
  let excludedNegativeCycleCount = 0;
  let usedFallbackCount = 0;
  const validCycles: number[] = [];

  for (const pair of pairs) {
    if (pair.usedFallback) usedFallbackCount += 1;
    if (pair.cycleDays < 0) {
      excludedNegativeCycleCount += 1;
      continue;
    }
    validCycles.push(pair.cycleDays);
  }

  const pairCount = validCycles.length;
  const avgCycleDays =
    pairCount >= MIN_CYCLE_PAIR_COUNT
      ? Math.round((validCycles.reduce((s, d) => s + d, 0) / pairCount) * 10) / 10
      : null;

  return { avgCycleDays, pairCount, excludedNegativeCycleCount, usedFallbackCount };
}

function computeProjectProgressReceivableInCents(
  project: {
    budgetAmount: number | null;
    projectType: string | null;
    startDate: Date | string | null;
    createdAt: Date | string;
    completionDate: Date | null;
  },
  periodStart: Date,
  periodEnd: Date,
): number {
  const budget = project.budgetAmount ?? 0;
  const startDate = getProjectStartDate(project);
  const startedInPeriod = startDate >= periodStart && startDate <= periodEnd;
  const completedInPeriod = project.completionDate
    ? project.completionDate >= periodStart && project.completionDate <= periodEnd
    : false;

  if (isProductProject(project.projectType)) {
    return startedInPeriod ? budget : 0;
  }

  if (startedInPeriod && completedInPeriod) {
    return ratioCents(budget, 3, 10) + ratioCents(budget, 7, 10);
  }
  if (startedInPeriod) return ratioCents(budget, 3, 10);
  if (completedInPeriod) return ratioCents(budget, 7, 10);
  return 0;
}

function computeStandaloneOrderReceivableInCents(
  order: {
    totalAmount: number;
    financeAmountOverride: number | null;
    category: string;
    financeTreatment: string;
    hasProjectLinks: boolean;
    orderedAt: Date | string | null;
    confirmedAt: Date | string | null;
    createdAt: Date | string;
  },
  periodStart: Date,
  periodEnd: Date,
): number {
  const treatment = getOrderEffectiveTreatment(order.financeTreatment, order.hasProjectLinks);
  if (treatment === "PROJECT_INCLUDED" || treatment === "EXCLUDED") return 0;

  const orderDate = getOrderDate(order);
  if (orderDate < periodStart || orderDate > periodEnd) return 0;

  const amount = computeOrderFinanceAmount(order);
  if (order.category === "PRODUCT") return amount;
  return ratioCents(amount, 3, 10);
}

export async function getCollectionPairs(filter?: {
  receivedSince?: Date;
  receivedUntil?: Date;
}): Promise<CollectionPair[]> {
  const receivedSince = filter?.receivedSince ?? getDefaultReceivedSince();
  const receivedUntil = filter?.receivedUntil;
  const receivedAtFilter: { gte: Date; lte?: Date } = { gte: receivedSince };
  if (receivedUntil) receivedAtFilter.lte = receivedUntil;

  const [allocations, legacyReceipts] = await Promise.all([
    prisma.financeReceiptAllocation.findMany({
      where: {
        receipt: {
          deleted: false,
          receivedAt: receivedAtFilter,
        },
      },
      select: {
        receiptId: true,
        invoiceId: true,
        amount: true,
        orderId: true,
        receipt: { select: { receivedAt: true, profileId: true } },
      },
    }),
    prisma.financeReceipt.findMany({
      where: {
        deleted: false,
        externalOrderInvoiceRequestId: { not: null },
        allocations: { none: {} },
        receivedAt: receivedAtFilter,
      },
      select: {
        id: true,
        amount: true,
        receivedAt: true,
        profileId: true,
        orderId: true,
        externalOrderInvoiceRequestId: true,
      },
    }),
  ]);

  const invoiceIds = [
    ...new Set([
      ...allocations.map((a) => a.invoiceId),
      ...legacyReceipts.map((r) => r.externalOrderInvoiceRequestId!).filter(Boolean),
    ]),
  ];

  const invoices =
    invoiceIds.length > 0
      ? await prisma.externalOrderInvoiceRequest.findMany({
          where: {
            id: { in: invoiceIds },
            status: "ISSUED",
            adjustmentsAsOriginal: ACTIVE_INVOICE_ADJUSTMENT_FILTER,
          },
          select: {
            id: true,
            actualIssuedAt: true,
            createdAt: true,
            buyerOrganizationId: true,
            orderId: true,
          },
        })
      : [];
  const invoiceMap = new Map(invoices.map((inv) => [inv.id, inv]));

  const orderIds = [
    ...new Set([
      ...allocations.map((a) => a.orderId).filter((id): id is string => !!id),
      ...legacyReceipts.map((r) => r.orderId).filter((id): id is string => !!id),
      ...invoices.map((inv) => inv.orderId).filter((id): id is string => !!id),
    ]),
  ];

  const orders =
    orderIds.length > 0
      ? await prisma.order.findMany({
          where: { id: { in: orderIds } },
          select: { id: true, profileId: true },
        })
      : [];
  const orderMap = new Map(orders.map((o) => [o.id, o]));

  const pairs: CollectionPair[] = [];

  for (const alloc of allocations) {
    const invoice = invoiceMap.get(alloc.invoiceId);
    if (!invoice) continue;
    const order = alloc.orderId ? orderMap.get(alloc.orderId) : null;
    const usedFallback = !invoice.actualIssuedAt;
    const issuedAt = invoice.actualIssuedAt ?? invoice.createdAt;
    const receivedAt = alloc.receipt.receivedAt;
    const cycleDays = (receivedAt.getTime() - issuedAt.getTime()) / 86_400_000;

    pairs.push({
      receiptId: alloc.receiptId,
      invoiceId: alloc.invoiceId,
      issuedAt,
      receivedAt,
      cycleDays,
      usedFallback,
      amount: alloc.amount,
      organizationId: invoice.buyerOrganizationId,
      orderId: alloc.orderId,
      profileId: order?.profileId ?? alloc.receipt.profileId,
    });
  }

  for (const receipt of legacyReceipts) {
    const invoiceId = receipt.externalOrderInvoiceRequestId!;
    const invoice = invoiceMap.get(invoiceId);
    if (!invoice) continue;
    const order = receipt.orderId ? orderMap.get(receipt.orderId) : null;
    const usedFallback = !invoice.actualIssuedAt;
    const issuedAt = invoice.actualIssuedAt ?? invoice.createdAt;
    const receivedAt = receipt.receivedAt;
    const cycleDays = (receivedAt.getTime() - issuedAt.getTime()) / 86_400_000;
    const profileId = order?.profileId ?? receipt.profileId ?? null;

    pairs.push({
      receiptId: receipt.id,
      invoiceId,
      issuedAt,
      receivedAt,
      cycleDays,
      usedFallback,
      amount: receipt.amount,
      organizationId: invoice.buyerOrganizationId,
      orderId: receipt.orderId,
      profileId,
    });
  }

  return pairs;
}

export async function getPeriodReceivableInCents(
  scope: CollectionScope | undefined,
  periodStart: Date,
  periodEnd: Date,
): Promise<PeriodReceivableResult> {
  const profileIds = scope?.profileIds;
  const orderIds = scope?.orderIds;

  const hasScope =
    (profileIds?.length ?? 0) > 0 ||
    (orderIds?.length ?? 0) > 0;

  const orderWhere = {
    deleted: false,
    archived: false,
    ...(profileIds?.length ? { profileId: { in: profileIds } } : {}),
    ...(orderIds?.length ? { id: { in: orderIds } } : {}),
  };

  const projectWhere = {
    deleted: false,
    ...(profileIds?.length ? { profileId: { in: profileIds } } : {}),
  };

  // Project receivable is only counted for全量 (ADMIN, no scope) or customer-scoped
  // queries. Order-only scope (机构维度: {orderIds}) intentionally skips projects —
  // org receivable is direct-order standalone only.
  const skipProjects = hasScope && !profileIds?.length;

  const [orders, projects] = await Promise.all([
    prisma.order.findMany({
      where: orderWhere,
      select: {
        id: true,
        totalAmount: true,
        financeAmountOverride: true,
        category: true,
        financeTreatment: true,
        orderedAt: true,
        confirmedAt: true,
        createdAt: true,
      },
    }),
    skipProjects
      ? Promise.resolve([])
      : prisma.project.findMany({
          where: projectWhere,
          select: {
            id: true,
            budgetAmount: true,
            projectType: true,
            startDate: true,
            createdAt: true,
            endDate: true,
            status: true,
          },
        }),
  ]);

  let projectRows = projects;
  if (projects.length > 0) {
    const histories = await prisma.statusHistory.findMany({
      where: {
        projectId: { in: projects.map((p) => p.id) },
        newStatus: "COMPLETED",
      },
      select: { projectId: true, createdAt: true },
      orderBy: { createdAt: "desc" },
    });
    const completionByProject = new Map<string, Date>();
    for (const h of histories) {
      if (!completionByProject.has(h.projectId)) {
        completionByProject.set(h.projectId, h.createdAt);
      }
    }
    projectRows = projects.map((p) => ({
      ...p,
      completionDate:
        p.status === "COMPLETED"
          ? completionByProject.get(p.id) ?? (p.endDate ? new Date(p.endDate) : null)
          : p.endDate
            ? new Date(p.endDate)
            : null,
    }));
  }

  const linkMap = await buildOrderProjectLinkMap(orders.map((o) => o.id));

  let receivableCents = 0;
  for (const project of projectRows) {
    receivableCents += computeProjectProgressReceivableInCents(
      project as typeof project & { completionDate: Date | null },
      periodStart,
      periodEnd,
    );
  }
  for (const order of orders) {
    receivableCents += computeStandaloneOrderReceivableInCents(
      { ...order, hasProjectLinks: linkMap.has(order.id) },
      periodStart,
      periodEnd,
    );
  }

  return {
    receivableCents,
    belowThreshold: receivableCents < RECEIVABLE_BELOW_THRESHOLD_CENTS,
  };
}

export function getPeriodReceiptTotalInCents(
  pairs: CollectionPair[],
  scope: CollectionScope | undefined,
  periodStart: Date,
  periodEnd: Date,
): number {
  let total = 0;
  for (const pair of pairs) {
    if (pair.receivedAt < periodStart || pair.receivedAt > periodEnd) continue;
    if (!pairMatchesScope(pair, scope)) continue;
    total += pair.amount;
  }
  return total;
}

/** Profile 主权口径的期间应收，key = profileId。 */
export async function buildProfileReceivableMap(
  profileIds: string[],
  periodStart: Date,
  periodEnd: Date,
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (profileIds.length === 0) return result;

  const uniqueIds = [...new Set(profileIds)];
  for (const id of uniqueIds) result.set(id, 0);

  const [orders, projects] = await Promise.all([
    prisma.order.findMany({
      where: { profileId: { in: uniqueIds }, deleted: false, archived: false },
      select: {
        id: true,
        profileId: true,
        totalAmount: true,
        financeAmountOverride: true,
        category: true,
        financeTreatment: true,
        orderedAt: true,
        confirmedAt: true,
        createdAt: true,
      },
    }),
    prisma.project.findMany({
      where: { profileId: { in: uniqueIds }, deleted: false },
      select: {
        id: true,
        profileId: true,
        budgetAmount: true,
        projectType: true,
        startDate: true,
        createdAt: true,
        endDate: true,
        status: true,
      },
    }),
  ]);

  const linkMap = await buildOrderProjectLinkMap(orders.map((o) => o.id));
  const histories =
    projects.length > 0
      ? await prisma.statusHistory.findMany({
          where: {
            projectId: { in: projects.map((p) => p.id) },
            newStatus: "COMPLETED",
          },
          select: { projectId: true, createdAt: true },
          orderBy: { createdAt: "desc" },
        })
      : [];
  const completionByProject = new Map<string, Date>();
  for (const history of histories) {
    if (!completionByProject.has(history.projectId)) {
      completionByProject.set(history.projectId, history.createdAt);
    }
  }

  for (const project of projects) {
    if (!project.profileId) continue;
    const completionDate =
      project.status === "COMPLETED"
        ? completionByProject.get(project.id) ?? (project.endDate ? new Date(project.endDate) : null)
        : project.endDate
          ? new Date(project.endDate)
          : null;
    const cents = computeProjectProgressReceivableInCents(
      { ...project, completionDate },
      periodStart,
      periodEnd,
    );
    result.set(project.profileId, (result.get(project.profileId) || 0) + cents);
  }

  for (const order of orders) {
    if (!order.profileId) continue;
    const cents = computeStandaloneOrderReceivableInCents(
      { ...order, hasProjectLinks: linkMap.has(order.id) },
      periodStart,
      periodEnd,
    );
    result.set(order.profileId, (result.get(order.profileId) || 0) + cents);
  }

  return result;
}

export function sumPairsForProfiles(
  pairs: CollectionPair[],
  profileIds: Set<string>,
  periodStart: Date,
  periodEnd: Date,
): number {
  let total = 0;
  for (const pair of pairs) {
    if (!pair.profileId || !profileIds.has(pair.profileId)) continue;
    if (pair.receivedAt < periodStart || pair.receivedAt > periodEnd) continue;
    total += pair.amount;
  }
  return total;
}

export function filterPairsForProfiles(
  pairs: CollectionPair[],
  profileIds: Set<string>,
): CollectionPair[] {
  return pairs.filter((pair) => pair.profileId && profileIds.has(pair.profileId));
}

export function buildRepresentativeCollectionMetrics(
  profileIds: string[],
  pairs: CollectionPair[],
  quarterReceivableMap: Map<string, number>,
  yearReceivableMap: Map<string, number>,
  now: Date = new Date(),
): CollectionSummaryMetrics {
  const profileSet = new Set(profileIds);
  const scopedPairs = filterPairsForProfiles(pairs, profileSet);
  const quarter = getQuarterRange(now);
  const year = getYearRange(now);

  const quarterlyReceivableAmount = profileIds.reduce(
    (sum, id) => sum + (quarterReceivableMap.get(id) || 0),
    0,
  );
  const yearlyReceivableAmount = profileIds.reduce(
    (sum, id) => sum + (yearReceivableMap.get(id) || 0),
    0,
  );
  const quarterlyReceiptAmount = sumPairsForProfiles(scopedPairs, profileSet, quarter.start, quarter.end);
  const yearlyReceiptAmount = sumPairsForProfiles(scopedPairs, profileSet, year.start, year.end);

  const cycle = getCollectionCycleStats(scopedPairs);
  const quarterRate = computeCollectionRate(
    quarterlyReceiptAmount,
    quarterlyReceivableAmount,
    quarterlyReceivableAmount < RECEIVABLE_BELOW_THRESHOLD_CENTS,
  );
  const yearRate = computeCollectionRate(
    yearlyReceiptAmount,
    yearlyReceivableAmount,
    yearlyReceivableAmount < RECEIVABLE_BELOW_THRESHOLD_CENTS,
  );

  return {
    avgCollectionCycleDays: cycle.avgCycleDays,
    collectionPairCount: cycle.pairCount,
    excludedNegativeCycleCount: cycle.excludedNegativeCycleCount,
    usedFallbackCount: cycle.usedFallbackCount,
    quarterlyReceiptRate: quarterRate.receiptRate,
    quarterlyReceiptAmount: quarterRate.receiptAmount,
    quarterlyReceivableAmount: quarterRate.receivableAmount,
    quarterlyBelowThreshold: quarterRate.belowThreshold,
    yearlyReceiptRate: yearRate.receiptRate,
    yearlyReceiptAmount: yearRate.receiptAmount,
    yearlyReceivableAmount: yearRate.receivableAmount,
    yearlyBelowThreshold: yearRate.belowThreshold,
  };
}

export async function buildProfileCollectionMetrics(
  profileIds: string[],
  pairs: CollectionPair[],
  includeRolling = false,
): Promise<CollectionSummaryMetrics> {
  const uniqueIds = [...new Set(profileIds)];
  const profileSet = new Set(uniqueIds);
  const scopedPairs = filterPairsForProfiles(pairs, profileSet);
  const quarter = getQuarterRange();
  const year = getYearRange();

  const [quarterReceivableMap, yearReceivableMap] = await Promise.all([
    buildProfileReceivableMap(uniqueIds, quarter.start, quarter.end),
    buildProfileReceivableMap(uniqueIds, year.start, year.end),
  ]);

  const quarterlyReceivableAmount = uniqueIds.reduce(
    (sum, id) => sum + (quarterReceivableMap.get(id) || 0),
    0,
  );
  const yearlyReceivableAmount = uniqueIds.reduce(
    (sum, id) => sum + (yearReceivableMap.get(id) || 0),
    0,
  );
  const quarterlyReceiptAmount = sumPairsForProfiles(
    scopedPairs,
    profileSet,
    quarter.start,
    quarter.end,
  );
  const yearlyReceiptAmount = sumPairsForProfiles(
    scopedPairs,
    profileSet,
    year.start,
    year.end,
  );

  const cycle = getCollectionCycleStats(scopedPairs);
  const quarterRate = computeCollectionRate(
    quarterlyReceiptAmount,
    quarterlyReceivableAmount,
    quarterlyReceivableAmount < RECEIVABLE_BELOW_THRESHOLD_CENTS,
  );
  const yearRate = computeCollectionRate(
    yearlyReceiptAmount,
    yearlyReceivableAmount,
    yearlyReceivableAmount < RECEIVABLE_BELOW_THRESHOLD_CENTS,
  );

  const summary: CollectionSummaryMetrics = {
    avgCollectionCycleDays: cycle.avgCycleDays,
    collectionPairCount: cycle.pairCount,
    excludedNegativeCycleCount: cycle.excludedNegativeCycleCount,
    usedFallbackCount: cycle.usedFallbackCount,
    quarterlyReceiptRate: quarterRate.receiptRate,
    quarterlyReceiptAmount: quarterRate.receiptAmount,
    quarterlyReceivableAmount: quarterRate.receivableAmount,
    quarterlyBelowThreshold: quarterRate.belowThreshold,
    yearlyReceiptRate: yearRate.receiptRate,
    yearlyReceiptAmount: yearRate.receiptAmount,
    yearlyReceivableAmount: yearRate.receivableAmount,
    yearlyBelowThreshold: yearRate.belowThreshold,
  };

  if (includeRolling) {
    const rolling = getRollingWindowRanges();
    const rollingReceivableMap = await buildProfileReceivableMap(
      uniqueIds,
      rolling.orderStart,
      rolling.end,
    );
    const rollingReceivableAmount = uniqueIds.reduce(
      (sum, id) => sum + (rollingReceivableMap.get(id) || 0),
      0,
    );
    const rollingOrderIds = [
      ...new Set(scopedPairs.map((pair) => pair.orderId).filter((id): id is string => !!id)),
    ];
    const rollingOrders =
      rollingOrderIds.length > 0
        ? await prisma.order.findMany({
            where: { id: { in: rollingOrderIds } },
            select: { id: true, orderedAt: true, confirmedAt: true, createdAt: true },
          })
        : [];
    const orderDateMap = new Map(rollingOrders.map((order) => [order.id, getOrderDate(order)]));

    let rollingReceiptAmount = 0;
    for (const pair of scopedPairs) {
      if (pair.receivedAt < rolling.receivedStart || pair.receivedAt > rolling.end) continue;
      if (!pair.orderId) continue;
      const orderDate = orderDateMap.get(pair.orderId);
      if (!orderDate || orderDate < rolling.orderStart || orderDate > rolling.end) continue;
      rollingReceiptAmount += pair.amount;
    }
    const rollingRate = computeCollectionRate(
      rollingReceiptAmount,
      rollingReceivableAmount,
      rollingReceivableAmount < RECEIVABLE_BELOW_THRESHOLD_CENTS,
    );
    summary.rollingReceiptRate = rollingRate.receiptRate;
    summary.rollingReceiptAmount = rollingRate.receiptAmount;
    summary.rollingReceivableAmount = rollingRate.receivableAmount;
    summary.rollingBelowThreshold = rollingRate.belowThreshold;
  }

  return summary;
}

export type OrganizationFinanceItem = {
  organizationId: string;
  orgCode: string | null;
  canonicalName: string;
  avgCollectionCycleDays: number | null;
  pairCount: number;
  quarterlyReceiptRate: number | null;
  quarterlyReceiptAmount: number;
  quarterlyReceivableAmount: number;
  yearlyReceiptRate: number | null;
  yearlyReceiptAmount: number;
  yearlyReceivableAmount: number;
};

/**
 * Per-order standalone receivable (cents) for a period, keyed by orderId.
 * Used to batch the 机构维度 receivable so we don't run 2N serial queries (M1).
 */
async function buildOrderReceivableMap(
  orderIds: string[],
  periodStart: Date,
  periodEnd: Date,
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (orderIds.length === 0) return result;

  const uniqueIds = [...new Set(orderIds)];
  const orders = await prisma.order.findMany({
    where: { id: { in: uniqueIds }, deleted: false, archived: false },
    select: {
      id: true,
      totalAmount: true,
      financeAmountOverride: true,
      category: true,
      financeTreatment: true,
      orderedAt: true,
      confirmedAt: true,
      createdAt: true,
    },
  });
  const linkMap = await buildOrderProjectLinkMap(orders.map((o) => o.id));

  for (const order of orders) {
    result.set(
      order.id,
      computeStandaloneOrderReceivableInCents(
        { ...order, hasProjectLinks: linkMap.has(order.id) },
        periodStart,
        periodEnd,
      ),
    );
  }
  return result;
}

export async function buildOrganizationFinanceList(): Promise<OrganizationFinanceItem[]> {
  const pairs = await getCollectionPairs();
  const orgPairs = pairs.filter((p) => p.organizationId);
  const quarter = getQuarterRange();
  const year = getYearRange();

  const orgIds = [...new Set(orgPairs.map((p) => p.organizationId!))];
  if (orgIds.length === 0) return [];

  const organizations = await prisma.organization.findMany({
    where: { id: { in: orgIds } },
    select: { id: true, orgCode: true, canonicalName: true },
  });
  const orgMap = new Map(organizations.map((o) => [o.id, o]));

  const byOrg = new Map<string, CollectionPair[]>();
  for (const pair of orgPairs) {
    const list = byOrg.get(pair.organizationId!) || [];
    list.push(pair);
    byOrg.set(pair.organizationId!, list);
  }

  // M1: one query maps every org → its direct-order invoice orderIds, replacing
  // the previous 2N serial sumOrgReceivableInPeriod calls inside the loop.
  const orgInvoices = await prisma.externalOrderInvoiceRequest.findMany({
    where: {
      buyerOrganizationId: { in: orgIds },
      status: "ISSUED",
      adjustmentsAsOriginal: ACTIVE_INVOICE_ADJUSTMENT_FILTER,
      orderId: { not: null },
    },
    select: { buyerOrganizationId: true, orderId: true },
  });
  const orgToOrderIds = new Map<string, Set<string>>();
  const allOrderIds = new Set<string>();
  for (const inv of orgInvoices) {
    if (!inv.buyerOrganizationId || !inv.orderId) continue;
    const set = orgToOrderIds.get(inv.buyerOrganizationId) ?? new Set<string>();
    set.add(inv.orderId);
    orgToOrderIds.set(inv.buyerOrganizationId, set);
    allOrderIds.add(inv.orderId);
  }

  // Compute each order's receivable once per period, then sum per org in memory.
  const allOrderIdList = [...allOrderIds];
  const [quarterReceivableByOrder, yearReceivableByOrder] = await Promise.all([
    buildOrderReceivableMap(allOrderIdList, quarter.start, quarter.end),
    buildOrderReceivableMap(allOrderIdList, year.start, year.end),
  ]);

  const items: OrganizationFinanceItem[] = [];
  for (const [organizationId, orgPairList] of byOrg) {
    const org = orgMap.get(organizationId);
    if (!org) continue;

    const quarterlyReceiptAmount = orgPairList
      .filter((p) => p.receivedAt >= quarter.start && p.receivedAt <= quarter.end)
      .reduce((s, p) => s + p.amount, 0);
    const yearlyReceiptAmount = orgPairList
      .filter((p) => p.receivedAt >= year.start && p.receivedAt <= year.end)
      .reduce((s, p) => s + p.amount, 0);

    let quarterlyReceivableAmount = 0;
    let yearlyReceivableAmount = 0;
    const orderIdsForOrg = orgToOrderIds.get(organizationId);
    if (orderIdsForOrg) {
      for (const oid of orderIdsForOrg) {
        quarterlyReceivableAmount += quarterReceivableByOrder.get(oid) || 0;
        yearlyReceivableAmount += yearReceivableByOrder.get(oid) || 0;
      }
    }

    const cycle = getCollectionCycleStats(orgPairList);
    const quarterRate = computeCollectionRate(
      quarterlyReceiptAmount,
      quarterlyReceivableAmount,
      quarterlyReceivableAmount < RECEIVABLE_BELOW_THRESHOLD_CENTS,
    );
    const yearRate = computeCollectionRate(
      yearlyReceiptAmount,
      yearlyReceivableAmount,
      yearlyReceivableAmount < RECEIVABLE_BELOW_THRESHOLD_CENTS,
    );

    items.push({
      organizationId,
      orgCode: org.orgCode,
      canonicalName: org.canonicalName,
      avgCollectionCycleDays: cycle.avgCycleDays,
      pairCount: cycle.pairCount,
      quarterlyReceiptRate: quarterRate.receiptRate,
      quarterlyReceiptAmount: quarterRate.receiptAmount,
      quarterlyReceivableAmount: quarterRate.receivableAmount,
      yearlyReceiptRate: yearRate.receiptRate,
      yearlyReceiptAmount: yearRate.receiptAmount,
      yearlyReceivableAmount: yearRate.receivableAmount,
    });
  }

  return items.sort((a, b) => a.canonicalName.localeCompare(b.canonicalName, "zh-CN"));
}

/** 解析 Profile 合并链的完整家族（目标、来源及多级来源）。 */
export async function resolveMergedProfileIds(profileId: string): Promise<string[]> {
  const family = new Set<string>([profileId]);
  let rootId = profileId;

  while (true) {
    const current = await prisma.crmCustomerProfile.findUnique({
      where: { id: rootId },
      select: { mergedIntoProfileId: true },
    });
    if (!current?.mergedIntoProfileId || family.has(current.mergedIntoProfileId)) break;
    rootId = current.mergedIntoProfileId;
    family.add(rootId);
  }

  let frontier = [rootId];
  while (frontier.length > 0) {
    const mergedSources = await prisma.crmCustomerProfile.findMany({
      where: { mergedIntoProfileId: { in: frontier } },
      select: { id: true },
    });
    const next = mergedSources
      .map((profile) => profile.id)
      .filter((id) => !family.has(id));
    for (const id of next) family.add(id);
    frontier = next;
  }

  return [...family];
}

/** Batch-build collection metrics keyed by profileId (list view — no merge). */
export async function buildProfileCollectionMetricsMap(
  profileIds: string[],
): Promise<Map<string, Pick<CollectionSummaryMetrics, "avgCollectionCycleDays" | "collectionPairCount">>> {
  const pairs = await getCollectionPairs();
  const result = new Map<
    string,
    Pick<CollectionSummaryMetrics, "avgCollectionCycleDays" | "collectionPairCount">
  >();
  for (const profileId of [...new Set(profileIds)]) {
    const scopedPairs = filterPairsForProfiles(pairs, new Set([profileId]));
    const cycle = getCollectionCycleStats(scopedPairs);
    result.set(profileId, {
      avgCollectionCycleDays: cycle.avgCycleDays,
      collectionPairCount: cycle.pairCount,
    });
  }
  return result;
}

/** 代表 KPI：按 profileId 预加载回款配对与期间应收。 */
export async function preloadRepresentativeCollectionData(
  allProfileIds: string[],
  now: Date = new Date(),
) {
  const pairs = await getCollectionPairs();
  const quarter = getQuarterRange(now);
  const year = getYearRange(now);
  const [quarterReceivableMap, yearReceivableMap] = await Promise.all([
    buildProfileReceivableMap(allProfileIds, quarter.start, quarter.end),
    buildProfileReceivableMap(allProfileIds, year.start, year.end),
  ]);
  return { pairs, quarterReceivableMap, yearReceivableMap };
}

/**
 * Finance summary 回款健康度（近窗回款率 + 平均回款周期）。
 *
 * 口径：可见 Profile ∪ 可见 standalone 订单（项目维度不纳入）。
 * 禁止把 { profileIds, orderIds } 直接传给 getPeriodReceivableInCents
 * （其 orderWhere 会把两条件 AND，应收变成交集）。
 *
 * - ADMIN（isFullScope）：全量，scope undefined
 * - 非 ADMIN：配对 OR 过滤；应收两段相加，standalone 排除已在 profileIds 内的订单防重复
 */
export type FinanceSummaryCollectionHealth = {
  avgCollectionCycleDays: number | null;
  collectionPairCount: number;
  rollingReceiptRate: number | null;
};

export async function computeFinanceSummaryCollectionHealth(input: {
  isFullScope: boolean;
  profileIds: string[];
  /** 可见订单中 treatment=STANDALONE 的订单（含 profileId，用于去重） */
  standaloneOrders: Array<{ id: string; profileId: string | null }>;
}): Promise<FinanceSummaryCollectionHealth> {
  const { isFullScope, profileIds, standaloneOrders } = input;
  const profileIdSet = new Set(profileIds);
  const standaloneOrderIds = standaloneOrders.map((o) => o.id);
  const standaloneOrderIdSet = new Set(standaloneOrderIds);

  const standaloneNotCoveredByProfile = standaloneOrders
    .filter((o) => !o.profileId || !profileIdSet.has(o.profileId))
    .map((o) => o.id);

  const pairs = await getCollectionPairs();
  const scopedPairs = isFullScope
    ? pairs
    : pairs.filter(
        (p) =>
          (p.profileId != null && profileIdSet.has(p.profileId)) ||
          (p.orderId != null && standaloneOrderIdSet.has(p.orderId)),
      );

  const cycle = getCollectionCycleStats(scopedPairs);
  const rolling = getRollingWindowRanges();

  let rollingReceivableCents: number;
  if (isFullScope) {
    const r = await getPeriodReceivableInCents(undefined, rolling.orderStart, rolling.end);
    rollingReceivableCents = r.receivableCents;
  } else {
    const parts: Promise<PeriodReceivableResult>[] = [];
    if (profileIds.length > 0) {
      parts.push(getPeriodReceivableInCents({ profileIds }, rolling.orderStart, rolling.end));
    }
    if (standaloneNotCoveredByProfile.length > 0) {
      parts.push(
        getPeriodReceivableInCents(
          { orderIds: standaloneNotCoveredByProfile },
          rolling.orderStart,
          rolling.end,
        ),
      );
    }
    if (parts.length === 0) {
      rollingReceivableCents = 0;
    } else {
      const results = await Promise.all(parts);
      rollingReceivableCents = results.reduce((s, r) => s + r.receivableCents, 0);
    }
  }

  // 近窗回款：与客户看板 rolling 一致——到款落在 received 窗，且订单日落在 order 窗
  const rollingOrderIds = [
    ...new Set(scopedPairs.map((p) => p.orderId).filter((id): id is string => !!id)),
  ];
  const rollingOrders =
    rollingOrderIds.length > 0
      ? await prisma.order.findMany({
          where: { id: { in: rollingOrderIds } },
          select: { id: true, orderedAt: true, confirmedAt: true, createdAt: true },
        })
      : [];
  const orderDateMap = new Map(rollingOrders.map((o) => [o.id, getOrderDate(o)]));

  let rollingReceiptCents = 0;
  for (const pair of scopedPairs) {
    if (pair.receivedAt < rolling.receivedStart || pair.receivedAt > rolling.end) continue;
    if (!pair.orderId) continue;
    const orderDate = orderDateMap.get(pair.orderId);
    if (!orderDate || orderDate < rolling.orderStart || orderDate > rolling.end) continue;
    rollingReceiptCents += pair.amount;
  }

  const rate = computeCollectionRate(
    rollingReceiptCents,
    rollingReceivableCents,
    rollingReceivableCents < RECEIVABLE_BELOW_THRESHOLD_CENTS,
  );

  return {
    avgCollectionCycleDays: cycle.avgCycleDays,
    collectionPairCount: cycle.pairCount,
    rollingReceiptRate: rate.receiptRate,
  };
}

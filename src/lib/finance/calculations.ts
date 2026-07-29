import { prisma } from "@/lib/prisma";
import type {
  FinanceSummary,
  CustomerFinanceItem,
  CustomerFinanceDetail,
  FinanceCustomerListResponse,
} from "./types";
import { computeProjectReceivable } from "./types";
import { roundForDisplay, centsToYuan } from "./money";
import { computeOrderFinanceAmount, getOrderEffectiveTreatment, computeAllProgressReceivables, getOrderDate, getProjectStartDate, getWeekRange, getMonthRange } from "./progress";
import { computeBatchProjectRevenue } from "./ledger";
import { getOrderReceiptTotals } from "./order-receivables";
import {
  getOrderInvoiceSummaryBatch,
  isOrderInvoiceable,
  isOrderSettled,
  yuanAmountToCents,
} from "./order-invoice-amounts";
import { buildOrderProjectLinkMap } from "./order-project-links";
import { getCustomerOrganizationName } from "@/lib/customer-organization";
import {
  buildProfileCollectionMetrics,
  buildProfileCollectionMetricsMap,
  computeFinanceSummaryCollectionHealth,
  getCollectionPairs,
  resolveMergedProfileIds,
  type CollectionSummaryMetrics,
} from "./collection-analysis";
import { getEffectiveOrderWhere } from "@/lib/orders/permissions";
import type { Prisma } from "@prisma/client";

type CustomerFinanceReceiptLine = {
  id: string;
  amount: number;
  receivedAt: Date;
  source: string;
  remark: string | null;
};

/**
 * Receipt lines for a customer finance detail view — same scope as totalReceipt:
 * allocations on this customer's orders + legacy 1-to-1 order receipts + customer-only receipts.
 */
async function fetchCustomerFinanceReceiptLines(
  profileId: string,
  orderIds: string[],
): Promise<CustomerFinanceReceiptLine[]> {
  const lines: CustomerFinanceReceiptLine[] = [];

  if (orderIds.length > 0) {
    const allocations = await prisma.financeReceiptAllocation.findMany({
      where: {
        orderId: { in: orderIds },
        receipt: { deleted: false },
      },
      select: {
        id: true,
        amount: true,
        receipt: { select: { receivedAt: true, source: true, remark: true } },
      },
    });
    for (const a of allocations) {
      lines.push({
        id: a.id,
        amount: a.amount,
        receivedAt: a.receipt.receivedAt,
        source: a.receipt.source,
        remark: a.receipt.remark,
      });
    }

    const legacyReceipts = await prisma.financeReceipt.findMany({
      where: {
        orderId: { in: orderIds },
        deleted: false,
        allocations: { none: {} },
      },
      select: { id: true, amount: true, receivedAt: true, source: true, remark: true },
    });
    for (const r of legacyReceipts) {
      lines.push(r);
    }
  }

  const customerOnlyReceipts = await prisma.financeReceipt.findMany({
    where: {
      profileId,
      orderId: null,
      deleted: false,
      allocations: { none: {} },
    },
    select: { id: true, amount: true, receivedAt: true, source: true, remark: true },
  });
  for (const r of customerOnlyReceipts) {
    lines.push(r);
  }

  lines.sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime());
  return lines;
}

export async function getFinanceSummary(
  customerScope: { id: { in: string[] } } | null,
  projectScope: { id: { in: string[] } } | null,
  includeArchived: boolean = false,
  now: Date = new Date(),
  /**
   * 非 ADMIN 必须传入当前部门。共享 profile 可跨部门存在，
   * 订单/回款/成本等事实查询必须 AND 自身 departmentSnapshot（设计 §6.1）。
   * ADMIN 传 null/undefined 表示不按部门过滤。
   */
  department?: string | null,
): Promise<FinanceSummary> {
  const scopedProfileIds = customerScope?.id.in ?? [];
  const deptFilter = department ? { departmentSnapshot: department } : {};
  const profileWhere: Prisma.CrmCustomerProfileWhereInput = {
    deleted: false,
    ...(includeArchived ? {} : { archived: false }),
    ...(customerScope ? { id: customerScope.id } : {}),
  };

  const projectWhere: Prisma.ProjectWhereInput = {
    deleted: false,
    // Phase 0 review #3：财务聚合排除治理桶（PRJ-OTHER 等）。
    systemType: "NORMAL",
    archived: includeArchived ? undefined : false,
    ...(projectScope ? { id: projectScope.id } : {}),
    ...deptFilter,
  };

  // ── Orders: scope by customer + project-linked，并强制部门快照 ──
  const orderOrConditions: Record<string, unknown>[] = [];
  if (customerScope) {
    orderOrConditions.push({ profileId: { in: scopedProfileIds } });
  }
  if (projectScope) {
    // In-scope projects → linked order ids
    const projectOrders = await prisma.orderProjectLink.findMany({
      where: { projectId: { in: projectScope.id.in } },
      select: { orderId: true },
      distinct: ["orderId"],
    });
    if (projectOrders.length > 0) {
      orderOrConditions.push({ id: { in: projectOrders.map((l) => l.orderId) } });
    }
  }

  // Resolve scoped order IDs for receipt filtering
  let scopedOrderIds: string[] = [];
  if (customerScope || projectScope) {
    const orderWhere: Record<string, unknown> = { ...deptFilter };
    if (orderOrConditions.length > 0) orderWhere.OR = orderOrConditions;
    const scopedOrders = await prisma.order.findMany({
      where: orderWhere,
      select: { id: true },
    });
    scopedOrderIds = scopedOrders.map((o) => o.id);
  }

  const receiptScopeWhere: Record<string, unknown> = { ...deptFilter };
  if (scopedOrderIds.length > 0) {
    receiptScopeWhere.orderId = { in: scopedOrderIds };
  } else if (customerScope || projectScope) {
    // No scoped orders found → no receipts
    receiptScopeWhere.orderId = { in: ["__NO_MATCH__"] };
  }

  const orderWhere: Record<string, unknown> = { deleted: false, ...deptFilter };
  const scopeWhere: Record<string, unknown> | null =
    orderOrConditions.length === 1 ? orderOrConditions[0]
    : orderOrConditions.length > 1 ? { OR: orderOrConditions }
    : null;
  Object.assign(orderWhere, getEffectiveOrderWhere(scopeWhere));
  // No scope → all effective orders（ADMIN）；有 department 时仍限制部门

  const allOrders = await prisma.order.findMany({
    where: orderWhere,
    select: {
      id: true, totalAmount: true, financeAmountOverride: true,
      category: true, financeTreatment: true,
      orderedAt: true, confirmedAt: true, createdAt: true,
      profileId: true,
    },
  });

  // Build project-link map for AUTO resolution
  const orderIds = allOrders.map((o) => o.id);
  const linkMap = await buildOrderProjectLinkMap(orderIds);

  // Per-order occupancy (yuan) + receipt totals (cents) for queue metrics
  const [invoiceSummaryMap, orderReceiptTotals] = await Promise.all([
    getOrderInvoiceSummaryBatch(orderIds),
    getOrderReceiptTotals(orderIds),
  ]);

  // Period ranges for time-based KPIs
  const { start: weekStart, end: weekEnd } = getWeekRange(now);
  const { start: monthStart, end: monthEnd } = getMonthRange(now);

  let standaloneOrderAmount = 0;
  let projectLinkedOrderAmount = 0;
  let matchedOnline = 0;
  let unmatchedOnline = 0;
  let unmatchedOrderCount = 0;
  let unmatchedOrderAmount = 0;
  let uninvoicedOrderCount = 0;
  let uninvoicedOrderAmount = 0;
  let invoiceableOrderCount = 0;
  let invoiceableOrderAmount = 0;
  let invoicedUnpaidOrderCount = 0;
  let invoicedUnpaidOrderAmount = 0;
  let settledOrderCount = 0;
  let settledOrderAmount = 0;
  let monthBusinessAmount = 0;
  let weekBusinessAmount = 0;

  for (const o of allOrders) {
    const amt = computeOrderFinanceAmount(o);
    if (o.profileId) matchedOnline += amt;
    else {
      unmatchedOnline += amt;
      unmatchedOrderCount += 1;
      unmatchedOrderAmount += amt;
    }

    const treatment = getOrderEffectiveTreatment(o.financeTreatment, linkMap.has(o.id));
    if (treatment === "PROJECT_INCLUDED") projectLinkedOrderAmount += amt;
    else if (treatment === "STANDALONE") standaloneOrderAmount += amt;

    const summary = invoiceSummaryMap.get(o.id);
    const capacityYuan = summary?.invoiceCapacityAmount ?? 0;
    const issuedYuan = summary?.invoicedAmount ?? 0;
    const draftYuan = summary?.invoiceDraftAmount ?? 0;
    const requestedYuan = summary?.invoiceRequestedAmount ?? 0;
    const remainingYuan = summary?.invoiceRemainingAmount ?? 0;
    const receivedCents = orderReceiptTotals.get(o.id) || 0;
    const receivedYuan = centsToYuan(receivedCents);
    const unpaidCents = Math.max(yuanAmountToCents(issuedYuan) - receivedCents, 0);

    if (isOrderInvoiceable({ profileId: o.profileId, remainingYuan })) {
      invoiceableOrderCount += 1;
      invoiceableOrderAmount += yuanAmountToCents(remainingYuan);
      // 兼容旧字段：无已登记票的可开票订单
      if (yuanAmountToCents(issuedYuan) <= 0) {
        uninvoicedOrderCount += 1;
        uninvoicedOrderAmount += yuanAmountToCents(remainingYuan);
      }
    }

    if (o.profileId != null && yuanAmountToCents(issuedYuan) > 0 && unpaidCents > 0) {
      invoicedUnpaidOrderCount += 1;
      invoicedUnpaidOrderAmount += unpaidCents;
    }

    if (
      isOrderSettled({
        profileId: o.profileId,
        capacityYuan,
        issuedYuan,
        draftYuan,
        requestedYuan,
        receivedYuan,
      })
    ) {
      settledOrderCount += 1;
      settledOrderAmount += yuanAmountToCents(issuedYuan);
    }

    const orderDate = getOrderDate(o);
    if (treatment === "STANDALONE") {
      if (orderDate >= monthStart && orderDate <= monthEnd) monthBusinessAmount += amt;
      if (orderDate >= weekStart && orderDate <= weekEnd) weekBusinessAmount += amt;
    }
  }

  // 发票申请 scope：显式构造 OR，禁止空对象 {} 兜底（否则会匹配全量发票）
  // 共享 profile 分支必须 AND 订单部门快照，避免跨部门事实泄漏
  const orderDeptNested = department ? { departmentSnapshot: department } : {};
  const invoiceOrBranches: Prisma.ExternalOrderInvoiceRequestWhereInput[] = [];
  if (customerScope) {
    invoiceOrBranches.push({
      externalOrder: { profileId: { in: scopedProfileIds }, mergedIntoId: null },
    });
    invoiceOrBranches.push({
      order: { profileId: { in: scopedProfileIds }, ...orderDeptNested },
    });
    invoiceOrBranches.push({
      orderCoverage: {
        some: { order: { profileId: { in: scopedProfileIds }, ...orderDeptNested } },
      },
    });
  }
  if ((customerScope || projectScope) && scopedOrderIds.length > 0) {
    invoiceOrBranches.push({ orderId: { in: scopedOrderIds } });
    invoiceOrBranches.push({ orderCoverage: { some: { orderId: { in: scopedOrderIds } } } });
  }

  const scopeInvoiceWhere: Prisma.ExternalOrderInvoiceRequestWhereInput = {
    status: { not: "CANCELLED" },
    adjustmentsAsOriginal: { none: { kind: { in: ["RED", "REISSUE"] } } },
  };
  if (customerScope || projectScope) {
    // 有 scope：必须命中显式分支；无命中分支则 fail-closed
    scopeInvoiceWhere.OR =
      invoiceOrBranches.length > 0 ? invoiceOrBranches : [{ id: "__NO_MATCH__" }];
  }
  // ADMIN 无 scope：不加 OR，仅排除 CANCELLED / 已冲红重开

  const [
    projectAgg,
    projectInvoiceAgg,
    orderInvoiceAgg,
    receiptAgg,
    pendingInvoiceCount,
    customerCount,
    projectCount,
    receiptCount,
    costAgg,
    allProjectsForProgress,
    monthInvoiceAgg,
    monthReceiptAgg,
    draftInvoiceAgg,
    requestedInvoiceAgg,
  ] = await Promise.all([
    prisma.project.aggregate({
      _sum: { budgetAmount: true },
      where: projectWhere,
    }),
    prisma.projectInvoice.aggregate({
      _sum: { totalAmount: true },
      where: { status: { not: "CANCELLED" }, project: projectWhere },
    }),
    prisma.externalOrderInvoiceRequest.aggregate({
      _sum: { totalAmount: true },
      where: scopeInvoiceWhere,
    }),
    prisma.financeReceipt.aggregate({
      _sum: { amount: true },
      where: { ...receiptScopeWhere, deleted: false },
    }),
    prisma.projectInvoice.count({
      where: { status: { in: ["DRAFT", "REQUESTED"] }, project: projectWhere },
    }),
    prisma.crmCustomerProfile.count({ where: profileWhere }),
    prisma.project.count({ where: projectWhere }),
    prisma.financeReceipt.count({ where: { ...receiptScopeWhere, deleted: false } }),
    prisma.financeCost.aggregate({
      _sum: { amount: true },
      where: (customerScope || projectScope)
        ? {
            AND: [
              ...(department ? [{ departmentSnapshot: department }] : []),
              {
                OR: [
                  ...(customerScope ? [{ profileId: { in: scopedProfileIds } }] : []),
                  ...(projectScope ? [{ projectId: { in: projectScope.id.in } }] : []),
                  ...(projectScope ? [{
                    order: { projectLinks: { some: { projectId: { in: projectScope.id.in } } } },
                  }] : []),
                ],
              },
            ],
          }
        : (department ? { departmentSnapshot: department } : {}),
    }),
    prisma.project.findMany({
      where: projectWhere,
      select: {
        id: true, budgetAmount: true, projectType: true,
        startDate: true, createdAt: true, endDate: true, status: true,
      },
    }),
    prisma.externalOrderInvoiceRequest.aggregate({
      _sum: { totalAmount: true },
      where: {
        AND: [
          scopeInvoiceWhere,
          { status: "ISSUED" },
          {
            OR: [
              { actualIssuedAt: { gte: monthStart, lte: monthEnd } },
              { actualIssuedAt: null, updatedAt: { gte: monthStart, lte: monthEnd } },
            ],
          },
        ],
      },
    }),
    prisma.financeReceipt.aggregate({
      _sum: { amount: true },
      _count: { _all: true },
      where: { ...receiptScopeWhere, deleted: false, receivedAt: { gte: monthStart, lte: monthEnd } },
    }),
    prisma.externalOrderInvoiceRequest.aggregate({
      _sum: { totalAmount: true },
      _count: { _all: true },
      where: { AND: [scopeInvoiceWhere, { status: "DRAFT" }] },
    }),
    prisma.externalOrderInvoiceRequest.aggregate({
      _sum: { totalAmount: true },
      _count: { _all: true },
      where: { AND: [scopeInvoiceWhere, { status: "REQUESTED" }] },
    }),
  ]);

  const projectBudgetTotal = projectAgg._sum.budgetAmount || 0;
  const projectRevenue = await computeBatchProjectRevenue(allProjectsForProgress);
  const effectiveBusinessAmount = projectRevenue + standaloneOrderAmount;

  const progressStandaloneOrders = allOrders
    .filter((o) => getOrderEffectiveTreatment(o.financeTreatment, linkMap.has(o.id)) === "STANDALONE")
    .map((o) => ({ ...o, hasProjectLinks: linkMap.has(o.id) }));
  const progress = await computeAllProgressReceivables(
    allProjectsForProgress,
    progressStandaloneOrders,
    orderIds,
    allProjectsForProgress.map((p) => p.id),
  );

  let unmatchedOnlineOrderAmount = 0;
  if (!customerScope && !projectScope) {
    const trueUnmatched = await prisma.order.aggregate({
      _sum: { totalAmount: true },
      where: { deleted: false, profileId: null, ...deptFilter },
    });
    unmatchedOnlineOrderAmount = trueUnmatched._sum.totalAmount || 0;
  }

  const costAmount = costAgg._sum.amount || 0;
  const receiptAmount = receiptAgg._sum.amount || 0;
  // 权责制利润：业务额 − 成本（非现金制 回款−成本），消除回款滞后导致的利润失真。
  // 未来成本侧切换为 CostEntry/CostSnapshot 聚合时公式结构不变。
  const profitAmount = effectiveBusinessAmount - costAmount;
  const profitRate = effectiveBusinessAmount > 0 ? profitAmount / effectiveBusinessAmount : null;

  for (const p of allProjectsForProgress) {
    const projectStart = getProjectStartDate(p);
    const budget = p.budgetAmount || 0;
    if (projectStart >= monthStart && projectStart <= monthEnd) monthBusinessAmount += budget;
    if (projectStart >= weekStart && projectStart <= weekEnd) weekBusinessAmount += budget;
  }

  // 回款健康度：可见客户 ∪ 可见 standalone（并集，禁止混合 scope AND）
  const isFullCollectionScope = !customerScope && !projectScope;
  const healthProfileIds = customerScope?.id.in ?? [];
  const healthStandaloneOrders = allOrders
    .filter((o) => getOrderEffectiveTreatment(o.financeTreatment, linkMap.has(o.id)) === "STANDALONE")
    .map((o) => ({ id: o.id, profileId: o.profileId }));
  const collectionHealth = await computeFinanceSummaryCollectionHealth({
    isFullScope: isFullCollectionScope,
    profileIds: healthProfileIds,
    standaloneOrders: healthStandaloneOrders,
  });

  return {
    totalOnlineOrderAmount: roundForDisplay(centsToYuan(matchedOnline + unmatchedOnline + (customerScope || projectScope ? 0 : unmatchedOnlineOrderAmount - unmatchedOnline))),
    matchedOnlineOrderAmount: roundForDisplay(centsToYuan(matchedOnline)),
    unmatchedOnlineOrderAmount: roundForDisplay(centsToYuan(unmatchedOnlineOrderAmount)),
    totalProjectBudgetAmount: roundForDisplay(centsToYuan(projectBudgetTotal)),
    projectLinkedOrderAmount: roundForDisplay(centsToYuan(projectLinkedOrderAmount)),
    standaloneOnlineOrderAmount: roundForDisplay(centsToYuan(standaloneOrderAmount)),
    effectiveBusinessAmount: roundForDisplay(centsToYuan(effectiveBusinessAmount)),
    projectInvoicedAmount: roundForDisplay(centsToYuan(projectInvoiceAgg._sum.totalAmount || 0)),
    orderInvoicedAmount: roundForDisplay(centsToYuan(orderInvoiceAgg._sum.totalAmount || 0)),
    totalReceiptAmount: roundForDisplay(centsToYuan(receiptAgg._sum.amount || 0)),
    pendingInvoiceCount,
    customerCount,
    projectCount,
    receiptCount,
    weekProgressReceivable: roundForDisplay(progress.weekProject.total + progress.weekOrder),
    monthProgressReceivable: roundForDisplay(progress.monthProject.total + progress.monthOrder),
    weekServiceDeposit: roundForDisplay(progress.weekProject.serviceDeposit),
    weekServiceFinal: roundForDisplay(progress.weekProject.serviceFinal),
    weekProductReceivable: roundForDisplay(progress.weekProject.productReceivable),
    monthServiceDeposit: roundForDisplay(progress.monthProject.serviceDeposit),
    monthServiceFinal: roundForDisplay(progress.monthProject.serviceFinal),
    monthProductReceivable: roundForDisplay(progress.monthProject.productReceivable),
    costAmount: roundForDisplay(centsToYuan(costAmount)),
    profitAmount: roundForDisplay(centsToYuan(profitAmount)),
    profitRate,
    unmatchedOrderCount,
    unmatchedOrderAmount: roundForDisplay(centsToYuan(unmatchedOrderAmount)),
    uninvoicedOrderCount,
    uninvoicedOrderAmount: roundForDisplay(centsToYuan(uninvoicedOrderAmount)),
    invoiceableOrderCount,
    invoiceableOrderAmount: roundForDisplay(centsToYuan(invoiceableOrderAmount)),
    draftInvoiceCount: draftInvoiceAgg._count._all,
    draftInvoiceAmount: roundForDisplay(centsToYuan(draftInvoiceAgg._sum.totalAmount || 0)),
    requestedInvoiceCount: requestedInvoiceAgg._count._all,
    requestedInvoiceAmount: roundForDisplay(centsToYuan(requestedInvoiceAgg._sum.totalAmount || 0)),
    invoicedUnpaidOrderCount,
    invoicedUnpaidOrderAmount: roundForDisplay(centsToYuan(invoicedUnpaidOrderAmount)),
    settledOrderCount,
    settledOrderAmount: roundForDisplay(centsToYuan(settledOrderAmount)),
    advanceRefundPendingCount: 0,
    advanceRefundPendingAmount: 0,
    monthBusinessAmount: roundForDisplay(centsToYuan(monthBusinessAmount)),
    weekBusinessAmount: roundForDisplay(centsToYuan(weekBusinessAmount)),
    monthInvoicedAmount: roundForDisplay(centsToYuan(monthInvoiceAgg._sum.totalAmount || 0)),
    monthReceiptAmount: roundForDisplay(centsToYuan(monthReceiptAgg._sum.amount || 0)),
    monthReceiptCount: monthReceiptAgg._count._all,
    avgCollectionCycleDays: collectionHealth.avgCollectionCycleDays,
    collectionPairCount: collectionHealth.collectionPairCount,
    rollingReceiptRate: collectionHealth.rollingReceiptRate,
  };
}

export async function getCustomerFinanceList(
  customerScope: { id: { in: string[] } } | null,
  page: number,
  pageSize: number,
  search?: string,
  includeArchived: boolean = false
): Promise<FinanceCustomerListResponse> {
  const where: Prisma.CrmCustomerProfileWhereInput = {
    deleted: false,
    ...(includeArchived ? {} : { archived: false }),
    ...(customerScope ? { id: customerScope.id } : {}),
    ...(search ? {
      OR: [
        { name: { contains: search } },
        { customerCode: { contains: search } },
        { organization: { contains: search } },
        { org: { canonicalName: { contains: search } } },
      ],
    } : {}),
  };

  const [profiles, total] = await Promise.all([
    prisma.crmCustomerProfile.findMany({
      where,
      select: {
        id: true,
        name: true,
        customerCode: true,
        organization: true,
        org: { select: { canonicalName: true } },
        profileOrders: {
          where: { deleted: false, ...getEffectiveOrderWhere(null) },
          select: {
            id: true, totalAmount: true, financeAmountOverride: true,
            financeTreatment: true, profileId: true,
          },
        },
        profileProjects: {
          where: { deleted: false },
          select: {
            id: true, budgetAmount: true, projectType: true,
            status: true, progress: true,
            invoices: {
              where: { status: { not: "CANCELLED" } },
              select: { totalAmount: true },
            },
          },
        },
      },
      skip: (page - 1) * pageSize,
      take: pageSize,
      orderBy: { name: "asc" },
    }),
    prisma.crmCustomerProfile.count({ where }),
  ]);

  const allOrderIds = profiles.flatMap((profile) => profile.profileOrders.map((order) => order.id));
  const linkMap = await buildOrderProjectLinkMap(allOrderIds);
  const collectionMetricsMap = await buildProfileCollectionMetricsMap(
    profiles.map((profile) => profile.id),
  );

  const items: CustomerFinanceItem[] = await Promise.all(
    profiles.map(async (profile) => {
      let standaloneOrderAmount = 0;
      let projectLinkedOrderAmount = 0;
      let onlineOrderTotal = 0;

      for (const o of profile.profileOrders) {
        const amt = computeOrderFinanceAmount(o);
        onlineOrderTotal += amt;
        const treatment = getOrderEffectiveTreatment(o.financeTreatment, linkMap.has(o.id));
        if (treatment === "PROJECT_INCLUDED") projectLinkedOrderAmount += amt;
        else if (treatment === "STANDALONE") standaloneOrderAmount += amt;
      }

      const profileOrderIds = profile.profileOrders.map((order) => order.id);
      const orderInvoices = await prisma.externalOrderInvoiceRequest.aggregate({
        _sum: { totalAmount: true },
        where: {
          status: { not: "CANCELLED" },
          adjustmentsAsOriginal: { none: { kind: { in: ["RED", "REISSUE"] } } },
          OR: [
            { externalOrder: { profileId: profile.id, mergedIntoId: null } },
            ...(profileOrderIds.length > 0 ? [{ orderId: { in: profileOrderIds } }] : []),
            ...(profileOrderIds.length > 0 ? [{ orderCoverage: { some: { orderId: { in: profileOrderIds } } } }] : []),
          ],
        },
      });

      const projectBudgetTotal = profile.profileProjects.reduce((sum, project) => sum + (project.budgetAmount || 0), 0);
      const projectInvoiced = profile.profileProjects.reduce(
        (sum, project) => sum + project.invoices.reduce((invoiceSum, invoice) => invoiceSum + invoice.totalAmount, 0),
        0,
      );

      const orderReceiptTotals = profileOrderIds.length > 0
        ? await getOrderReceiptTotals(profileOrderIds)
        : new Map<string, number>();
      const orderReceiptTotal = profileOrderIds.reduce((sum, orderId) => sum + (orderReceiptTotals.get(orderId) || 0), 0);
      const customerOnlyReceiptAgg = await prisma.financeReceipt.aggregate({
        _sum: { amount: true },
        where: {
          profileId: profile.id,
          orderId: null,
          deleted: false,
          allocations: { none: {} },
        },
      });
      const totalReceipt = orderReceiptTotal + (customerOnlyReceiptAgg._sum.amount || 0);

      const projectReceivable = profile.profileProjects.reduce((sum, project) => sum + computeProjectReceivable(project), 0);
      const receivableAmount = projectReceivable + standaloneOrderAmount;
      const projectRevenue = await computeBatchProjectRevenue(profile.profileProjects);
      const effectiveBusinessAmount = projectRevenue + standaloneOrderAmount;

      const collectionMetrics = collectionMetricsMap.get(profile.id);

      return {
        id: profile.id,
        name: profile.name ?? "未命名客户",
        customerCode: profile.customerCode ?? "------",
        organization: getCustomerOrganizationName({
          organization: profile.organization,
          org: profile.org,
        }),
        onlineOrderCount: profile.profileOrders.length,
        onlineOrderTotalAmount: roundForDisplay(centsToYuan(onlineOrderTotal)),
        projectLinkedOrderAmount: roundForDisplay(centsToYuan(projectLinkedOrderAmount)),
        standaloneOnlineOrderAmount: roundForDisplay(centsToYuan(standaloneOrderAmount)),
        projectCount: profile.profileProjects.length,
        projectBudgetTotalAmount: roundForDisplay(centsToYuan(projectBudgetTotal)),
        effectiveBusinessAmount: roundForDisplay(centsToYuan(effectiveBusinessAmount)),
        receivableAmount: roundForDisplay(centsToYuan(receivableAmount)),
        projectInvoicedAmount: roundForDisplay(centsToYuan(projectInvoiced)),
        orderInvoicedAmount: roundForDisplay(centsToYuan(orderInvoices._sum.totalAmount || 0)),
        totalReceiptAmount: roundForDisplay(centsToYuan(totalReceipt)),
        outstandingAmount: roundForDisplay(centsToYuan(receivableAmount - totalReceipt)),
        avgCollectionCycleDays: collectionMetrics?.avgCollectionCycleDays ?? null,
        collectionPairCount: collectionMetrics?.collectionPairCount ?? 0,
      };
    })
  );

  return { customers: items, total, page, pageSize };
}

export async function getCustomerFinanceDetail(
  profileId: string
): Promise<CustomerFinanceDetail | null> {
  const profile = await prisma.crmCustomerProfile.findUnique({
    where: { id: profileId, deleted: false },
    select: {
      id: true,
      name: true,
      customerCode: true,
      organization: true,
      wechat: true,
      principal: true,
      org: { select: { canonicalName: true } },
      profileOrders: {
        where: { deleted: false, ...getEffectiveOrderWhere(null) },
        select: {
          id: true, orderNo: true, totalAmount: true,
          orderedAt: true, customerMatchStatus: true,
          source: true, category: true, financeTreatment: true,
          financeAmountOverride: true,
        },
        orderBy: { orderedAt: "desc" },
      },
      profileProjects: {
        where: { deleted: false },
        select: {
          id: true, name: true, budgetAmount: true, projectType: true,
          status: true, progress: true,
          invoices: {
            where: { status: { not: "CANCELLED" } },
            select: { id: true, totalAmount: true, status: true, invoiceType: true, createdAt: true },
          },
        },
      },
    },
  });

  if (!profile) return null;

  const orderIds = profile.profileOrders.map((order) => order.id);
  const linkMap = await buildOrderProjectLinkMap(orderIds);

  const orderInvoices = await prisma.externalOrderInvoiceRequest.findMany({
    where: {
      status: { not: "CANCELLED" },
      adjustmentsAsOriginal: { none: { kind: { in: ["RED", "REISSUE"] } } },
      OR: [
        { externalOrder: { profileId, mergedIntoId: null } },
        ...(orderIds.length > 0 ? [{ orderId: { in: orderIds } }] : []),
        ...(orderIds.length > 0 ? [{ orderCoverage: { some: { orderId: { in: orderIds } } } }] : []),
      ],
    },
    select: { id: true, totalAmount: true, status: true, invoiceType: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });

  let standaloneOrderAmount = 0;
  let projectLinkedOrderAmount = 0;
  let onlineOrderTotal = 0;

  for (const o of profile.profileOrders) {
    const amt = computeOrderFinanceAmount(o);
    onlineOrderTotal += amt;
    const treatment = getOrderEffectiveTreatment(o.financeTreatment, linkMap.has(o.id));
    if (treatment === "PROJECT_INCLUDED") projectLinkedOrderAmount += amt;
    else if (treatment === "STANDALONE") standaloneOrderAmount += amt;
  }

  const projectBudgetTotal = profile.profileProjects.reduce((sum, project) => sum + (project.budgetAmount || 0), 0);
  const projectInvoiced = profile.profileProjects.reduce(
    (sum, project) => sum + project.invoices.reduce((invoiceSum, invoice) => invoiceSum + invoice.totalAmount, 0),
    0,
  );
  const orderInvoiced = orderInvoices.reduce((sum, i) => sum + i.totalAmount, 0);

  // Receipt total uses the same allocation-first口径 as the customer list and
  // /api/finance/order-receivables: allocations + legacy 1-to-1 receipts across
  // the customer's orders, plus customer-only receipts not tied to any order.
  const orderReceiptTotals = orderIds.length > 0
    ? await getOrderReceiptTotals(orderIds)
    : new Map<string, number>();
  const orderReceiptTotal = orderIds.reduce((sum, oid) => sum + (orderReceiptTotals.get(oid) || 0), 0);
  const customerOnlyReceiptAgg = await prisma.financeReceipt.aggregate({
    _sum: { amount: true },
    where: {
      profileId,
      orderId: null,
      deleted: false,
      allocations: { none: {} },
    },
  });
  const totalReceipt = orderReceiptTotal + (customerOnlyReceiptAgg._sum.amount || 0);
  const receiptLines = await fetchCustomerFinanceReceiptLines(profileId, orderIds);

  const projectReceivable = profile.profileProjects.reduce((sum, project) => sum + computeProjectReceivable(project), 0);
  const receivableAmount = projectReceivable + standaloneOrderAmount;
  const projectRevenue = await computeBatchProjectRevenue(profile.profileProjects);
  const effectiveBusinessAmount = projectRevenue + standaloneOrderAmount;

  const pairs = await getCollectionPairs();
  const mergedProfileIds = await resolveMergedProfileIds(profileId);
  const hasMergedHistory = mergedProfileIds.length > 1;
  const collectionSummary: CollectionSummaryMetrics = await buildProfileCollectionMetrics(
    mergedProfileIds,
    pairs,
    true,
  );

  return {
    customer: {
      id: profile.id,
      name: profile.name ?? "未命名客户",
      customerCode: profile.customerCode ?? "------",
      organization: profile.org?.canonicalName
        || profile.organization
        || null,
      wechat: profile.wechat ?? null,
      principal: profile.principal ?? null,
    },
    summary: {
      onlineOrderTotal: roundForDisplay(centsToYuan(onlineOrderTotal)),
      standaloneOnlineOrderAmount: roundForDisplay(centsToYuan(standaloneOrderAmount)),
      projectLinkedOrderAmount: roundForDisplay(centsToYuan(projectLinkedOrderAmount)),
      projectBudgetTotal: roundForDisplay(centsToYuan(projectBudgetTotal)),
      effectiveBusinessAmount: roundForDisplay(centsToYuan(effectiveBusinessAmount)),
      receivableAmount: roundForDisplay(centsToYuan(receivableAmount)),
      projectInvoicedAmount: roundForDisplay(centsToYuan(projectInvoiced)),
      orderInvoicedAmount: roundForDisplay(centsToYuan(orderInvoiced)),
      totalReceiptAmount: roundForDisplay(centsToYuan(totalReceipt)),
      outstandingAmount: roundForDisplay(centsToYuan(receivableAmount - totalReceipt)),
    },
    onlineOrders: profile.profileOrders.map((o) => ({
      id: o.id, orderNo: o.orderNo, totalAmount: roundForDisplay(centsToYuan(o.totalAmount)),
      orderedAt: o.orderedAt?.toISOString() ?? null, customerMatchStatus: o.customerMatchStatus,
      source: o.source, category: o.category, financeTreatment: o.financeTreatment,
      financeAmountOverride: o.financeAmountOverride != null ? roundForDisplay(centsToYuan(o.financeAmountOverride)) : null,
    })),
    projects: profile.profileProjects.map((p) => ({
      id: p.id, name: p.name, budgetAmount: p.budgetAmount != null ? roundForDisplay(centsToYuan(p.budgetAmount)) : null, status: p.status, progress: p.progress,
    })),
    projectInvoices: profile.profileProjects.flatMap((p) => p.invoices).map((i) => ({ ...i, totalAmount: roundForDisplay(centsToYuan(i.totalAmount)), createdAt: i.createdAt.toISOString() })),
    orderInvoices: orderInvoices.map((i) => ({ ...i, totalAmount: roundForDisplay(centsToYuan(i.totalAmount)), createdAt: i.createdAt.toISOString() })),
    receipts: receiptLines.map((r) => ({
      id: r.id,
      amount: roundForDisplay(centsToYuan(r.amount)),
      receivedAt: r.receivedAt.toISOString(),
      source: r.source,
      remark: r.remark,
    })),
    collectionSummary,
    hasMergedHistory,
  };
}

/**
 * Canonical actor-aware payment match query (T6.1).
 *
 * Shared by `POST /api/finance/payment-vouchers/match` and Agent
 * `finance.match_payment`. Capability gate, order scope, AND-composition,
 * subset-sum matching and partial/out-of-scope disclosure live here.
 */
import { prisma } from "@/lib/prisma";
import type { BusinessActor } from "@/lib/application/actor";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/application/errors";
import { getEffectiveCrmVisibleProfileIds } from "@/lib/crm/permissions";
import { loadInvoiceOutstandingAmounts } from "@/lib/finance/invoice-outstanding";
import { canReadFinance } from "@/lib/finance/permissions";
import { subsetSumMatch } from "@/lib/finance/subset-sum-matcher";
import {
  classifyTouchedOrderScope,
  collectTouchedOrderIdsFromRow,
  loadScopedOrderIdSetForActor,
} from "@/lib/finance/application/invoice-order-scope";

const MAX_RESULTS = 20;

export type PaymentMatchQueryInput = {
  organizationId: string;
  /** 到款金额，单位：分 */
  amountCents: number;
};

export type PaymentMatchCandidateInvoice = {
  id: string;
  invoiceNo: string | null;
  /** 票面金额，单位：分 */
  totalAmount: number;
  /** 剩余可核销，单位：分 */
  outstanding: number;
  issuedAt: string | null;
  orderId: string | null;
  profileId: string | null;
  profileIds: string[];
  buyerOrganizationName: string;
};

export type PaymentMatchCombination = {
  invoiceIds: string[];
  amounts: number[];
  sum: number;
  count: number;
  crossOrder: boolean;
  profileIds: string[];
  profileId: string | null;
  crossProfile: boolean;
  orderBreakdown: Array<{ orderId: string; sum: number }>;
};

export type PaymentMatchResult = {
  status: "MATCHED" | "NO_EXACT_MATCH";
  reason?: "SUM_SHORTFALL" | "NO_SUBSET_EQUALS";
  organization: { id: string; canonicalName: string };
  candidateInvoices: PaymentMatchCandidateInvoice[];
  orphanInvoiceCount: number;
  excludedCoveredInvoiceCount: number;
  excludedNonIssuedInvoiceCount: number;
  excludedFullyAllocatedInvoiceCount: number;
  /** 部分 touched order 在 scope 内、但未全量可见的发票数（仅计数，无 ID/金额） */
  partialScopeInvoiceCount: number;
  /** touched order 全部在 scope 外的 ISSUED 发票数（仅计数） */
  outOfScopeInvoiceCount: number;
  candidateTotal: number;
  combinations?: PaymentMatchCombination[];
  nearestBelow?: { sum: number; delta: number; count: number };
  nearestAbove?: { sum: number; delta: number; count: number };
  heuristicReference?: {
    invoiceIds: string[];
    amounts: number[];
    sum: number;
    count: number;
    method: "GREEDY_LARGEST_FIRST";
    note: string;
  };
  degraded: boolean;
  truncated?: boolean;
  hasMore?: boolean;
  totalCombinations?: number;
  diagnosticScopeNote?: string;
};

const DIAGNOSTIC_SCOPE_NOTE =
  "诊断计数（未绑机构 / 未开票 / 部分 scope）按 Profile 可见域或订单 scope 统计；可含 legacy 发票。候选发票要求全部 touched orders 在 actor scope 内。";

type RawInvoiceRow = {
  id: string;
  actualInvoiceNo: string | null;
  totalAmount: number;
  actualIssuedAt: Date | null;
  orderId: string | null;
  buyerOrganizationName: string;
  order: { profileId: string | null } | null;
  orderCoverage: Array<{ orderId: string; order: { profileId: string | null } | null }>;
};

export function assertFinanceMatchReadAccess(actor: BusinessActor): void {
  if (!canReadFinance(actor.role)) {
    throw new ForbiddenError();
  }
}

function collectInvoiceProfileIds(inv: {
  order: { profileId: string | null } | null;
  orderCoverage: Array<{ order: { profileId: string | null } | null }>;
}): string[] {
  const profiles = new Set<string>();
  if (inv.order?.profileId) profiles.add(inv.order.profileId);
  for (const cov of inv.orderCoverage) {
    if (cov.order?.profileId) profiles.add(cov.order.profileId);
  }
  return [...profiles];
}

function buildOrderBreakdown(
  invoiceIds: string[],
  amounts: number[],
  invoiceMap: Map<string, PaymentMatchCandidateInvoice>,
): Array<{ orderId: string; sum: number }> {
  const orderSums = new Map<string, number>();
  for (let i = 0; i < invoiceIds.length; i++) {
    const inv = invoiceMap.get(invoiceIds[i]);
    const oid = inv?.orderId || "__unknown__";
    orderSums.set(oid, (orderSums.get(oid) || 0) + amounts[i]);
  }
  return Array.from(orderSums.entries()).map(([orderId, sum]) => ({ orderId, sum }));
}

export async function queryPaymentMatchForActor(
  actor: BusinessActor,
  input: PaymentMatchQueryInput,
): Promise<PaymentMatchResult> {
  assertFinanceMatchReadAccess(actor);

  const { organizationId, amountCents: targetCents } = input;
  if (!organizationId?.trim()) {
    throw new ValidationError("organizationId 必填");
  }
  if (!Number.isFinite(targetCents) || targetCents <= 0) {
    throw new ValidationError("凭证金额必须大于 0");
  }

  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { id: true, canonicalName: true },
  });
  if (!org) {
    throw new NotFoundError("机构不存在");
  }

  const scopedOrderIdSet = await loadScopedOrderIdSetForActor(actor);

  const visibleProfileIds = await getEffectiveCrmVisibleProfileIds(actor.userId, actor.role);
  const scopedProfileIds = visibleProfileIds ? [...visibleProfileIds] : null;

  const orphanInvoiceCount = await prisma.externalOrderInvoiceRequest.count({
    where: {
      AND: [
        { buyerOrganizationId: null },
        { status: "ISSUED" },
        { adjustmentsAsOriginal: { none: { kind: { in: ["RED", "REISSUE"] } } } },
        { totalAmount: { gt: 0 } },
        scopedProfileIds
          ? {
              OR: [
                { order: { profileId: { in: scopedProfileIds } } },
                { externalOrder: { profileId: { in: scopedProfileIds } } },
              ],
            }
          : {},
      ],
    },
  });

  const excludedCoveredInvoiceCount = 0;

  const excludedNonIssuedInvoiceCount = await prisma.externalOrderInvoiceRequest.count({
    where: {
      AND: [
        { buyerOrganizationId: organizationId },
        { status: { not: "ISSUED" } },
        { totalAmount: { gt: 0 } },
        scopedProfileIds
          ? {
              OR: [
                { order: { profileId: { in: scopedProfileIds } } },
                { externalOrder: { profileId: { in: scopedProfileIds } } },
              ],
            }
          : {},
      ],
    },
  });

  const candidateInvoicesRaw = await prisma.externalOrderInvoiceRequest.findMany({
    where: {
      AND: [
        { buyerOrganizationId: organizationId },
        { status: "ISSUED" },
        { adjustmentsAsOriginal: { none: { kind: { in: ["RED", "REISSUE"] } } } },
        { totalAmount: { gt: 0 } },
        { OR: [{ orderId: { not: null } }, { orderCoverage: { some: {} } }] },
      ],
    },
    select: {
      id: true,
      actualInvoiceNo: true,
      totalAmount: true,
      actualIssuedAt: true,
      orderId: true,
      buyerOrganizationName: true,
      order: { select: { profileId: true } },
      orderCoverage: { select: { orderId: true, order: { select: { profileId: true } } } },
    },
    orderBy: { actualIssuedAt: { sort: "asc", nulls: "last" } },
  });

  const outstandingMap = await loadInvoiceOutstandingAmounts(
    candidateInvoicesRaw.map((inv) => ({ id: inv.id, totalAmount: inv.totalAmount })),
  );

  let excludedFullyAllocatedInvoiceCount = 0;
  let partialScopeInvoiceCount = 0;
  let outOfScopeInvoiceCount = 0;
  const candidateInvoices: PaymentMatchCandidateInvoice[] = [];

  for (const inv of candidateInvoicesRaw) {
    const outstanding = outstandingMap.get(inv.id) || 0;
    if (outstanding <= 0) {
      excludedFullyAllocatedInvoiceCount++;
      continue;
    }

    const scopeClass = classifyTouchedOrderScope(
      collectTouchedOrderIdsFromRow(inv),
      scopedOrderIdSet,
    );
    if (scopeClass === "partial") {
      partialScopeInvoiceCount++;
      continue;
    }
    if (scopeClass === "none") {
      outOfScopeInvoiceCount++;
      continue;
    }

    const profileIds = collectInvoiceProfileIds(inv);
    candidateInvoices.push({
      id: inv.id,
      invoiceNo: inv.actualInvoiceNo,
      totalAmount: inv.totalAmount,
      outstanding,
      issuedAt: inv.actualIssuedAt?.toISOString() ?? null,
      orderId: inv.orderId,
      profileId: profileIds.length === 1 ? profileIds[0] : null,
      profileIds,
      buyerOrganizationName: inv.buyerOrganizationName,
    });
  }

  const candidateTotal = candidateInvoices.reduce((s, inv) => s + inv.outstanding, 0);

  const baseResult = {
    organization: { id: org.id, canonicalName: org.canonicalName },
    candidateInvoices,
    orphanInvoiceCount,
    excludedCoveredInvoiceCount,
    excludedNonIssuedInvoiceCount,
    excludedFullyAllocatedInvoiceCount,
    partialScopeInvoiceCount,
    outOfScopeInvoiceCount,
    candidateTotal,
    diagnosticScopeNote: DIAGNOSTIC_SCOPE_NOTE,
  };

  if (candidateTotal < targetCents) {
    return {
      ...baseResult,
      status: "NO_EXACT_MATCH",
      reason: "SUM_SHORTFALL",
      nearestBelow: {
        sum: candidateTotal,
        delta: candidateTotal - targetCents,
        count: candidateInvoices.length,
      },
      degraded: false,
    };
  }

  const invoiceMap = new Map(candidateInvoices.map((inv) => [inv.id, inv]));
  const matchResult = subsetSumMatch({
    items: candidateInvoices.map((inv) => ({ id: inv.id, amountCents: inv.outstanding })),
    targetCents,
    maxCombinations: MAX_RESULTS,
  });

  if (matchResult.status === "MATCHED") {
    const combinations: PaymentMatchCombination[] = matchResult.combinations.map((combo) => {
      const ids = combo.map((c) => c.id);
      const amounts = combo.map((c) => c.amountCents);
      const sum = amounts.reduce((a, b) => a + b, 0);
      const orderIds = new Set(ids.map((id) => invoiceMap.get(id)!.orderId));
      const crossOrder = orderIds.size > 1;
      const orderBreakdown = buildOrderBreakdown(ids, amounts, invoiceMap);
      const rawProfileIds = ids.flatMap((id) => invoiceMap.get(id)!.profileIds);
      const distinctProfiles = [...new Set(rawProfileIds)];
      const hasUnbound = ids.some((id) => invoiceMap.get(id)!.profileIds.length === 0);
      const crossProfile = distinctProfiles.length > 1 || (distinctProfiles.length >= 1 && hasUnbound);
      return {
        invoiceIds: ids,
        amounts,
        sum,
        count: ids.length,
        crossOrder,
        orderBreakdown,
        profileIds: distinctProfiles,
        profileId: !crossProfile && distinctProfiles.length === 1 ? distinctProfiles[0] : null,
        crossProfile,
      };
    });

    combinations.sort((a, b) => {
      if (a.count !== b.count) return a.count - b.count;
      const minA = Math.min(
        ...a.invoiceIds.map((id) =>
          invoiceMap.get(id)!.issuedAt ? new Date(invoiceMap.get(id)!.issuedAt!).getTime() : Infinity,
        ),
      );
      const minB = Math.min(
        ...b.invoiceIds.map((id) =>
          invoiceMap.get(id)!.issuedAt ? new Date(invoiceMap.get(id)!.issuedAt!).getTime() : Infinity,
        ),
      );
      return minA - minB;
    });

    const truncated = matchResult.truncated ?? false;

    return {
      ...baseResult,
      status: "MATCHED",
      combinations,
      degraded: matchResult.degraded ?? false,
      truncated,
      hasMore: truncated || undefined,
      totalCombinations: matchResult.totalFound,
    };
  }

  const result: PaymentMatchResult = {
    ...baseResult,
    status: "NO_EXACT_MATCH",
    reason: "NO_SUBSET_EQUALS",
    degraded: matchResult.degraded ?? false,
  };

  if (matchResult.heuristicReference) {
    const ref = matchResult.heuristicReference;
    result.heuristicReference = {
      invoiceIds: ref.ids,
      amounts: ref.amounts,
      sum: ref.sum,
      count: ref.ids.length,
      method: "GREEDY_LARGEST_FIRST",
      note: "候选过多或精确/近似 DP 均超限，无法精确枚举；此为最大票优先贪心参考，非精确匹配，不可直接核销。",
    };
  }

  if (matchResult.nearestBelow !== undefined) {
    result.nearestBelow = {
      sum: matchResult.nearestBelow,
      delta: matchResult.nearestBelow - targetCents,
      count: 0,
    };
  }
  if (matchResult.nearestAbove !== undefined) {
    result.nearestAbove = {
      sum: matchResult.nearestAbove,
      delta: matchResult.nearestAbove - targetCents,
      count: 0,
    };
  }

  return result;
}

/** Agent adapter: map canonical result to compact tool output (same disclosure rules). */
export function shapePaymentMatchForAgent(
  result: PaymentMatchResult,
  amountCents: number,
): {
  status: PaymentMatchResult["status"];
  organization: { id: string; name: string };
  amountCents: number;
  candidateCount: number;
  partialScopeInvoiceCount: number;
  outOfScopeInvoiceCount: number;
  combinations: Array<{ invoiceIds: string[]; sum: number; count: number }>;
  candidateInvoices: Array<{
    id: string;
    totalAmount: number;
    outstanding: number;
    buyerOrganizationName: string;
  }>;
} {
  return {
    status: result.status,
    organization: {
      id: result.organization.id,
      name: result.organization.canonicalName,
    },
    amountCents,
    candidateCount: result.candidateInvoices.length,
    partialScopeInvoiceCount: result.partialScopeInvoiceCount,
    outOfScopeInvoiceCount: result.outOfScopeInvoiceCount,
    combinations: (result.combinations ?? []).slice(0, 5).map((c) => ({
      invoiceIds: c.invoiceIds,
      sum: c.sum,
      count: c.count,
    })),
    candidateInvoices: result.candidateInvoices.slice(0, 20).map((c) => ({
      id: c.id,
      totalAmount: c.totalAmount,
      outstanding: c.outstanding,
      buyerOrganizationName: c.buyerOrganizationName,
    })),
  };
}

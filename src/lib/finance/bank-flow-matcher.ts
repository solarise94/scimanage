/**
 * 银行流水批量匹配编排：组织解析 + 发票子集和。
 * 供 finance.match_bank_flow_rows 使用。
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  classifyTouchedOrderScope,
  collectTouchedOrderIdsFromRow,
  loadScopedOrderIdSetForActor,
} from "@/lib/finance/application/invoice-order-scope";
import { loadInvoiceOutstandingAmounts } from "@/lib/finance/invoice-outstanding";
import { subsetSumMatch } from "@/lib/finance/subset-sum-matcher";
import {
  getOrganizationResolveScopeWhere,
  resolveOrganizationsBatch,
  type OrgResolveResult,
} from "@/lib/organizations/resolve-core";

export type BankFlowRowStatus =
  | "PENDING"
  | "MATCHED"
  | "AMBIGUOUS_ORG"
  | "AMBIGUOUS_MATCH"
  | "NO_MATCH"
  | "ORG_NOT_FOUND"
  | "SKIPPED"
  | "CONFIRMED"
  | "FAILED";

export type BankFlowMatchCombination = {
  invoices: Array<{
    invoiceId: string;
    invoiceNo: string;
    amountCents: number;
    orderId: string;
  }>;
};

export type BankFlowMatchResult = {
  rowIndex: number;
  organization?: { id: string; name: string };
  orgCandidates?: Array<{ id: string; name: string; score: number }>;
  combinations?: BankFlowMatchCombination[];
  selectedCombinationIndex?: number;
  nearestBelow?: number;
  nearestAbove?: number;
};

export type BankFlowMatchSummary = {
  matched: number;
  ambiguousOrg: number;
  ambiguousMatch: number;
  noMatch: number;
  orgNotFound: number;
  skipped: number;
  total: number;
};

type CandidateInvoice = {
  id: string;
  invoiceNo: string;
  outstanding: number;
  orderId: string;
};

async function loadOutstandingInvoicesForOrgs(
  organizationIds: string[],
  userId: string,
  role: string,
): Promise<Map<string, CandidateInvoice[]>> {
  const result = new Map<string, CandidateInvoice[]>();
  if (organizationIds.length === 0) return result;

  const scopedOrderIdSet = await loadScopedOrderIdSetForActor({ userId, role });

  const invoices = await prisma.externalOrderInvoiceRequest.findMany({
    where: {
      AND: [
        { buyerOrganizationId: { in: organizationIds } },
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
      orderId: true,
      buyerOrganizationId: true,
      orderCoverage: { select: { orderId: true } },
    },
    orderBy: { actualIssuedAt: { sort: "asc", nulls: "last" } },
  });

  const outstandingMap = await loadInvoiceOutstandingAmounts(
    invoices.map((inv) => ({ id: inv.id, totalAmount: inv.totalAmount })),
  );

  for (const inv of invoices) {
    const orgId = inv.buyerOrganizationId;
    if (!orgId) continue;
    const outstanding = outstandingMap.get(inv.id) || 0;
    if (outstanding <= 0) continue;

    const scopeClass = classifyTouchedOrderScope(
      collectTouchedOrderIdsFromRow(inv),
      scopedOrderIdSet,
    );
    if (scopeClass !== "full") continue;

    const orderId =
      inv.orderId ||
      inv.orderCoverage[0]?.orderId ||
      "";
    const list = result.get(orgId) || [];
    list.push({
      id: inv.id,
      invoiceNo: inv.actualInvoiceNo || inv.id.slice(-6),
      outstanding,
      orderId,
    });
    result.set(orgId, list);
  }

  return result;
}

function matchOneRow(
  row: {
    index: number;
    payerName: string;
    amountCents: number;
    date?: string;
    remark?: string;
    status: BankFlowRowStatus;
  },
  orgResult: OrgResolveResult,
  invoicesByOrg: Map<string, CandidateInvoice[]>,
): { status: BankFlowRowStatus; match: BankFlowMatchResult } {
  const match: BankFlowMatchResult = { rowIndex: row.index };

  if (row.status === "SKIPPED" || row.amountCents <= 0) {
    return { status: "SKIPPED", match };
  }

  if (orgResult.status === "NOT_FOUND") {
    return { status: "ORG_NOT_FOUND", match };
  }

  if (orgResult.status === "AMBIGUOUS") {
    match.orgCandidates = orgResult.candidates;
    return { status: "AMBIGUOUS_ORG", match };
  }

  const org = orgResult.organization!;
  match.organization = org;

  const candidates = invoicesByOrg.get(org.id) || [];
  const subset = subsetSumMatch({
    items: candidates.map((c) => ({ id: c.id, amountCents: c.outstanding })),
    targetCents: row.amountCents,
    maxCombinations: 3,
  });

  if (subset.nearestBelow != null) match.nearestBelow = subset.nearestBelow;
  if (subset.nearestAbove != null) match.nearestAbove = subset.nearestAbove;

  if (subset.status !== "MATCHED" || subset.combinations.length === 0) {
    return { status: "NO_MATCH", match };
  }

  const invoiceMap = new Map(candidates.map((c) => [c.id, c]));
  match.combinations = subset.combinations.map((combo) => ({
    invoices: combo.map((item) => {
      const inv = invoiceMap.get(item.id)!;
      return {
        invoiceId: inv.id,
        invoiceNo: inv.invoiceNo,
        amountCents: inv.outstanding,
        orderId: inv.orderId,
      };
    }),
  }));

  if (match.combinations.length === 1) {
    match.selectedCombinationIndex = 0;
    return { status: "MATCHED", match };
  }

  // 多组合：自动选第一个（张数最少），但标记 AMBIGUOUS_MATCH 供用户确认
  match.selectedCombinationIndex = 0;
  return { status: "AMBIGUOUS_MATCH", match };
}

export async function matchBankFlowRows(opts: {
  userId: string;
  role: string;
  rows: Array<{
    index: number;
    payerName: string;
    amountCents: number;
    date?: string;
    remark?: string;
    status: BankFlowRowStatus;
  }>;
  /** 仅处理这些行；默认全部 PENDING */
  rowIndices?: number[];
}): Promise<{
  results: BankFlowMatchResult[];
  rowUpdates: Array<{ index: number; status: BankFlowRowStatus }>;
  summary: BankFlowMatchSummary;
}> {
  const targetIndices = new Set(
    opts.rowIndices ??
      opts.rows.filter((r) => r.status === "PENDING").map((r) => r.index),
  );

  const toProcess = opts.rows.filter(
    (r) => targetIndices.has(r.index) && r.status === "PENDING" && r.amountCents > 0,
  );

  const scopeWhere = await getOrganizationResolveScopeWhere(opts.userId, opts.role);
  const names = [...new Set(toProcess.map((r) => r.payerName).filter(Boolean))];
  const orgMap = await resolveOrganizationsBatch(names, scopeWhere);

  const resolvedOrgIds = [
    ...new Set(
      [...orgMap.values()]
        .filter((r) => r.status === "RESOLVED" && r.organization)
        .map((r) => r.organization!.id),
    ),
  ];
  const invoicesByOrg = await loadOutstandingInvoicesForOrgs(
    resolvedOrgIds,
    opts.userId,
    opts.role,
  );

  const results: BankFlowMatchResult[] = [];
  const rowUpdates: Array<{ index: number; status: BankFlowRowStatus }> = [];
  const summary: BankFlowMatchSummary = {
    matched: 0,
    ambiguousOrg: 0,
    ambiguousMatch: 0,
    noMatch: 0,
    orgNotFound: 0,
    skipped: 0,
    total: toProcess.length,
  };

  for (const row of toProcess) {
    const orgResult = orgMap.get(row.payerName) || { status: "NOT_FOUND" as const };
    const { status, match } = matchOneRow(row, orgResult, invoicesByOrg);
    results.push(match);
    rowUpdates.push({ index: row.index, status });
    if (status === "MATCHED") summary.matched += 1;
    else if (status === "AMBIGUOUS_ORG") summary.ambiguousOrg += 1;
    else if (status === "AMBIGUOUS_MATCH") summary.ambiguousMatch += 1;
    else if (status === "NO_MATCH") summary.noMatch += 1;
    else if (status === "ORG_NOT_FOUND") summary.orgNotFound += 1;
    else if (status === "SKIPPED") summary.skipped += 1;
  }

  // 跳过的负金额行也计入 summary
  for (const row of opts.rows) {
    if (!targetIndices.has(row.index)) continue;
    if (row.status === "SKIPPED" || row.amountCents <= 0) {
      if (!rowUpdates.some((u) => u.index === row.index)) {
        results.push({ rowIndex: row.index });
        rowUpdates.push({ index: row.index, status: "SKIPPED" });
        summary.skipped += 1;
        summary.total += 1;
      }
    }
  }

  return { results, rowUpdates, summary };
}

/**
 * 人工指定组织后，对该行重新计算发票组合（scoped）。
 * - 组织查询复用 `getOrganizationResolveScopeWhere`，禁止越权选 scope 外机构
 * - 重置旧组合 / 选择；返回全新 match 结果与行状态
 */
export async function rematchBankFlowRowWithOrganization(opts: {
  userId: string;
  role: string;
  row: {
    index: number;
    payerName: string;
    amountCents: number;
    date?: string;
    remark?: string;
  };
  organizationId: string;
}): Promise<{ status: BankFlowRowStatus; match: BankFlowMatchResult }> {
  const scopeWhere = await getOrganizationResolveScopeWhere(opts.userId, opts.role);
  const orgWhere: Prisma.OrganizationWhereInput = {
    id: opts.organizationId,
    deleted: false,
    archived: false,
    ...(scopeWhere ? { AND: [scopeWhere] } : {}),
  };
  const org = await prisma.organization.findFirst({
    where: orgWhere,
    select: { id: true, canonicalName: true },
  });
  if (!org) {
    return {
      status: "ORG_NOT_FOUND",
      match: { rowIndex: opts.row.index },
    };
  }

  const invoicesByOrg = await loadOutstandingInvoicesForOrgs(
    [org.id],
    opts.userId,
    opts.role,
  );

  return matchOneRow(
    {
      ...opts.row,
      status: "PENDING",
    },
    {
      status: "RESOLVED",
      organization: { id: org.id, name: org.canonicalName },
    },
    invoicesByOrg,
  );
}

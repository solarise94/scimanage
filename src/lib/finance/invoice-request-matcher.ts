/**
 * 订单开票申请候选匹配（确定性评分）。
 *
 * 只在有效 REQUESTED、无 RED/REISSUE、无正式附件的申请中筛选。
 * 分值只用于排序，硬冲突一律不能成为 EXACT。
 */

import { prisma } from "@/lib/prisma";
import {
  normalizeInvoiceNumber,
  normalizePartyName,
  normalizeTaxId,
  type ExtractedIssuedInvoice,
} from "@/lib/finance/invoice-ocr";

const INACTIVE_ADJUSTMENT_KINDS = ["RED", "REISSUE"] as const;
const MAX_CANDIDATES = 50;

export type InvoiceMatchStatus =
  | "EXACT"
  | "AMBIGUOUS"
  | "NO_MATCH"
  | "CONFLICT"
  | "DUPLICATE"
  | "OCR_FAILED";

export type InvoiceRequestCandidate = {
  invoiceRequestId: string;
  orderNo: string | null;
  orderTitle: string | null;
  projectName: string | null;
  buyerOrganizationName: string;
  totalAmountCents: number;
  invoiceType: string;
  score: number;
  reasons: string[];
  conflicts: string[];
  canSelect: boolean;
};

export type InvoiceMatchResult = {
  status: InvoiceMatchStatus;
  candidates: InvoiceRequestCandidate[];
  duplicate?: {
    kind: "INVOICE_NUMBER" | "FILE_HASH";
    invoiceRequestId: string;
    actualInvoiceNo: string | null;
  };
};

type CandidateRow = {
  id: string;
  totalAmount: number;
  invoiceType: string;
  buyerOrganizationName: string;
  buyerTaxId: string | null;
  sellerTaxId: string | null;
  sellerName: string | null;
  contentSummary: string | null;
  remark: string | null;
  createdAt: Date;
  order: { orderNo: string; title: string } | null;
  orderCoverage: Array<{
    order: { orderNo: string; title: string } | null;
  }>;
};

function hardConflicts(
  extracted: ExtractedIssuedInvoice,
  row: CandidateRow,
): string[] {
  const conflicts: string[] = [];

  if (
    extracted.totalAmountCents != null
    && extracted.totalAmountCents !== row.totalAmount
  ) {
    conflicts.push(
      `金额不一致：OCR ¥${(extracted.totalAmountCents / 100).toFixed(2)} / 申请 ¥${(row.totalAmount / 100).toFixed(2)}`,
    );
  }

  if (extracted.buyerTaxId && row.buyerTaxId) {
    if (normalizeTaxId(extracted.buyerTaxId) !== normalizeTaxId(row.buyerTaxId)) {
      conflicts.push("购方税号不一致");
    }
  }

  if (extracted.sellerTaxId && row.sellerTaxId) {
    if (normalizeTaxId(extracted.sellerTaxId) !== normalizeTaxId(row.sellerTaxId)) {
      conflicts.push("销方税号不一致");
    }
  }

  if (
    extracted.invoiceType !== "UNKNOWN"
    && row.invoiceType
    && extracted.invoiceType !== row.invoiceType
  ) {
    conflicts.push(
      `票种不一致：OCR ${extracted.invoiceType} / 申请 ${row.invoiceType}`,
    );
  }

  return conflicts;
}

function scoreCandidate(
  extracted: ExtractedIssuedInvoice,
  row: CandidateRow,
): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];

  if (extracted.totalAmountCents != null && extracted.totalAmountCents === row.totalAmount) {
    score += 50;
    reasons.push("金额一致");
  }
  if (
    extracted.buyerTaxId
    && row.buyerTaxId
    && normalizeTaxId(extracted.buyerTaxId) === normalizeTaxId(row.buyerTaxId)
  ) {
    score += 30;
    reasons.push("购方税号一致");
  }
  if (
    extracted.sellerTaxId
    && row.sellerTaxId
    && normalizeTaxId(extracted.sellerTaxId) === normalizeTaxId(row.sellerTaxId)
  ) {
    score += 20;
    reasons.push("销方税号一致");
  }
  if (
    extracted.invoiceType !== "UNKNOWN"
    && extracted.invoiceType === row.invoiceType
  ) {
    score += 10;
    reasons.push("票种一致");
  }
  if (
    extracted.buyerName
    && row.buyerOrganizationName
    && normalizePartyName(extracted.buyerName) === normalizePartyName(row.buyerOrganizationName)
  ) {
    score += 10;
    reasons.push("购方名称一致");
  }

  const haystack = [
    row.contentSummary,
    row.remark,
    row.order?.orderNo,
    row.order?.title,
    ...row.orderCoverage.map((c) => c.order?.orderNo),
    ...row.orderCoverage.map((c) => c.order?.title),
    ...extracted.itemNames,
  ]
    .filter(Boolean)
    .join(" ");

  if (extracted.itemNames.length > 0) {
    const hit = extracted.itemNames.some((name) => {
      const n = name.trim();
      return n.length >= 2 && haystack.includes(n);
    });
    if (hit) {
      score += 5;
      reasons.push("项目名命中");
    }
  }
  if (row.order?.orderNo && haystack.includes(row.order.orderNo) && extracted.itemNames.some((n) => n.includes(row.order!.orderNo))) {
    score += 5;
    reasons.push("订单号命中");
  }

  if (extracted.issuedAt) {
    const issued = new Date(`${extracted.issuedAt}T00:00:00.000Z`);
    const created = row.createdAt;
    const diffDays = (issued.getTime() - created.getTime()) / (24 * 60 * 60 * 1000);
    if (diffDays >= -7 && diffDays <= 120) {
      score += 5;
      reasons.push("开票日期在合理窗口");
    }
  }

  return { score, reasons };
}

function hasSufficientFacts(extracted: ExtractedIssuedInvoice): boolean {
  const amountOk = extracted.totalAmountCents != null;
  const partyOk = Boolean(extracted.buyerTaxId || extracted.sellerTaxId || extracted.buyerName);
  return amountOk && partyOk;
}

async function findDuplicateByInvoiceNumber(
  invoiceNumber: string | null,
): Promise<InvoiceMatchResult["duplicate"] | null> {
  const normalized = normalizeInvoiceNumber(invoiceNumber);
  if (!normalized) return null;

  const existing = await prisma.externalOrderInvoiceRequest.findFirst({
    where: {
      actualInvoiceNo: normalized,
      status: { in: ["REQUESTED", "ISSUED"] },
      adjustmentsAsOriginal: { none: { kind: { in: [...INACTIVE_ADJUSTMENT_KINDS] } } },
    },
    select: { id: true, actualInvoiceNo: true, status: true },
  });
  if (!existing) {
    // Also try case-insensitive / space-stripped via broader scan of recent ISSUED
    const recent = await prisma.externalOrderInvoiceRequest.findMany({
      where: {
        status: "ISSUED",
        actualInvoiceNo: { not: null },
        adjustmentsAsOriginal: { none: { kind: { in: [...INACTIVE_ADJUSTMENT_KINDS] } } },
      },
      orderBy: { updatedAt: "desc" },
      take: 200,
      select: { id: true, actualInvoiceNo: true },
    });
    const hit = recent.find(
      (r) => normalizeInvoiceNumber(r.actualInvoiceNo) === normalized,
    );
    if (!hit) return null;
    return {
      kind: "INVOICE_NUMBER",
      invoiceRequestId: hit.id,
      actualInvoiceNo: hit.actualInvoiceNo,
    };
  }
  return {
    kind: "INVOICE_NUMBER",
    invoiceRequestId: existing.id,
    actualInvoiceNo: existing.actualInvoiceNo,
  };
}

async function findDuplicateByFileHash(sha256: string): Promise<InvoiceMatchResult["duplicate"] | null> {
  const doc = await prisma.invoiceDocument.findFirst({
    where: {
      sha256,
      kind: "ACTUAL_INVOICE",
      externalOrderInvoiceRequest: {
        adjustmentsAsOriginal: { none: { kind: { in: [...INACTIVE_ADJUSTMENT_KINDS] } } },
      },
    },
    select: {
      externalOrderInvoiceRequestId: true,
      externalOrderInvoiceRequest: { select: { actualInvoiceNo: true } },
    },
  });
  if (!doc?.externalOrderInvoiceRequestId) return null;
  return {
    kind: "FILE_HASH",
    invoiceRequestId: doc.externalOrderInvoiceRequestId,
    actualInvoiceNo: doc.externalOrderInvoiceRequest?.actualInvoiceNo ?? null,
  };
}

/**
 * 在有效开票申请中匹配 OCR 结果。
 */
export async function matchInvoiceRequests(opts: {
  extracted: ExtractedIssuedInvoice;
  stagingSha256: string;
}): Promise<InvoiceMatchResult> {
  if (opts.extracted.isRedInvoice === true) {
    return {
      status: "CONFLICT",
      candidates: [],
    };
  }

  const hashDup = await findDuplicateByFileHash(opts.stagingSha256);
  if (hashDup) {
    return { status: "DUPLICATE", candidates: [], duplicate: hashDup };
  }

  const numberDup = await findDuplicateByInvoiceNumber(opts.extracted.invoiceNumber);
  if (numberDup) {
    return { status: "DUPLICATE", candidates: [], duplicate: numberDup };
  }

  const amountFilter =
    opts.extracted.totalAmountCents != null
      ? { totalAmount: opts.extracted.totalAmountCents }
      : {};

  const taxFilters: Array<Record<string, unknown>> = [];
  if (opts.extracted.buyerTaxId) {
    taxFilters.push({ buyerTaxId: opts.extracted.buyerTaxId });
    taxFilters.push({ buyerTaxId: normalizeTaxId(opts.extracted.buyerTaxId) });
  }
  if (opts.extracted.sellerTaxId) {
    taxFilters.push({ sellerTaxId: opts.extracted.sellerTaxId });
    taxFilters.push({ sellerTaxId: normalizeTaxId(opts.extracted.sellerTaxId) });
  }
  if (opts.extracted.buyerName) {
    taxFilters.push({
      buyerOrganizationName: { contains: opts.extracted.buyerName.slice(0, 20) },
    });
  }

  const recentCutoff = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);

  const rows = (await prisma.externalOrderInvoiceRequest.findMany({
    where: {
      status: "REQUESTED",
      adjustmentsAsOriginal: { none: { kind: { in: [...INACTIVE_ADJUSTMENT_KINDS] } } },
      documents: { none: { kind: "ACTUAL_INVOICE" } },
      createdAt: { gte: recentCutoff },
      AND: [
        Object.keys(amountFilter).length > 0 || taxFilters.length > 0
          ? {
              OR: [
                ...(Object.keys(amountFilter).length > 0 ? [amountFilter] : []),
                ...taxFilters,
              ],
            }
          : {},
      ],
    },
    orderBy: { createdAt: "desc" },
    take: MAX_CANDIDATES,
    select: {
      id: true,
      totalAmount: true,
      invoiceType: true,
      buyerOrganizationName: true,
      buyerTaxId: true,
      sellerTaxId: true,
      sellerName: true,
      contentSummary: true,
      remark: true,
      createdAt: true,
      order: { select: { orderNo: true, title: true } },
      orderCoverage: {
        take: 3,
        select: { order: { select: { orderNo: true, title: true } } },
      },
    },
  })) as CandidateRow[];

  // If narrow filter returned nothing but we have amount, broaden to amount-only / recent REQUESTED
  let candidatesSource = rows;
  if (candidatesSource.length === 0 && opts.extracted.totalAmountCents != null) {
    candidatesSource = (await prisma.externalOrderInvoiceRequest.findMany({
      where: {
        status: "REQUESTED",
        totalAmount: opts.extracted.totalAmountCents,
        adjustmentsAsOriginal: { none: { kind: { in: [...INACTIVE_ADJUSTMENT_KINDS] } } },
        documents: { none: { kind: "ACTUAL_INVOICE" } },
      },
      orderBy: { createdAt: "desc" },
      take: MAX_CANDIDATES,
      select: {
        id: true,
        totalAmount: true,
        invoiceType: true,
        buyerOrganizationName: true,
        buyerTaxId: true,
        sellerTaxId: true,
        sellerName: true,
        contentSummary: true,
        remark: true,
        createdAt: true,
        order: { select: { orderNo: true, title: true } },
        orderCoverage: {
          take: 3,
          select: { order: { select: { orderNo: true, title: true } } },
        },
      },
    })) as CandidateRow[];
  }

  const scored: InvoiceRequestCandidate[] = candidatesSource.map((row) => {
    const conflicts = hardConflicts(opts.extracted, row);
    const { score, reasons } = scoreCandidate(opts.extracted, row);
    const order = row.order ?? row.orderCoverage.find((c) => c.order)?.order ?? null;
    return {
      invoiceRequestId: row.id,
      orderNo: order?.orderNo ?? null,
      orderTitle: order?.title ?? null,
      projectName: null,
      buyerOrganizationName: row.buyerOrganizationName,
      totalAmountCents: row.totalAmount,
      invoiceType: row.invoiceType,
      score: conflicts.length > 0 ? Math.min(score, 20) : score,
      reasons,
      conflicts,
      canSelect: conflicts.length === 0,
    };
  });

  scored.sort((a, b) => b.score - a.score || a.invoiceRequestId.localeCompare(b.invoiceRequestId));

  const selectable = scored.filter((c) => c.canSelect);
  const conflicting = scored.filter((c) => !c.canSelect && c.score > 0);

  if (selectable.length === 0) {
    if (conflicting.length > 0) {
      return {
        status: "CONFLICT",
        candidates: scored.slice(0, 10),
      };
    }
    return { status: "NO_MATCH", candidates: [] };
  }

  const top = selectable[0];
  const second = selectable[1];
  const sufficient = hasSufficientFacts(opts.extracted);
  const clearLead = !second || top.score - second.score >= 20;
  const strongScore = top.score >= 50;

  if (sufficient && clearLead && strongScore && top.conflicts.length === 0) {
    return {
      status: "EXACT",
      candidates: scored.slice(0, 10),
    };
  }

  if (selectable.length >= 2 || !sufficient || !clearLead) {
    return {
      status: "AMBIGUOUS",
      candidates: scored.slice(0, 10),
    };
  }

  return {
    status: "AMBIGUOUS",
    candidates: scored.slice(0, 10),
  };
}

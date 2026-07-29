import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import type { NormalizedOrderRow } from "@/lib/external-order";
import {
  createMatchContext,
  resolveRowAgainstContext,
  summarizeRows,
  projectRowDisplay,
  SESSION_STATUS,
  SESSION_TERMINAL_STATUSES,
  ROW_STATUS,
  type RowStatus,
} from "@/lib/orders/import-session";

const PAGE_SIZE = 20;

// 筛选桶（§8.1）→ reviewStatus 条件
function filterToWhere(filter: string | null): Record<string, unknown> {
  switch (filter) {
    case null:
    case "":
    case "ALL":
      return {};
    case "CONFIRMED":
      return { reviewStatus: { in: [ROW_STATUS.CONFIRMED_EXISTING, ROW_STATUS.CONFIRMED_CREATE] } };
    case "PROBLEM":
      return { reviewStatus: { in: [ROW_STATUS.PARSE_FAILED, ROW_STATUS.REPRESENTATIVE_MISSING, ROW_STATUS.FAILED, ROW_STATUS.DROPPED] } };
    default:
      return { reviewStatus: filter };
  }
}

// 需要现算候选展示的行状态（未确认且可匹配）。
const NEEDS_CANDIDATES: readonly RowStatus[] = [
  ROW_STATUS.PENDING,
  ROW_STATUS.AUTO_SUGGESTED,
  ROW_STATUS.AMBIGUOUS,
  ROW_STATUS.NO_MATCH,
  ROW_STATUS.REPRESENTATIVE_MISSING,
];

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;
  const sess = await prisma.orderImportSession.findUnique({
    where: { id },
    select: {
      id: true, source: true, sourceRemark: true, category: true, status: true,
      fileName: true, createdAt: true, updatedAt: true,
    },
  });
  if (!sess) return NextResponse.json({ error: "会话不存在" }, { status: 404 });

  // GET 只读：不 heal。历史 CONFIRMED 缺 confirmedProfileId 的修复仅在 commit 等写路径做，
  // 且仅非终态会话，避免查看 COMMITTED/ABORTED/FAILED 历史改写审计记录。

  const url = new URL(req.url);
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get("pageSize") || String(PAGE_SIZE), 10) || PAGE_SIZE));
  const filter = url.searchParams.get("reviewStatus");
  const rowWhere = { sessionId: id, ...filterToWhere(filter) };

  // 会话级摘要：对全量行 groupBy（不受分页/筛选影响）。
  const grouped = await prisma.orderImportRow.groupBy({
    by: ["reviewStatus"],
    where: { sessionId: id },
    _count: { _all: true },
  });
  const summary = summarizeRows(
    grouped.flatMap((g) => Array.from({ length: g._count._all }, () => ({ reviewStatus: g.reviewStatus }))),
  );

  const total = await prisma.orderImportRow.count({ where: rowWhere });
  const rows = await prisma.orderImportRow.findMany({
    where: rowWhere,
    orderBy: { rowNo: "asc" },
    skip: (page - 1) * pageSize,
    take: pageSize,
    select: {
      id: true, rowNo: true, reviewStatus: true,
      normalizedPayloadJson: true, rawPayloadJson: true,
      suggestedProfileId: true, suggestedScore: true, suggestedReason: true,
      decisionType: true, confirmedProfileId: true, createCustomerDraftJson: true,
      finalOrderId: true, finalError: true,
    },
  });

  // 现算候选（§6.4.1：候选不持久化，按需用冻结的 normalizedPayload 重算）。
  const needsCtx = rows.some((r) => NEEDS_CANDIDATES.includes(r.reviewStatus as RowStatus));
  const ctx = needsCtx ? await createMatchContext() : null;

  // 批量取名字：只按 Profile ID（响应不再回退 Customer 锚点）。
  const profileIds = new Set<string>();
  for (const r of rows) {
    if (r.suggestedProfileId) profileIds.add(r.suggestedProfileId);
    if (r.confirmedProfileId) profileIds.add(r.confirmedProfileId);
  }
  const nameMap = new Map<string, string>();
  if (profileIds.size > 0) {
    const profiles = await prisma.crmCustomerProfile.findMany({
      where: { id: { in: [...profileIds] } },
      select: { id: true, name: true },
    });
    profiles.forEach((p) => nameMap.set(p.id, p.name ?? "未命名客户"));
  }

  const rowDtos = rows.map((r) => {
    const payload = projectRowDisplay(r.normalizedPayloadJson);
    let candidates: Array<{ profileId: string; name: string; score: number; reason: string }> = [];
    if (ctx && NEEDS_CANDIDATES.includes(r.reviewStatus as RowStatus)) {
      try {
        const row = JSON.parse(r.normalizedPayloadJson) as NormalizedOrderRow;
        candidates = resolveRowAgainstContext(ctx, row).candidates
          .filter((c): c is typeof c & { profileId: string } => !!c.profileId)
          .map((c) => ({
            profileId: c.profileId,
            name: c.name,
            score: c.score,
            reason: c.reason,
          }));
      } catch { candidates = []; }
    }
    let createCustomerDraft: unknown = null;
    if (r.createCustomerDraftJson) {
      try { createCustomerDraft = JSON.parse(r.createCustomerDraftJson); } catch { createCustomerDraft = null; }
    }
    const suggestedProfileId = r.suggestedProfileId ?? null;
    const confirmedProfileId = r.confirmedProfileId ?? null;
    return {
      id: r.id,
      rowNo: r.rowNo,
      reviewStatus: r.reviewStatus,
      payload,
      suggested: suggestedProfileId
        ? {
            profileId: suggestedProfileId,
            name: nameMap.get(suggestedProfileId) ?? null,
            score: r.suggestedScore,
            reason: r.suggestedReason,
          }
        : null,
      candidates,
      decisionType: r.decisionType,
      confirmedProfileId,
      confirmedCustomerName: confirmedProfileId ? nameMap.get(confirmedProfileId) ?? null : null,
      createCustomerDraft,
      finalOrderId: r.finalOrderId,
      finalError: r.finalError,
    };
  });

  return NextResponse.json({
    session: sess,
    summary,
    rows: rowDtos,
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  });
}

/** PATCH：会话级操作。目前支持 status=ABORTED（用户取消整批）。 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;
  const body = await req.json().catch(() => null);
  const nextStatus = (body?.status as string | undefined)?.trim();
  if (nextStatus !== SESSION_STATUS.ABORTED) {
    return NextResponse.json({ error: "仅支持 status=ABORTED" }, { status: 400 });
  }

  const sess = await prisma.orderImportSession.findUnique({ where: { id }, select: { status: true } });
  if (!sess) return NextResponse.json({ error: "会话不存在" }, { status: 404 });
  if (SESSION_TERMINAL_STATUSES.includes(sess.status as never)) {
    return NextResponse.json({ error: `会话已是终态（${sess.status}），不能取消` }, { status: 409 });
  }

  await prisma.orderImportSession.update({ where: { id }, data: { status: SESSION_STATUS.ABORTED } });
  return NextResponse.json({ ok: true, status: SESSION_STATUS.ABORTED });
}

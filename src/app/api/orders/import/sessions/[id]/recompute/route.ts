import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import type { NormalizedOrderRow } from "@/lib/external-order";
import {
  createMatchContext,
  resolveRowAgainstContext,
  reviewStatusFromResolution,
  RECOMPUTABLE_STATUSES,
  ROW_STATUS,
  SESSION_STATUS,
  SESSION_TERMINAL_STATUSES,
  summarizeRows,
} from "@/lib/orders/import-session";

/**
 * POST /api/orders/import/sessions/[id]/recompute
 *
 * §7.5：仅刷新「未确认」行（RECOMPUTABLE_STATUSES = PENDING/AUTO_SUGGESTED/AMBIGUOUS/NO_MATCH）。
 * 用冻结的 normalizedPayload 对最新客户库重新匹配，更新 suggested* + reviewStatus。
 * 绝不触碰 CONFIRMED_* / IMPORTED / DROPPED / PARSE_FAILED / REPRESENTATIVE_MISSING 行。
 * 客户库在确认过程中可能新增（如别处建档），recompute 让待确认行吃到最新匹配。
 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;
  const sess = await prisma.orderImportSession.findUnique({ where: { id }, select: { status: true } });
  if (!sess) return NextResponse.json({ error: "会话不存在" }, { status: 404 });
  if (SESSION_TERMINAL_STATUSES.includes(sess.status as never)) {
    return NextResponse.json({ error: `会话已是终态（${sess.status}），不能 recompute` }, { status: 409 });
  }

  const rows = await prisma.orderImportRow.findMany({
    where: { sessionId: id, reviewStatus: { in: [...RECOMPUTABLE_STATUSES] } },
    select: { id: true, normalizedPayloadJson: true },
  });

  let updatedCount = 0;
  if (rows.length > 0) {
    const ctx = await createMatchContext();
    const updates = rows.map((r) => {
      let nextStatus: string;
      let suggestedProfileId: string | null = null;
      let suggestedScore: number | null = null;
      let suggestedReason: string | null = null;
      try {
        const parsed = JSON.parse(r.normalizedPayloadJson) as NormalizedOrderRow;
        const resolution = resolveRowAgainstContext(ctx, parsed);
        nextStatus = reviewStatusFromResolution(resolution);
        suggestedProfileId = resolution.status === "AUTO_SUGGESTED" ? resolution.suggestedProfileId : null;
        suggestedScore = resolution.best?.score ?? null;
        suggestedReason = resolution.best?.reason ?? null;
      } catch {
        nextStatus = ROW_STATUS.NO_MATCH;
      }
      return { id: r.id, reviewStatus: nextStatus, suggestedProfileId, suggestedScore, suggestedReason };
    });
    // 交互式事务（callback 形态）才支持 timeout；批量数组形态只接受 isolationLevel。
    await prisma.$transaction(async (tx) => {
      for (const u of updates) {
        await tx.orderImportRow.update({
          where: { id: u.id },
          data: {
            reviewStatus: u.reviewStatus,
            suggestedProfileId: u.suggestedProfileId,
            suggestedScore: u.suggestedScore,
            suggestedReason: u.suggestedReason,
          },
        });
      }
    }, { timeout: 60000 });
    updatedCount = rows.length;
  }

  // 重算会话摘要并落库。
  const grouped = await prisma.orderImportRow.groupBy({
    by: ["reviewStatus"],
    where: { sessionId: id },
    _count: { _all: true },
  });
  const summary = summarizeRows(
    grouped.flatMap((g) => Array.from({ length: g._count._all }, () => ({ reviewStatus: g.reviewStatus }))),
  );
  await prisma.orderImportSession.update({
    where: { id },
    data: { summaryJson: JSON.stringify(summary), status: SESSION_STATUS.REVIEWING },
  });

  return NextResponse.json({ ok: true, recomputed: updatedCount, summary });
}

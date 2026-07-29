import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  DECISION_TYPE,
  ROW_STATUS,
  SESSION_TERMINAL_STATUSES,
} from "@/lib/orders/import-session";
import { findActiveProfile } from "@/lib/crm/ids";

/**
 * POST /api/orders/import/sessions/[id]/rows/batch-accept
 *
 * §7.4「接受全部高置信建议」：把会话内所有 AUTO_SUGGESTED 行一次性确认为 USE_SUGGESTION
 * （confirmedProfileId = suggestedProfileId，CONFIRMED_EXISTING）。AMBIGUOUS / NO_MATCH 不动。
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;
  const sess = await prisma.orderImportSession.findUnique({ where: { id }, select: { status: true } });
  if (!sess) return NextResponse.json({ error: "会话不存在" }, { status: 404 });
  if (SESSION_TERMINAL_STATUSES.includes(sess.status as never)) {
    return NextResponse.json({ error: `会话已是终态（${sess.status}），不能修改` }, { status: 409 });
  }

  const rows = await prisma.orderImportRow.findMany({
    where: {
      sessionId: id,
      reviewStatus: ROW_STATUS.AUTO_SUGGESTED,
      suggestedProfileId: { not: null },
    },
    select: { id: true, suggestedProfileId: true },
  });

  if (rows.length === 0) return NextResponse.json({ ok: true, accepted: 0 });

  let accepted = 0;
  await prisma.$transaction(async (tx) => {
    for (const r of rows) {
      const ref = await findActiveProfile(r.suggestedProfileId, tx);
      if (!ref) continue;
      await tx.orderImportRow.update({
        where: { id: r.id },
        data: {
          decisionType: DECISION_TYPE.USE_SUGGESTION,
          confirmedProfileId: ref.profileId,
          createCustomerDraftJson: null,
          reviewStatus: ROW_STATUS.CONFIRMED_EXISTING,
        },
      });
      accepted++;
    }
  }, { timeout: 60000 });

  return NextResponse.json({ ok: true, accepted });
}

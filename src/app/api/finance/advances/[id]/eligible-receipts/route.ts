import { NextRequest, NextResponse } from "next/server";
import { requirePortalSession } from "@/lib/application/http-error-mapping";
import { prisma } from "@/lib/prisma";
import { getFinanceProfileScopeWhere, getFinanceProjectScopeWhere } from "@/lib/finance/permissions";
import { centsToYuan } from "@/lib/finance/money";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gated = await requirePortalSession();
  if (!gated.ok) return gated.response;
  const session = gated.session;
  if (session.user.role !== "ADMIN" && session.user.role !== "USER") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const advance = await prisma.financeAdvance.findUnique({
    where: { id },
    select: { id: true, amount: true, orderId: true, projectId: true, profileId: true, status: true },
  });
  if (!advance) return NextResponse.json({ error: "垫付记录不存在" }, { status: 404 });
  if (advance.status === "REFUNDED" || advance.status === "WRITTEN_OFF") {
    return NextResponse.json({ eligible: [], message: "垫付已完结" });
  }

  // Scope check
  if (session.user.role !== "ADMIN") {
    const [profileScope, projScope] = await Promise.all([
      getFinanceProfileScopeWhere(session.user.id, session.user.role),
      getFinanceProjectScopeWhere(session.user.id, session.user.role),
    ]);
    const custOk = !profileScope || (advance.profileId && profileScope.id.in.includes(advance.profileId));
    const projOk = !projScope || (advance.projectId && projScope.id.in.includes(advance.projectId));
    if (!custOk && !projOk) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Find receipts linked to the same order, project, or customer
  const receiptOr: Record<string, unknown>[] = [];
  if (advance.orderId) receiptOr.push({ orderId: advance.orderId });
  if (advance.projectId) receiptOr.push({ projectId: advance.projectId });
  if (advance.profileId) receiptOr.push({ profileId: advance.profileId });
  if (receiptOr.length === 0) return NextResponse.json({ eligible: [] });

  const receipts = await prisma.financeReceipt.findMany({
    where: { OR: receiptOr, deleted: false },
    select: {
      id: true,
      amount: true,
      receivedAt: true,
      source: true,
      orderId: true,
      projectId: true,
      profileId: true,
      order: { select: { orderNo: true } },
      project: { select: { name: true } },
      profile: { select: { name: true } },
    },
    orderBy: { receivedAt: "desc" },
  });

  // Get ALL refunds globally per receipt to compute accurate receipt-level remaining
  const receiptIds = receipts.map((r) => r.id);
  const allReceiptRefunds = await prisma.financeAdvanceRefund.findMany({
    where: { settledByReceiptId: { in: receiptIds } },
    select: { settledByReceiptId: true, amount: true },
  });

  const receiptRefunded = new Map<string, number>();
  for (const r of allReceiptRefunds) {
    if (r.settledByReceiptId) {
      receiptRefunded.set(r.settledByReceiptId, (receiptRefunded.get(r.settledByReceiptId) || 0) + r.amount);
    }
  }

  const advanceRefunds = await prisma.financeAdvanceRefund.findMany({
    where: { advanceId: id },
    select: { amount: true },
  });
  const totalRefunded = advanceRefunds.reduce((s, r) => s + r.amount, 0);
  const advanceRemaining = advance.amount - totalRefunded;

  const eligible = receipts.map((r) => {
    const used = receiptRefunded.get(r.id) || 0;
    const receiptAvailable = r.amount - used;
    return {
      id: r.id,
      amount: centsToYuan(r.amount),
      receivedAt: r.receivedAt,
      source: r.source,
      orderNo: r.order?.orderNo || null,
      projectName: r.project?.name || null,
      customerName: r.profile?.name || null,
      availableForRefund: centsToYuan(Math.min(receiptAvailable, advanceRemaining)),
      totalUsed: centsToYuan(used),
    };
  }).filter((e) => e.availableForRefund > 0);

  return NextResponse.json({ eligible });
}

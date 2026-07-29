import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { getOrderSummary } from "@/lib/orders/application/get-order-detail";
import { businessActorFromSessionUser } from "@/lib/application/actor";
import { ApplicationError } from "@/lib/application/errors";
import { centsToYuan } from "@/lib/finance/money";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;

  // capability / scope / receipt 口径都在 canonical service 内。out-of-scope 与
  // 不存在均返回 404（不泄露存在性）。回款额改用 canonical 口径
  // (getOrderReceiptTotals：allocation + legacy)，而非旧的仅 legacy 聚合。
  const actor = businessActorFromSessionUser(session.user);
  let summary: Awaited<ReturnType<typeof getOrderSummary>>;
  try {
    summary = await getOrderSummary(actor, id);
  } catch (err) {
    if (err instanceof ApplicationError) {
      return NextResponse.json({ error: err.message }, { status: err.httpStatus });
    }
    throw err;
  }

  return NextResponse.json({
    orderId: summary.orderId,
    orderNo: summary.orderNo,
    orderAmount: centsToYuan(summary.orderAmount),
    effectiveAmount: centsToYuan(summary.effectiveAmount),
    financeTreatment: summary.financeTreatment,
    category: summary.category,
    status: summary.status,
    receiptAmount: centsToYuan(summary.receiptAmount),
  });
}

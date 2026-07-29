import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { rematchOrdersFromSnapshots } from "@/lib/orders/governance-scan";

/**
 * POST /api/admin/data-governance/rematch-order
 * Body: { orderIds: string[] }
 *
 * G1 增强（§11.2 / §11.6.A）：对订单用其原始快照（含 buyerMiniProgramIdSnapshot）重跑
 * Profile-first 匹配，返回三态建议（AUTO_SUGGESTED / AMBIGUOUS / NO_MATCH）+ 候选列表。
 * 仅返回建议，不落绑——人工在「无客户订单」页确认后再走 batch-bind-customer。
 */
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const orderIds: string[] = Array.isArray(body?.orderIds) ? body.orderIds : [];
  if (orderIds.length === 0) {
    return NextResponse.json({ error: "请至少选择一条订单" }, { status: 400 });
  }
  if (orderIds.length > 200) {
    return NextResponse.json({ error: "单次重新匹配不超过 200 条" }, { status: 400 });
  }

  const results = await rematchOrdersFromSnapshots(orderIds);
  return NextResponse.json({ results });
}

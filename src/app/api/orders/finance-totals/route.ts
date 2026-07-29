import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isOrderAccessBlocked, getOrderScopeWhere } from "@/lib/orders/permissions";
import { getOrderInvoiceTotals, getOrderReceiptTotals, getOrderCostTotals } from "@/lib/finance/order-receivables";
import { centsToYuan } from "@/lib/finance/money";

export const dynamic = "force-dynamic";

// 单次最多解析的订单数，防滥用（列表页一页最多 100 行，对齐 pageSize 上限）
const MAX_ORDER_IDS = 100;

/**
 * GET /api/orders/finance-totals?orderIds=id1,id2,...
 * 批量返回订单的发票/回款/成本汇总（金额出参转元）。
 * 供订单列表金额下拉懒加载，一次请求覆盖整页，避免 N+1。
 * scope：用 getOrderScopeWhere 过滤入参 orderIds，只返回用户可见订单（ADMIN 跳过）。
 */
export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (isOrderAccessBlocked(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const raw = req.nextUrl.searchParams.get("orderIds") || "";
  const requestedIds = [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))];
  if (requestedIds.length === 0) {
    return NextResponse.json({ totals: {} });
  }
  if (requestedIds.length > MAX_ORDER_IDS) {
    return NextResponse.json({ error: `一次最多查询 ${MAX_ORDER_IDS} 个订单` }, { status: 400 });
  }

  // scope 过滤：只保留用户能看到的订单 ID（ADMIN scopeWhere=null → 全量）
  const scopeWhere = await getOrderScopeWhere(session.user.id, session.user.role, prisma, session.user.department);
  const visible = await prisma.order.findMany({
    where: scopeWhere
      ? { AND: [scopeWhere, { id: { in: requestedIds }, deleted: false }] }
      : { id: { in: requestedIds }, deleted: false },
    select: { id: true },
  });
  const orderIds = visible.map((o) => o.id);
  if (orderIds.length === 0) {
    return NextResponse.json({ totals: {} });
  }

  const [invoiceMap, receiptMap, costMap] = await Promise.all([
    getOrderInvoiceTotals(orderIds),
    getOrderReceiptTotals(orderIds),
    getOrderCostTotals(orderIds),
  ]);

  const totals: Record<string, { invoiced: number; received: number; cost: number }> = {};
  for (const id of orderIds) {
    totals[id] = {
      invoiced: centsToYuan(invoiceMap.get(id) || 0),
      received: centsToYuan(receiptMap.get(id) || 0),
      cost: centsToYuan(costMap.get(id) || 0),
    };
  }

  return NextResponse.json({ totals });
}

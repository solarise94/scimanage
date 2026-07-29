import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getOrderScopeWhere } from "@/lib/orders/permissions";

/**
 * 销量看板数据 API（设计 §10 P2）。
 *
 * 基于共享 Order facts 的本部门聚合（金额/单量/按状态分布），只读。
 * 数据查询必须走现有 Order scope（getOrderScopeWhere，已有部门过滤），
 * 不绕过部门隔离。ONLINE_OPS 部门用户看本部门；ADMIN 看全部。
 *
 * 金额单位与 Order.totalAmount 一致（分）。
 */
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || !session.user.role) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const role = session.user.role;
  const userId = session.user.id;
  const department = session.user.department;

  // scope 复用现有 Order 部门隔离逻辑（设计 §6.2）。
  const scopeWhere = await getOrderScopeWhere(userId, role, prisma, department);

  const { searchParams } = req.nextUrl;
  const dateFromStr = searchParams.get("dateFrom") || undefined;
  const dateToStr = searchParams.get("dateTo") || undefined;

  const dateRange: Record<string, Date> = {};
  if (dateFromStr) {
    const d = new Date(dateFromStr);
    if (!Number.isNaN(d.getTime())) dateRange.gte = d;
  }
  if (dateToStr) {
    const d = new Date(dateToStr);
    if (!Number.isNaN(d.getTime())) dateRange.lte = d;
  }

  const where: Record<string, unknown> = {};
  if (scopeWhere) {
    where.AND = [scopeWhere];
  }
  if (dateFromStr || dateToStr) {
    (where.AND as Array<Record<string, unknown>>) = [
      ...((where.AND as Array<Record<string, unknown>>) ?? []),
      { createdAt: dateRange },
    ];
  }

  // 总额（分）+ 单量
  const agg = await prisma.order.aggregate({
    _sum: { totalAmount: true },
    _count: { _all: true },
    where,
  });

  // 按状态分布
  const byStatus = await prisma.order.groupBy({
    by: ["status"],
    _sum: { totalAmount: true },
    _count: { _all: true },
    where,
  });

  // 近 12 周趋势（按周聚合，避免逐日数据点过多）
  const since = new Date();
  since.setDate(since.getDate() - 7 * 12);
  const trendWhere = {
    ...where,
    createdAt: { gte: since },
  };
  const trendRows = await prisma.order.findMany({
    where: trendWhere,
    select: { totalAmount: true, createdAt: true, status: true },
  });

  type WeekBucket = { weekStart: string; amount: number; count: number };
  const buckets = new Map<string, WeekBucket>();
  for (const row of trendRows) {
    const ts = row.createdAt.getTime();
    // ISO 周一为周首（与项目既有报表习惯一致）
    const day = row.createdAt.getUTCDay(); // 0=Sun..6=Sat
    const offset = day === 0 ? 6 : day - 1;
    const monday = new Date(ts - offset * 86400000);
    monday.setUTCHours(0, 0, 0, 0);
    const key = monday.toISOString().slice(0, 10);
    const b = buckets.get(key) ?? { weekStart: key, amount: 0, count: 0 };
    b.amount += row.totalAmount;
    b.count += 1;
    buckets.set(key, b);
  }
  const trend = Array.from(buckets.values()).sort((a, b) =>
    a.weekStart.localeCompare(b.weekStart),
  );

  return NextResponse.json({
    totals: {
      amount: agg._sum.totalAmount ?? 0,
      count: agg._count._all,
    },
    byStatus: byStatus.map((s) => ({
      status: s.status,
      amount: s._sum.totalAmount ?? 0,
      count: s._count._all,
    })),
    trend: trend.map((t) => ({
      weekStart: t.weekStart,
      amount: t.amount,
      count: t.count,
    })),
    filters: {
      dateFrom: dateFromStr ?? null,
      dateTo: dateToStr ?? null,
    },
  });
}

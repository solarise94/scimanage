import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isOrderAccessBlocked, getOrderScopeWhere, getEffectiveOrderWhere } from "@/lib/orders/permissions";
import { centsToYuan } from "@/lib/finance/money";
import { parseDateRange } from "@/lib/orders/date-range";
import { getBusinessMonthWindow } from "@/lib/business-time";

export const dynamic = "force-dynamic";

/**
 * GET /api/orders/stats
 * 订单管理 KPI 概览：透传与 /api/orders 相同的筛选参数，返回 5 项聚合。
 * /api/orders GET 只返回分页列表无聚合，不可复用，故单独建端点。
 * 金额出参统一 centsToYuan 转元（与 orders 系 API 约定一致）。
 */
export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (isOrderAccessBlocked(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const url = req.nextUrl;
  const search = url.searchParams.get("search")?.trim() || "";
  const source = url.searchParams.get("source")?.trim() || "";
  const status = url.searchParams.get("status")?.trim() || "";
  const category = url.searchParams.get("category")?.trim() || "";
  const customerMatchStatus = url.searchParams.get("customerMatchStatus")?.trim() || "";
  const financeTreatment = url.searchParams.get("financeTreatment")?.trim() || "";
  const profileId = url.searchParams.get("profileId")?.trim() || "";
  const projectId = url.searchParams.get("projectId")?.trim() || "";
  const representativeId = url.searchParams.get("representativeId")?.trim() || "";
  const createdFrom = url.searchParams.get("createdFrom")?.trim() || "";
  const createdTo = url.searchParams.get("createdTo")?.trim() || "";
  const deliveredFrom = url.searchParams.get("deliveredFrom")?.trim() || "";
  const deliveredTo = url.searchParams.get("deliveredTo")?.trim() || "";
  const includeDeleted = url.searchParams.get("includeDeleted") === "true" && session.user.role === "ADMIN";

  // Profile-only 契约：旧 *CustomerId 系查询参数一律 400（Phase E 删列后随旧列一起移除）。
  // 用键名枚举而非硬编码字段名，避免在源码里引用已废弃契约。
  const legacyParam = [...url.searchParams.keys()].find((k) => /customerids?$/i.test(k));
  if (legacyParam) {
    return NextResponse.json(
      { error: `请使用 profileId（不再接受 ${legacyParam}）` },
      { status: 400 },
    );
  }

  const scopeWhere = await getOrderScopeWhere(session.user.id, session.user.role, prisma, session.user.department);

  // ── 复用 /api/orders 的 AND-composition where 构建（严禁覆盖 scopeWhere）──
  const andConditions: Record<string, unknown>[] = [];
  if (scopeWhere) andConditions.push(scopeWhere);
  if (search) {
    andConditions.push({
      OR: [
        { orderNo: { contains: search } },
        { externalOrderNo: { contains: search } },
        { title: { contains: search } },
        { buyerNameSnapshot: { contains: search } },
        { buyerPhoneSnapshot: { contains: search } },
        { buyerOrgNameSnapshot: { contains: search } },
        { buyerAddressSnapshot: { contains: search } },
      ],
    });
  }
  const filters: Record<string, unknown> = {};
  if (source) filters.source = source;
  if (status) filters.status = status;
  if (category) filters.category = category;
  if (customerMatchStatus) filters.customerMatchStatus = customerMatchStatus;
  if (financeTreatment) filters.financeTreatment = financeTreatment;
  if (profileId) filters.profileId = profileId;
  if (representativeId) filters.representativeId = representativeId;
  if (Object.keys(filters).length > 0) andConditions.push(filters);
  if (projectId) andConditions.push({ projectLinks: { some: { projectId } } });

  // 日期区间筛选（与 /api/orders 完全对称）：created* → orderedAt，delivered* → deliveredAt
  const createdRange = parseDateRange(createdFrom, createdTo);
  if (createdRange) andConditions.push({ orderedAt: createdRange });
  const deliveredRange = parseDateRange(deliveredFrom, deliveredTo);
  if (deliveredRange) andConditions.push({ deliveredAt: deliveredRange });

  andConditions.push({ deleted: false });
  if (includeDeleted) {
    // 管理员显式要求回收站可见性时，移除 deleted:false 限制
    andConditions.pop();
  }

  const where: Record<string, unknown> = andConditions.length === 1 ? andConditions[0] : { AND: andConditions };

  // 已确认范围：活跃确认态（CONFIRMED/DELIVERED）+ 计提冲回影子订单（CLOSED + accrualReversalOfId 非空）
  // 普通关闭的 CLOSED 订单不计入。
  const confirmedWhere = {
    AND: [
      getEffectiveOrderWhere(where),
      { source: { not: "ACCRUAL_REVERSAL" } },
    ],
  };

  // 区间计数（periodCount）跟随用户当前筛选的区间字段，避免错误交集：
  // - 选了「交付」区间 → 区间已并入 where（按 deliveredAt），periodCount = 该区间订单数
  // - 选了「新建」区间 → 区间已并入 where（按 orderedAt），periodCount = 该区间订单数
  // - 都没选 → 回退「本月新建」语义（orderedAt >= 月初），是 total 的子集
  const { start: monthStart, end: nextMonthStart } = getBusinessMonthWindow();
  const hasPeriod = !!(createdRange || deliveredRange);
  const periodCountWhere = hasPeriod
    ? where
    : { AND: [where, { orderedAt: { not: null, gte: monthStart, lt: nextMonthStart } }] };

  const [total, draftCount, confirmedAgg, receivedAgg, periodCount] = await Promise.all([
    prisma.order.count({ where: { AND: [where, { source: { not: "ACCRUAL_REVERSAL" } }] } }),
    prisma.order.count({ where: { AND: [where, { status: "DRAFT", source: { not: "ACCRUAL_REVERSAL" } }] } }),
    prisma.order.aggregate({ where: confirmedWhere, _sum: { totalAmount: true } }),
    prisma.financeReceipt.aggregate({
      where: { deleted: false, order: { is: confirmedWhere } },
      _sum: { amount: true },
    }),
    prisma.order.count({ where: { AND: [periodCountWhere, { source: { not: "ACCRUAL_REVERSAL" } }] } }),
  ]);

  const confirmedAmountCents = confirmedAgg._sum.totalAmount ?? 0;
  const receivedAmountCents = receivedAgg._sum.amount ?? 0;
  const pendingReceivableCents = Math.max(0, confirmedAmountCents - receivedAmountCents);

  return NextResponse.json({
    total,
    draftCount,
    confirmedAmount: centsToYuan(confirmedAmountCents),
    pendingReceivable: centsToYuan(pendingReceivableCents),
    periodCount,
    // 区间口径回显，便于前端 KPI 卡标题切换（"本月新增" / "区间新增" / "区间交付"）
    periodType: deliveredRange ? "delivered" : createdRange ? "created" : "",
  });
}

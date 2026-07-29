import { NextRequest, NextResponse } from "next/server";
import { requirePortalSession } from "@/lib/application/http-error-mapping";
import { isFinanceBlocked, getFinanceProjectScopeWhere } from "@/lib/finance/permissions";
import { isValidCostType, resolveAndValidateCostRefs } from "@/lib/finance/costs";
import { toPublicOrder } from "@/lib/crm/public-dto";
import { prisma } from "@/lib/prisma";
import { yuanToCents, centsToYuan } from "@/lib/finance/money";

export async function GET(req: NextRequest) {
  const gated = await requirePortalSession();
  if (!gated.ok) return gated.response;
  const session = gated.session;
  if (isFinanceBlocked(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const url = req.nextUrl;
  const costType = url.searchParams.get("costType")?.trim() || "";
  const projectId = url.searchParams.get("projectId")?.trim() || "";
  const orderId = url.searchParams.get("orderId")?.trim() || "";
  const profileId = url.searchParams.get("profileId")?.trim() || "";
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
  const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get("pageSize") || "20", 10)));

  // 旧 *CustomerId 系查询参数一律 400（键名枚举，避免在源码里引用已废弃契约）。
  const legacyKey = [...url.searchParams.keys()].find((k) => /customerids?$/i.test(k));
  if (legacyKey) {
    return NextResponse.json(
      { error: `请使用 profileId 筛选成本（不再接受 ${legacyKey}）` },
      { status: 400 },
    );
  }

  const andConditions: Record<string, unknown>[] = [];
  if (costType) andConditions.push({ costType });
  if (projectId) andConditions.push({ projectId });
  if (orderId) andConditions.push({ orderId });
  if (profileId) andConditions.push({ profileId });

  // USER scope: costs where the user can see the related entity
  if (session.user.role !== "ADMIN") {
    const projScope = await getFinanceProjectScopeWhere(session.user.id, session.user.role);
    // Also build order scope: orders the user can access
    const { getOrderScopeWhere } = await import("@/lib/orders/permissions");
    const orderScope = await getOrderScopeWhere(session.user.id, session.user.role, prisma, session.user.department);

    const scopeOr: Record<string, unknown>[] = [];

    if (projScope) {
      scopeOr.push({ projectId: projScope.id });
    }
    // Profile-only 成本：通过可见 Profile + 订单 scope 覆盖
    const { getEffectiveCrmVisibleProfileIds } = await import("@/lib/crm/permissions");
    const visibleProfiles = await getEffectiveCrmVisibleProfileIds(session.user.id, session.user.role);
    if (visibleProfiles && visibleProfiles.size > 0) {
      scopeOr.push({ profileId: { in: [...visibleProfiles] } });
    } else if (visibleProfiles === null && session.user.role === "USER") {
      const ownedProfiles = await prisma.crmCustomerProfile.findMany({
        where: { ownerUserId: session.user.id, deleted: false, archived: false },
        select: { id: true },
      });
      if (ownedProfiles.length > 0) {
        scopeOr.push({ profileId: { in: ownedProfiles.map((p) => p.id) } });
      }
    }
    if (orderScope) {
      const scopedOrders = await prisma.order.findMany({
        where: orderScope,
        select: { id: true },
      });
      const scopedOrderIds = scopedOrders.map((o) => o.id);
      if (scopedOrderIds.length > 0) {
        scopeOr.push({ orderId: { in: scopedOrderIds } });
      }
    }

    if (scopeOr.length === 0) {
      andConditions.push({ createdById: session.user.id });
    } else {
      andConditions.push({ OR: scopeOr });
    }
  }

  const where: Record<string, unknown> = andConditions.length === 1 ? andConditions[0] : { AND: andConditions };

  const [costs, total] = await Promise.all([
    prisma.financeCost.findMany({
      where,
      include: {
        profile: { select: { id: true, name: true } },
        order: { select: { id: true, orderNo: true } },
        project: { select: { id: true, name: true } },
        createdBy: { select: { id: true, name: true } },
      },
      orderBy: { occurredAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.financeCost.count({ where }),
  ]);

  return NextResponse.json({
    costs: costs.map((c) => {
      const { amount, profile, ...rest } = toPublicOrder(c);
      const profileDto = profile
        ? { id: profile.id, name: profile.name ?? null }
        : null;
      return {
        ...rest,
        profile: profileDto,
        // 展示字段与 profile 同形；缺 Profile 的旧行显式标记，不再回退 Customer
        customer: profileDto,
        profileMissing: !c.profileId || !profile,
        amount: centsToYuan(amount),
      };
    }),
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  });
}

export async function POST(req: NextRequest) {
  const gated = await requirePortalSession();
  if (!gated.ok) return gated.response;
  const session = gated.session;
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json();
  // 旧 *CustomerId 系参数一律 400（键名枚举，避免在源码里引用已废弃契约）。
  const legacyKey = Object.keys(body).find((k) => /customerids?$/i.test(k));
  if (legacyKey) {
    return NextResponse.json(
      { error: `请使用 profileId 指定客户（不再接受 ${legacyKey}）` },
      { status: 400 },
    );
  }
  const { amount, costType, profileId: bodyProfileId, orderId, projectId, occurredAt, remark } = body as Record<string, unknown>;

  if (amount == null || !Number.isFinite(Number(amount)) || Number(amount) <= 0) {
    return NextResponse.json({ error: "金额必须为正数" }, { status: 400 });
  }
  if (!costType || !isValidCostType(costType as string)) {
    return NextResponse.json({ error: `无效的成本类型: ${costType}` }, { status: 400 });
  }

  const profileId =
    typeof bodyProfileId === "string" && bodyProfileId.trim() ? bodyProfileId.trim() : null;

  // Validate entity refs
  const validation = await resolveAndValidateCostRefs({
    profileId,
    orderId: (orderId as string) || null,
    projectId: (projectId as string) || null,
  });
  if (!validation.valid) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }
  if (!validation.resolvedProfileId) {
    return NextResponse.json({ error: "必须关联有效的客户档案（profileId）" }, { status: 400 });
  }

  const cost = await prisma.financeCost.create({
    data: {
      amount: yuanToCents(Number(amount)),
      costType: costType as string,
      profileId: validation.resolvedProfileId,
      orderId: (orderId as string) || null,
      projectId: (validation.resolvedProjectId ?? (projectId as string)) || null,
      occurredAt: occurredAt ? new Date(occurredAt as string) : new Date(),
      remark: (remark as string)?.trim() || null,
      createdById: session.user.id,
    },
    include: {
      profile: { select: { id: true, name: true } },
      order: { select: { id: true, orderNo: true } },
      project: { select: { id: true, name: true } },
    },
  });

  const { amount: amountCents, profile, ...rest } = toPublicOrder(cost);
  const profileDto = profile
    ? { id: profile.id, name: profile.name ?? null }
    : null;
  return NextResponse.json({
    cost: {
      ...rest,
      profile: profileDto,
      customer: profileDto,
      profileMissing: !cost.profileId || !profile,
      amount: centsToYuan(amountCents),
    },
  }, { status: 201 });
}

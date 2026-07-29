import { NextRequest, NextResponse } from "next/server";
import { requirePortalSession } from "@/lib/application/http-error-mapping";
import { prisma } from "@/lib/prisma";
import { canReadFinanceAdvance, getFinanceProfileScopeWhere, getFinanceProjectScopeWhere } from "@/lib/finance/permissions";
import { getOrderScopeWhere } from "@/lib/orders/permissions";
import { getEffectiveCrmVisibleProfileIds } from "@/lib/crm/permissions";
import { yuanToCents, centsToYuan } from "@/lib/finance/money";

/**
 * 预存款（FinanceAdvance）：语义已从"垫付→回款核销退款"升级为"充值→消费抵扣"（见设计 §10.2）。
 * resolveAndValidateAdvance 允许预存款充值只关联 Profile（不强制 order/project）。
 */
async function resolveAndValidateAdvance(
  userId: string,
  role: string,
  profileId?: string | null,
  orderId?: string | null,
  projectId?: string | null,
): Promise<{ valid: boolean; resolvedProfileId: string | null; resolvedProjectId: string | null }> {
  let resolvedProfileId = profileId || null;
  let resolvedProjId = projectId || null;

  // Resolve from order
  if (orderId) {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { profileId: true, projectLinks: { select: { projectId: true } } },
    });
    if (!order) return { valid: false, resolvedProfileId: null, resolvedProjectId: null };
    if (!resolvedProfileId && order.profileId) resolvedProfileId = order.profileId;
    if (!resolvedProjId && order.projectLinks.length > 0) resolvedProjId = order.projectLinks[0].projectId;
    if (profileId && order.profileId && order.profileId !== profileId) return { valid: false, resolvedProfileId: null, resolvedProjectId: null };
    if (projectId && order.projectLinks.length > 0) {
      if (!order.projectLinks.some((l) => l.projectId === projectId)) return { valid: false, resolvedProfileId: null, resolvedProjectId: null };
    }
  }

  // Resolve from project
  if (projectId) {
    const proj = await prisma.project.findUnique({
      where: { id: projectId },
      select: { profileId: true },
    });
    if (!proj) return { valid: false, resolvedProfileId: null, resolvedProjectId: null };
    if (!resolvedProfileId && proj.profileId) resolvedProfileId = proj.profileId;
    if (!resolvedProjId) resolvedProjId = projectId;
    if (profileId && proj.profileId && proj.profileId !== profileId) return { valid: false, resolvedProfileId: null, resolvedProjectId: null };
  }

  // Cross-validate
  if (resolvedProfileId && resolvedProjId) {
    const proj = await prisma.project.findUnique({
      where: { id: resolvedProjId },
      select: { profileId: true },
    });
    if (proj?.profileId && proj.profileId !== resolvedProfileId) {
      return { valid: false, resolvedProfileId: null, resolvedProjectId: null };
    }
  }

  if (resolvedProfileId) {
    const profile = await prisma.crmCustomerProfile.findFirst({
      where: { id: resolvedProfileId, deleted: false },
      select: { id: true },
    });
    if (!profile) {
      return { valid: false, resolvedProfileId: null, resolvedProjectId: null };
    }
  }

  if (role === "ADMIN") return { valid: true, resolvedProfileId, resolvedProjectId: resolvedProjId };

  const [profileScope, projScope] = await Promise.all([
    getFinanceProfileScopeWhere(userId, role),
    getFinanceProjectScopeWhere(userId, role),
  ]);

  if (resolvedProfileId && profileScope && !profileScope.id.in.includes(resolvedProfileId)) return { valid: false, resolvedProfileId: null, resolvedProjectId: null };
  if (resolvedProjId && projScope && !projScope.id.in.includes(resolvedProjId)) return { valid: false, resolvedProfileId: null, resolvedProjectId: null };
  if (!resolvedProfileId && !resolvedProjId && profileScope) return { valid: false, resolvedProfileId: null, resolvedProjectId: null };

  return { valid: true, resolvedProfileId, resolvedProjectId: resolvedProjId };
}

export async function GET(req: NextRequest) {
  const gated = await requirePortalSession();
  if (!gated.ok) return gated.response;
  const session = gated.session;
  if (!canReadFinanceAdvance(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { searchParams } = req.nextUrl;
  const profileId = searchParams.get("profileId");
  const orderId = searchParams.get("orderId");
  const projectId = searchParams.get("projectId");
  const page = Math.max(1, parseInt(searchParams.get("page") || "1"));
  const pageSize = Math.min(100, Math.max(1, parseInt(searchParams.get("pageSize") || "20")));

  // 旧 *CustomerId 系查询参数一律 400（键名枚举，避免在源码里引用已废弃契约）。
  const legacyKey = [...searchParams.keys()].find((k) => /customerids?$/i.test(k));
  if (legacyKey) {
    return NextResponse.json(
      { error: `请使用 profileId 筛选预存款（不再接受 ${legacyKey}）` },
      { status: 400 },
    );
  }

  const where: Record<string, unknown> = {};
  if (profileId) where.profileId = profileId;
  if (orderId) where.orderId = orderId;
  if (projectId) where.projectId = projectId;

  if (session.user.role !== "ADMIN") {
    const isRepresentative = session.user.role === "REPRESENTATIVE";
    if (isRepresentative) {
      // Representatives can only browse advances by a specific visible order.
      if (!orderId) {
        return NextResponse.json({ error: "请通过订单筛选" }, { status: 400 });
      }
      if (profileId || projectId) {
        return NextResponse.json({ error: "只能通过订单筛选" }, { status: 400 });
      }

      const orderScope = await getOrderScopeWhere(session.user.id, session.user.role, prisma, session.user.department);
      if (!orderScope) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      const inScope = await prisma.order.count({
        where: { id: orderId, deleted: false, AND: [orderScope] },
      });
      if (inScope === 0) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      where.orderId = orderId;
    } else {
      const orConditions: Record<string, unknown>[] = [];
      const [visibleProfileIds, projScope, orderScope] = await Promise.all([
        getEffectiveCrmVisibleProfileIds(session.user.id, session.user.role),
        getFinanceProjectScopeWhere(session.user.id, session.user.role),
        getOrderScopeWhere(session.user.id, session.user.role, prisma, session.user.department),
      ]);
      if (visibleProfileIds && visibleProfileIds.size > 0) {
        orConditions.push({ profileId: { in: [...visibleProfileIds] } });
      }
      if (projScope) orConditions.push({ projectId: { in: projScope.id.in } });
      if (orderScope) orConditions.push({ order: { AND: [orderScope, { deleted: false }] } });
      if (orConditions.length > 0) {
        where.OR = orConditions;
      } else {
        return NextResponse.json({ advances: [], total: 0, page, pageSize });
      }
    }
  }

  const [advances, total] = await Promise.all([
    prisma.financeAdvance.findMany({
      where,
      include: {
        profile: { select: { id: true, name: true } },
        order: { select: { id: true, orderNo: true } },
        project: { select: { id: true, name: true } },
        refunds: { select: { id: true, amount: true, refundedAt: true } },
        createdBy: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.financeAdvance.count({ where }),
  ]);

  return NextResponse.json({
    advances: advances.map((a) => ({
      ...a,
      customer: a.profile ? { id: a.profile.id, name: a.profile.name } : null,
      amount: centsToYuan(a.amount),
      refunds: a.refunds.map((r) => ({ ...r, amount: centsToYuan(r.amount) })),
    })),
    total,
    page,
    pageSize,
  });
}

export async function POST(req: NextRequest) {
  const gated = await requirePortalSession();
  if (!gated.ok) return gated.response;
  const session = gated.session;
  if (session.user.role !== "ADMIN" && session.user.role !== "USER") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json();
  // 旧 *CustomerId 系参数一律 400（键名枚举，避免在源码里引用已废弃契约）。
  const legacyKey = Object.keys(body).find((k) => /customerids?$/i.test(k));
  if (legacyKey) {
    return NextResponse.json({ error: `请使用 profileId（不再接受 ${legacyKey}）` }, { status: 400 });
  }
  const { profileId, orderId, projectId, amount, advancedAt, remark } = body;

  if (!amount || typeof amount !== "number" || amount <= 0) {
    return NextResponse.json({ error: "金额必须大于 0" }, { status: 400 });
  }

  const { valid, resolvedProfileId, resolvedProjectId } = await resolveAndValidateAdvance(
    session.user.id, session.user.role, profileId, orderId, projectId,
  );
  if (!valid) return NextResponse.json({ error: "实体引用不一致或权限不足" }, { status: 400 });

  const advance = await prisma.financeAdvance.create({
    data: {
      profileId: resolvedProfileId,
      orderId: orderId || null,
      projectId: resolvedProjectId,
      amount: yuanToCents(amount),
      advancedAt: advancedAt ? new Date(advancedAt) : new Date(),
      remark: remark?.trim() || null,
      createdById: session.user.id,
    },
    include: {
      profile: { select: { id: true, name: true } },
      order: { select: { id: true, orderNo: true } },
      refunds: true,
    },
  });

  return NextResponse.json({
    advance: {
      ...advance,
      customer: advance.profile ? { id: advance.profile.id, name: advance.profile.name } : null,
      amount: centsToYuan(advance.amount),
      refunds: advance.refunds.map((r) => ({ ...r, amount: centsToYuan(r.amount) })),
    },
  }, { status: 201 });
}

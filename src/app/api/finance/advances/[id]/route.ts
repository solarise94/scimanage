import { NextRequest, NextResponse } from "next/server";
import { requirePortalSession } from "@/lib/application/http-error-mapping";
import { prisma } from "@/lib/prisma";
import { canReadFinanceAdvance, getFinanceProfileScopeWhere, getFinanceProjectScopeWhere } from "@/lib/finance/permissions";
import { getOrderScopeWhere } from "@/lib/orders/permissions";
import { centsToYuan } from "@/lib/finance/money";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gated = await requirePortalSession();
  if (!gated.ok) return gated.response;
  const session = gated.session;
  if (!canReadFinanceAdvance(session.user.role)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;
  const advance = await prisma.financeAdvance.findUnique({
    where: { id },
    include: {
      profile: { select: { id: true, name: true } },
      order: { select: { id: true, orderNo: true } },
      project: { select: { id: true, name: true } },
      refunds: { orderBy: { createdAt: "desc" } },
      createdBy: { select: { id: true, name: true } },
    },
  });

  if (!advance) return NextResponse.json({ error: "垫付记录不存在" }, { status: 404 });

  if (session.user.role !== "ADMIN") {
    const orderScope = await getOrderScopeWhere(session.user.id, session.user.role, prisma, session.user.department);
    let orderOk = false;
    if (advance.orderId && orderScope) {
      const inScope = await prisma.order.count({
        where: { id: advance.orderId, deleted: false, AND: [orderScope] },
      });
      orderOk = inScope > 0;
    }

    if (session.user.role === "REPRESENTATIVE") {
      if (!orderOk) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    } else {
      const [profileScope, projScope] = await Promise.all([
        getFinanceProfileScopeWhere(session.user.id, session.user.role),
        getFinanceProjectScopeWhere(session.user.id, session.user.role),
      ]);
      const custOk = !profileScope || (advance.profileId && profileScope.id.in.includes(advance.profileId));
      const projOk = !projScope || (advance.projectId && projScope.id.in.includes(advance.projectId));
      if (!custOk && !projOk && !orderOk) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  return NextResponse.json({
    advance: {
      ...advance,
      customer: advance.profile ? { id: advance.profile.id, name: advance.profile.name } : null,
      amount: centsToYuan(advance.amount),
      refunds: advance.refunds.map((r) => ({ ...r, amount: centsToYuan(r.amount) })),
    },
  });
}

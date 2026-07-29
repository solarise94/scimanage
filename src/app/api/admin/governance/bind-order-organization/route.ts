import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

/**
 * POST /api/admin/governance/bind-order-organization
 * 订单购买方机构补绑（Order.buyerOrganizationId）。
 *
 * body: { orderIds: string[], organizationId: string }
 * - 仅补 metadata（Order.buyerOrganizationId），不改 customerId / representativeId / 财务归属。
 * - 校验 Organization 存在、未删除归档。这里绑定的是订单购买方机构，不是最终发票抬头。
 * - 不执行财务关联守卫（与 bind-order-customer 的风险等级不同）。
 */
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const orderIds: string[] = Array.isArray(body?.orderIds) ? body.orderIds : [];
  const organizationId: string | undefined = body?.organizationId;

  if (orderIds.length === 0) {
    return NextResponse.json({ error: "请至少选择一条订单" }, { status: 400 });
  }
  if (orderIds.length > 500) {
    return NextResponse.json({ error: "单次最多处理 500 条" }, { status: 400 });
  }
  if (!organizationId) {
    return NextResponse.json({ error: "organizationId 为必填" }, { status: 400 });
  }

  // 机构校验：必须存在、未删除归档。是否可作为发票抬头由发票创建链路校验。
  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { id: true, canonicalName: true, archived: true, deleted: true },
  });
  if (!org || org.deleted) {
    return NextResponse.json({ error: "指定机构不存在或已删除" }, { status: 400 });
  }
  if (org.archived) {
    return NextResponse.json({ error: "指定机构已归档，无法绑定" }, { status: 400 });
  }

  const result = {
    bound: 0,
    skipped: 0,
    errors: [] as Array<{ orderId: string; error: string }>,
  };

  for (const orderId of orderIds) {
    try {
      const updated = await prisma.order.updateMany({
        where: { id: orderId, buyerOrganizationId: null, deleted: false },
        data: { buyerOrganizationId: organizationId },
      });
      if (updated.count === 0) {
        result.skipped++;
        continue;
      }
      result.bound++;
    } catch (e) {
      result.errors.push({ orderId, error: e instanceof Error ? e.message : "绑定失败" });
    }
  }

  return NextResponse.json(result);
}

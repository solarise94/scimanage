import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { resolveCustomerBusinessContext } from "@/lib/business/customer-context";
import { findActiveProfile } from "@/lib/crm/ids";
import { orderHasFinancialAssociations } from "@/lib/orders/governance-scan";

type BindMode = "BIND" | "REBIND";

const DEFAULT_REBIND_REASON = "governance_rebind";

/**
 * POST /api/admin/governance/bind-order-customer
 * 统一订单↔客户绑定/换绑写路径。
 *
 * body: { orderIds: string[], profileId: string, mode?: "BIND"|"REBIND", reason?: string, confirm?: boolean }
 *  - BIND（默认）：仅作用于 profileId 为 null 的订单（含 Customer-only 遗留脏数据）。
 *  - REBIND：作用于已挂 Profile 的订单，改绑到新 Profile。
 *  - 成功写入一律只落 profileId，并清空 customerId。
 */
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = (await req.json().catch(() => ({}))) ?? {};

  // 旧 *CustomerId 系参数一律 400（键名枚举，避免在源码里引用已废弃契约）。
  const legacyKey = Object.keys(body).find((k) => /customerids?$/i.test(k));
  if (legacyKey) {
    return NextResponse.json(
      { error: `请使用 profileId 指定目标客户（不再接受 ${legacyKey}）` },
      { status: 400 },
    );
  }

  const orderIds: string[] = Array.isArray(body?.orderIds) ? body.orderIds : [];
  const profileId: string | undefined =
    typeof body?.profileId === "string" ? body.profileId.trim() : undefined;
  const mode: BindMode = body?.mode === "REBIND" ? "REBIND" : "BIND";
  const rawReason: string | undefined =
    typeof body?.reason === "string" ? body.reason.trim() : undefined;
  const confirm: boolean = body?.confirm === true;

  const reason: string =
    rawReason && rawReason.length > 0
      ? rawReason
      : mode === "REBIND"
        ? DEFAULT_REBIND_REASON
        : "governance_bind";

  if (orderIds.length === 0) {
    return NextResponse.json({ error: "请至少选择一条订单" }, { status: 400 });
  }
  if (orderIds.length > 500) {
    return NextResponse.json({ error: "单次最多处理 500 条" }, { status: 400 });
  }
  if (!profileId) {
    return NextResponse.json({ error: "profileId 为必填" }, { status: 400 });
  }

  const ref = await findActiveProfile(profileId, prisma);
  if (!ref) {
    return NextResponse.json({ error: "目标客户不存在、已删除或已合并" }, { status: 400 });
  }

  const profile = await prisma.crmCustomerProfile.findUnique({
    where: { id: ref.profileId },
    select: { id: true, archived: true, deleted: true },
  });
  if (!profile || profile.deleted) {
    return NextResponse.json({ error: "目标客户不存在、已删除或已合并" }, { status: 400 });
  }
  if (profile.archived) {
    return NextResponse.json({ error: "目标客户已归档，无法绑定" }, { status: 400 });
  }

  // REBIND 财务关联守卫：先一次性确认所有目标订单是否存在财务数据。
  if (mode === "REBIND") {
    const financialChecks = await Promise.all(
      orderIds.map(async (orderId) => ({
        orderId,
        hasFinance: await orderHasFinancialAssociations(orderId, prisma),
      })),
    );
    const affectedOrderIds = financialChecks.filter((c) => c.hasFinance).map((c) => c.orderId);

    if (affectedOrderIds.length > 0) {
      const reasonMissing = !rawReason || rawReason === DEFAULT_REBIND_REASON;
      if (reasonMissing || !confirm) {
        return NextResponse.json(
          {
            error: "REBIND_REQUIRES_CONFIRMATION",
            message:
              `所选 ${affectedOrderIds.length} 条订单已存在发票或回款记录，换绑将影响财务归属。` +
              (reasonMissing ? "请填写换绑原因。" : "") +
              (!confirm ? "请显式确认后继续。" : ""),
            affectedOrderIds,
            needsReason: reasonMissing,
            needsConfirm: !confirm,
          },
          { status: 409 },
        );
      }
    }
  }

  const custCtx = await resolveCustomerBusinessContext(ref.profileId);
  const buyerOrganizationId = custCtx.organizationId;

  const baseData: {
    profileId: string;
    customerMatchStatus: "MANUAL_MATCHED";
    customerMatchReason: string;
    customerMatchScore: null;
    representativeId?: string;
    buyerOrganizationId: string | null;
  } = {
    profileId: ref.profileId,
    customerMatchStatus: "MANUAL_MATCHED",
    customerMatchReason: reason,
    customerMatchScore: null,
    buyerOrganizationId,
  };
  if (custCtx.representativeId) baseData.representativeId = custCtx.representativeId;

  const result = {
    bound: 0,
    skipped: 0,
    errors: [] as Array<{ orderId: string; error: string }>,
  };

  for (const orderId of orderIds) {
    try {
      const order = await prisma.order.findUnique({
        where: { id: orderId },
        select: { id: true, deleted: true, profileId: true },
      });
      if (!order || order.deleted) {
        result.skipped++;
        continue;
      }

      // BIND：仅未挂 Profile 的订单（可带遗留旧列脏数据）；REBIND：任意未删除订单
      const where =
        mode === "BIND"
          ? { id: orderId, deleted: false, profileId: null }
          : { id: orderId, deleted: false };
      const updated = await prisma.order.updateMany({ where, data: baseData });
      if (updated.count === 0) {
        result.skipped++;
        continue;
      }
      result.bound++;
    } catch (e) {
      result.errors.push({ orderId, error: e instanceof Error ? e.message : "绑定失败" });
    }
  }

  return NextResponse.json({ ...result, mode, profileId: ref.profileId });
}

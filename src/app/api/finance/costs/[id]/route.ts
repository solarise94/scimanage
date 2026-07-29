import { NextRequest, NextResponse } from "next/server";
import { requirePortalSession } from "@/lib/application/http-error-mapping";
import { prisma } from "@/lib/prisma";
import { isValidCostType, resolveAndValidateCostRefs } from "@/lib/finance/costs";
import { toPublicOrder } from "@/lib/crm/public-dto";
import { yuanToCents, centsToYuan } from "@/lib/finance/money";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gated = await requirePortalSession();
  if (!gated.ok) return gated.response;
  const session = gated.session;
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const existing = await prisma.financeCost.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

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

  if (amount !== undefined) {
    if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) {
      return NextResponse.json({ error: "金额必须为正数" }, { status: 400 });
    }
  }
  if (costType !== undefined && !isValidCostType(costType as string)) {
    return NextResponse.json({ error: `无效成本类型` }, { status: 400 });
  }

  // Validate entity refs if any are changing, and write back resolved values
  let resolvedProfileId: string | null = existing.profileId;
  let resolvedProjectId: string | null = existing.projectId;

  if (bodyProfileId !== undefined || orderId !== undefined || projectId !== undefined) {
    const validation = await resolveAndValidateCostRefs({
      profileId: bodyProfileId !== undefined
        ? ((bodyProfileId as string) || null)
        : existing.profileId,
      orderId: orderId !== undefined ? ((orderId as string) || null) : existing.orderId,
      projectId: projectId !== undefined ? ((projectId as string) || null) : existing.projectId,
    });
    if (!validation.valid) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }
    if (!validation.resolvedProfileId) {
      return NextResponse.json({ error: "必须关联有效的客户档案（profileId）" }, { status: 400 });
    }
    resolvedProfileId = validation.resolvedProfileId;
    resolvedProjectId = validation.resolvedProjectId;
  }

  const data: Record<string, unknown> = {};
  if (amount !== undefined) data.amount = yuanToCents(Number(amount));
  if (costType !== undefined) data.costType = costType;
  if (bodyProfileId !== undefined || orderId !== undefined || projectId !== undefined) {
    data.profileId = resolvedProfileId;
    data.projectId = resolvedProjectId ?? (projectId !== undefined ? ((projectId as string) || null) : existing.projectId);
  }
  if (orderId !== undefined) data.orderId = (orderId as string) || null;
  if (occurredAt !== undefined) data.occurredAt = new Date(occurredAt as string);
  if (remark !== undefined) data.remark = (remark as string)?.trim() || null;

  const updated = await prisma.financeCost.update({
    where: { id }, data,
    include: {
      profile: { select: { id: true, name: true } },
      order: { select: { id: true, orderNo: true } },
      project: { select: { id: true, name: true } },
    },
  });

  const { amount: amountCents, profile, ...rest } = toPublicOrder(updated);
  const profileDto = profile
    ? { id: profile.id, name: profile.name ?? null }
    : null;
  return NextResponse.json({
    cost: {
      ...rest,
      profile: profileDto,
      customer: profileDto,
      profileMissing: !updated.profileId || !profile,
      amount: centsToYuan(amountCents),
    },
  });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gated = await requirePortalSession();
  if (!gated.ok) return gated.response;
  const session = gated.session;
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  await prisma.financeCost.delete({ where: { id } });
  return NextResponse.json({ deleted: true });
}

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; capabilityId: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id, capabilityId } = await params;

  const existing = await prisma.supplierCapability.findUnique({ where: { id: capabilityId } });
  if (!existing || existing.supplierId !== id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = await req.json();
  const {
    serviceKey, itemName, spec, sampleType, species, platform, active, note,
  } = body as Record<string, unknown>;

  const data: Record<string, unknown> = {};
  if (serviceKey !== undefined) data.serviceKey = serviceKey;
  if (itemName !== undefined) data.itemName = itemName;
  if (spec !== undefined) data.spec = spec || null;
  if (sampleType !== undefined) data.sampleType = sampleType || null;
  if (species !== undefined) data.species = species || null;
  if (platform !== undefined) data.platform = platform || null;
  if (active !== undefined) data.active = Boolean(active);
  if (note !== undefined) data.note = note || null;

  // 计算变更后的目标 serviceKey / spec，用于 serviceKey 校验和组合去重
  const targetServiceKey = serviceKey !== undefined ? (serviceKey as string) : existing.serviceKey;
  const targetSpec = spec !== undefined ? (spec as string) || null : existing.spec;
  const keyChanged = targetServiceKey !== existing.serviceKey || targetSpec !== existing.spec;

  // 如果改 serviceKey，校验新 key 在 ServiceCatalog 中有效
  if (serviceKey !== undefined && serviceKey !== existing.serviceKey) {
    const sk = serviceKey as string;
    const catalog = await prisma.serviceCatalog.findUnique({ where: { serviceKey: sk } });
    if (!catalog || !catalog.active) {
      return NextResponse.json({ error: "无效或已停用的 serviceKey" }, { status: 400 });
    }
  }

  // 组合去重：serviceKey 或 spec 变化时，确认同供应商下没有其他记录占用同组合。
  // 不加这层校验可以通过 PATCH 制造重复能力记录。
  if (keyChanged) {
    const dupWhere: Record<string, unknown> = {
      supplierId: id,
      serviceKey: targetServiceKey,
      spec: targetSpec,
      id: { not: capabilityId },
    };
    const duplicate = await prisma.supplierCapability.findFirst({ where: dupWhere });
    if (duplicate) {
      return NextResponse.json({ error: "该服务项+规格组合已存在" }, { status: 409 });
    }
  }

  const updated = await prisma.supplierCapability.update({
    where: { id: capabilityId },
    data,
  });

  return NextResponse.json({ capability: updated });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; capabilityId: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id, capabilityId } = await params;

  const existing = await prisma.supplierCapability.findUnique({ where: { id: capabilityId } });
  if (!existing || existing.supplierId !== id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await prisma.supplierCapability.delete({ where: { id: capabilityId } });

  return NextResponse.json({ ok: true });
}

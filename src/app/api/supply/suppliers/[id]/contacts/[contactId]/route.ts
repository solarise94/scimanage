import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; contactId: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id, contactId } = await params;

  const existing = await prisma.supplierContact.findUnique({ where: { id: contactId } });
  if (!existing || existing.supplierId !== id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = await req.json();
  const {
    name, role, phone, email, wechat, qq, isPrimary, active, note,
  } = body as Record<string, unknown>;

  const wasPrimary = existing.isPrimary;
  const becomesPrimary = isPrimary !== undefined ? isPrimary === true : wasPrimary;
  const becomesNonPrimary = isPrimary !== undefined && isPrimary === false;

  const data: Record<string, unknown> = {};
  if (name !== undefined) data.name = name;
  if (role !== undefined) data.role = role || null;
  if (phone !== undefined) data.phone = phone || null;
  if (email !== undefined) data.email = email || null;
  if (wechat !== undefined) data.wechat = wechat || null;
  if (qq !== undefined) data.qq = qq || null;
  if (active !== undefined) data.active = Boolean(active);
  if (note !== undefined) data.note = note || null;

  const updated = await prisma.$transaction(async (tx) => {
    // isPrimary 改为 true：先取消其他主联系人，再同步 Supplier 缓存
    if (isPrimary !== undefined && becomesPrimary) {
      data.isPrimary = true;
      await tx.supplierContact.updateMany({
        where: { supplierId: id, isPrimary: true, id: { not: contactId } },
        data: { isPrimary: false },
      });
    } else if (becomesNonPrimary) {
      data.isPrimary = false;
    }

    const result = await tx.supplierContact.update({
      where: { id: contactId },
      data,
    });

    // 主联系人事实源同步（含 wechat）
    if (becomesPrimary) {
      await tx.supplier.update({
        where: { id },
        data: {
          contactName: result.name,
          phone: result.phone,
          email: result.email,
          wechat: result.wechat,
        },
      });
    } else if (becomesNonPrimary && wasPrimary) {
      // 旧主联系人被降级，清空 Supplier 缓存（含 wechat）
      await tx.supplier.update({
        where: { id },
        data: {
          contactName: null,
          phone: null,
          email: null,
          wechat: null,
        },
      });
    }

    return result;
  });

  return NextResponse.json({ contact: updated });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; contactId: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id, contactId } = await params;

  const existing = await prisma.supplierContact.findUnique({ where: { id: contactId } });
  if (!existing || existing.supplierId !== id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const wasPrimary = existing.isPrimary;

  await prisma.$transaction(async (tx) => {
    await tx.supplierContact.delete({ where: { id: contactId } });

    // 删除的是主联系人：尝试找一个活跃的替代者，否则清空 Supplier 缓存
    if (wasPrimary) {
      const nextPrimary = await tx.supplierContact.findFirst({
        where: { supplierId: id, active: true },
        orderBy: { createdAt: "asc" },
      });

      if (nextPrimary) {
        await tx.supplierContact.update({
          where: { id: nextPrimary.id },
          data: { isPrimary: true },
        });
        await tx.supplier.update({
          where: { id },
          data: {
            contactName: nextPrimary.name,
            phone: nextPrimary.phone,
            email: nextPrimary.email,
            wechat: nextPrimary.wechat,
          },
        });
      } else {
        await tx.supplier.update({
          where: { id },
          data: {
            contactName: null,
            phone: null,
            email: null,
            wechat: null,
          },
        });
      }
    }
  });

  return NextResponse.json({ ok: true });
}

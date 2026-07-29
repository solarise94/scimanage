import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isSupplyChainBlocked } from "@/lib/supply-chain/permissions";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (isSupplyChainBlocked(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const supplier = await prisma.supplier.findUnique({ where: { id }, select: { id: true } });
  if (!supplier) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const contacts = await prisma.supplierContact.findMany({
    where: { supplierId: id },
    orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
  });

  return NextResponse.json({ contacts });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const supplier = await prisma.supplier.findUnique({ where: { id }, select: { id: true } });
  if (!supplier) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = await req.json();
  const {
    name, role, phone, email, wechat, qq, isPrimary, active, note,
  } = body as Record<string, unknown>;

  if (!name || typeof name !== "string") {
    return NextResponse.json({ error: "name 必填" }, { status: 400 });
  }

  const shouldBePrimary = isPrimary === true;

  const contact = await prisma.$transaction(async (tx) => {
    // 如果新建为主联系人，先把同供应商其他联系人置为非主
    if (shouldBePrimary) {
      await tx.supplierContact.updateMany({
        where: { supplierId: id, isPrimary: true },
        data: { isPrimary: false },
      });
    }

    const created = await tx.supplierContact.create({
      data: {
        supplierId: id,
        name,
        role: (role as string) || null,
        phone: (phone as string) || null,
        email: (email as string) || null,
        wechat: (wechat as string) || null,
        qq: (qq as string) || null,
        isPrimary: shouldBePrimary,
        active: active !== undefined ? Boolean(active) : true,
        note: (note as string) || null,
      },
    });

    // 主联系人事实源同步：更新 Supplier 缓存字段（含 wechat）
    if (shouldBePrimary) {
      await tx.supplier.update({
        where: { id },
        data: {
          contactName: created.name,
          phone: created.phone,
          email: created.email,
          wechat: created.wechat,
        },
      });
    }

    return created;
  });

  return NextResponse.json({ contact }, { status: 201 });
}

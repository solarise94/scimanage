import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { canManageTemplates, canViewTemplates } from "@/lib/contracts/permissions";

// GET: 模板详情
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!canViewTemplates(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const template = await prisma.contractTemplate.findUnique({
    where: { id },
    include: { createdBy: { select: { id: true, name: true } }, updatedBy: { select: { id: true, name: true } } },
  });
  if (!template) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // 校验权限（能查看）
  return NextResponse.json({ template });
}

// PATCH: 更新模板（名称/描述/默认标记/归档）
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!canManageTemplates(session.user.role)) {
    return NextResponse.json({ error: "Forbidden: 仅管理员可管理模板" }, { status: 403 });
  }

  const { id } = await params;
  const existing = await prisma.contractTemplate.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = await req.json();
  const { name, category, description, isDefault, archived } = body as {
    name?: string;
    category?: string;
    description?: string;
    isDefault?: boolean;
    archived?: boolean;
  };

  if (isDefault) {
    const targetCategory = category ?? existing.category;
    await prisma.contractTemplate.updateMany({
      where: { category: targetCategory, isDefault: true, id: { not: id } },
      data: { isDefault: false },
    });
  }

  const data: Record<string, unknown> = {
    updatedById: session.user.id,
  };
  if (name !== undefined) data.name = name.trim();
  if (category !== undefined) data.category = category;
  if (description !== undefined) data.description = description?.trim() || null;
  if (isDefault !== undefined) data.isDefault = isDefault;
  if (archived !== undefined) data.archived = archived;

  const template = await prisma.contractTemplate.update({ where: { id }, data });
  return NextResponse.json({ template });
}

// DELETE: 删除模板（软删除=归档）
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!canManageTemplates(session.user.role)) {
    return NextResponse.json({ error: "Forbidden: 仅管理员可管理模板" }, { status: 403 });
  }

  const { id } = await params;
  const existing = await prisma.contractTemplate.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await prisma.contractTemplate.update({
    where: { id },
    data: { archived: true, updatedById: session.user.id },
  });
  return NextResponse.json({ ok: true });
}

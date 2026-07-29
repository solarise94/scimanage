import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// 外部部门通讯录：编辑 / 软删除（仅 ADMIN）

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const existing = await prisma.externalContact.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = await req.json();
  const { name, email, department, description, ccEmails, enabled, archived } =
    body as Record<string, unknown>;

  const data: Record<string, unknown> = {};
  if (name !== undefined) {
    if (!(name as string)?.trim()) {
      return NextResponse.json({ error: "名称不能为空" }, { status: 400 });
    }
    data.name = (name as string).trim();
  }
  if (email !== undefined) {
    const trimmed = (email as string)?.trim();
    if (!trimmed || !trimmed.includes("@")) {
      return NextResponse.json({ error: "收件邮箱无效" }, { status: 400 });
    }
    data.email = trimmed;
  }
  if (department !== undefined) data.department = (department as string)?.trim() || null;
  if (description !== undefined) data.description = (description as string)?.trim() || null;
  if (ccEmails !== undefined) data.ccEmails = (ccEmails as string)?.trim() || null;
  if (enabled !== undefined) data.enabled = !!enabled;
  if (archived !== undefined) data.archived = !!archived;

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "无更新内容" }, { status: 400 });
  }

  const contact = await prisma.externalContact.update({ where: { id }, data });
  return NextResponse.json({ contact });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const existing = await prisma.externalContact.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // 软删除（archived=true），保留历史绑定关系
  const contact = await prisma.externalContact.update({
    where: { id },
    data: { archived: true },
  });
  return NextResponse.json({ contact });
}

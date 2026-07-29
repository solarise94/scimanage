import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = await prisma.user.findUnique({ where: { id: session.user.id }, select: { role: true } });
  if (!user || user.role !== "ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { searchParams } = new URL(req.url);
  const status = searchParams.get("status") || undefined;
  const type = searchParams.get("type") || undefined;
  const search = searchParams.get("search") || undefined;

  const where: Record<string, unknown> = {};
  if (status) where.status = status;
  if (type) where.type = type;
  if (search) {
    where.OR = [
      { title: { contains: search } },
      { content: { contains: search } },
      { version: { contains: search } },
    ];
  }

  const logs = await prisma.devLog.findMany({
    where,
    include: { createdBy: { select: { id: true, name: true } } },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({ logs });
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = await prisma.user.findUnique({ where: { id: session.user.id }, select: { role: true } });
  if (!user || user.role !== "ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await req.json();
  const { title, content, version, type } = body;

  if (!title?.trim() || !content?.trim()) {
    return NextResponse.json({ error: "标题和内容为必填项" }, { status: 400 });
  }

  const validTypes = ["UPDATE", "FIX", "RELEASE", "NOTICE"];
  const logType = validTypes.includes(type) ? type : "UPDATE";

  const log = await prisma.devLog.create({
    data: {
      title: title.trim(),
      content: content.trim(),
      version: version?.trim() || null,
      type: logType,
      createdById: session.user.id,
    },
    include: { createdBy: { select: { id: true, name: true } } },
  });

  return NextResponse.json({ log }, { status: 201 });
}

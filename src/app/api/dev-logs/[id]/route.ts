import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = await prisma.user.findUnique({ where: { id: session.user.id }, select: { role: true } });
  if (!user || user.role !== "ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;
  const log = await prisma.devLog.findUnique({ where: { id } });
  if (!log) return NextResponse.json({ error: "日志不存在" }, { status: 404 });

  const body = await req.json();
  const { title, content, version, type, status } = body;

  const data: Record<string, unknown> = {};

  if (title !== undefined) {
    if (typeof title !== "string" || !title.trim()) return NextResponse.json({ error: "标题不能为空" }, { status: 400 });
    data.title = title.trim();
  }
  if (content !== undefined) {
    if (typeof content !== "string" || !content.trim()) return NextResponse.json({ error: "内容不能为空" }, { status: 400 });
    data.content = content.trim();
  }
  if (version !== undefined) data.version = (typeof version === "string" ? version.trim() : "") || null;
  if (type !== undefined) {
    const validTypes = ["UPDATE", "FIX", "RELEASE", "NOTICE"];
    if (validTypes.includes(type)) data.type = type;
  }

  // Status transitions
  if (status) {
    if (status === "PUBLISHED" && log.status === "DRAFT") {
      data.status = "PUBLISHED";
      data.publishedAt = new Date();
    } else if (status === "ARCHIVED" && log.status === "PUBLISHED") {
      data.status = "ARCHIVED";
    } else if (status !== log.status) {
      return NextResponse.json({ error: `不允许从 ${log.status} 切换到 ${status}` }, { status: 400 });
    }
  }

  const updated = await prisma.devLog.update({
    where: { id },
    data,
    include: { createdBy: { select: { id: true, name: true } } },
  });

  return NextResponse.json({ log: updated });
}

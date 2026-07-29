import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const body = await req.json();
  const { name, province, city, district, description, archived } = body;

  const existing = await prisma.representativeRegion.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json({ error: "地区不存在" }, { status: 404 });
  }

  const data: Record<string, unknown> = {};
  if (name !== undefined) {
    const trimmed = (name as string)?.trim();
    if (!trimmed) return NextResponse.json({ error: "地区名称不能为空" }, { status: 400 });
    data.name = trimmed;
  }
  if (province !== undefined) data.province = (province as string)?.trim() || null;
  if (city !== undefined) data.city = (city as string)?.trim() || null;
  if (district !== undefined) data.district = (district as string)?.trim() || null;
  if (description !== undefined) data.description = (description as string)?.trim() || null;
  if (archived !== undefined) data.archived = archived;

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  }

  try {
    const region = await prisma.representativeRegion.update({
      where: { id },
      data,
    });
    return NextResponse.json({ region });
  } catch (e: unknown) {
    if (typeof e === "object" && e !== null && "code" in e && (e as { code: string }).code === "P2002") {
      return NextResponse.json({ error: "地区名称已存在" }, { status: 409 });
    }
    throw e;
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;

  const existing = await prisma.representativeRegion.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json({ error: "地区不存在" }, { status: 404 });
  }

  // Soft delete: archive instead of hard delete
  await prisma.representativeRegion.update({
    where: { id },
    data: { archived: true },
  });

  return NextResponse.json({ success: true });
}

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const body = await req.json();
  const { name, description, isDefault, archived } = body;

  const existing = await prisma.sourceBrand.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ error: "品牌不存在" }, { status: 404 });

  if (name !== undefined && (typeof name !== "string" || !name.trim())) {
    return NextResponse.json({ error: "品牌名称不能为空" }, { status: 400 });
  }

  try {
    const brand = await prisma.$transaction(async (tx) => {
      if (isDefault === true) {
        await tx.sourceBrand.updateMany({
          where: { isDefault: true, id: { not: id } },
          data: { isDefault: false },
        });
      }

      const data: Record<string, unknown> = {};
      if (name !== undefined) data.name = name.trim();
      if (description !== undefined) data.description = description || null;
      if (archived !== undefined) data.archived = archived;
      if (isDefault !== undefined) data.isDefault = isDefault;

      return tx.sourceBrand.update({
        where: { id },
        data,
      });
    });

    return NextResponse.json({ brand });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return NextResponse.json({ error: "品牌名称已存在" }, { status: 409 });
    }
    console.error("Failed to update source brand:", error);
    return NextResponse.json({ error: "更新品牌失败" }, { status: 500 });
  }
}

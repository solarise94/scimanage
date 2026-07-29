import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const includeArchived = searchParams.get("includeArchived") === "true";
  const isAdmin = session.user.role === "ADMIN";

  const where: Record<string, unknown> = {};
  if (!includeArchived || !isAdmin) {
    where.archived = false;
  }

  const channels = await prisma.procurementChannel.findMany({
    where,
    orderBy: [{ isDefault: "desc" }, { name: "asc" }],
  });

  return NextResponse.json({ channels });
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json();
  const { name, description, isDefault } = body;

  if (!name || typeof name !== "string" || !name.trim()) {
    return NextResponse.json({ error: "渠道名称不能为空" }, { status: 400 });
  }

  try {
    const channel = await prisma.$transaction(async (tx) => {
      if (isDefault) {
        await tx.procurementChannel.updateMany({
          where: { isDefault: true },
          data: { isDefault: false },
        });
      }
      return tx.procurementChannel.create({
        data: {
          name: name.trim(),
          description: description || null,
          isDefault: !!isDefault,
        },
      });
    });

    return NextResponse.json({ channel }, { status: 201 });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return NextResponse.json({ error: "渠道名称已存在" }, { status: 409 });
    }
    console.error("Failed to create procurement channel:", error);
    return NextResponse.json({ error: "创建渠道失败" }, { status: 500 });
  }
}

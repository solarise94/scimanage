import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = req.nextUrl;
  const includeArchived = searchParams.get("archived") === "true";

  const where: Record<string, unknown> = {};
  if (!includeArchived) where.archived = false;

  const regions = await prisma.representativeRegion.findMany({
    where,
    include: {
      _count: { select: { reps: true } },
    },
    orderBy: { name: "asc" },
  });

  return NextResponse.json({ regions });
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json();
  const { name, province, city, district, description } = body;

  if (!name?.trim()) {
    return NextResponse.json({ error: "地区名称为必填项" }, { status: 400 });
  }

  try {
    const region = await prisma.representativeRegion.create({
      data: {
        name: name.trim(),
        province: province?.trim() || null,
        city: city?.trim() || null,
        district: district?.trim() || null,
        description: description?.trim() || null,
      },
    });
    return NextResponse.json({ region }, { status: 201 });
  } catch (e: unknown) {
    if (typeof e === "object" && e !== null && "code" in e && (e as { code: string }).code === "P2002") {
      return NextResponse.json({ error: "地区名称已存在" }, { status: 409 });
    }
    throw e;
  }
}

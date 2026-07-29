import { NextRequest, NextResponse } from "next/server";
import { requireCurrentAdmin } from "@/lib/user-management/permissions";
import { invalidateUserRole } from "@/lib/user-management/role-cache";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const adminCheck = await requireCurrentAdmin();
  if (!adminCheck.ok) {
    return NextResponse.json({ error: adminCheck.error }, { status: adminCheck.status });
  }

  const managers = await prisma.crmRegionManager.findMany({
    include: {
      user: { select: { id: true, name: true, email: true } },
      region: { select: { id: true, name: true } },
      reps: { include: { representative: { select: { id: true, name: true, email: true } } } },
    },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({ managers });
}

export async function POST(req: NextRequest) {
  const adminCheck = await requireCurrentAdmin();
  if (!adminCheck.ok) {
    return NextResponse.json({ error: adminCheck.error }, { status: adminCheck.status });
  }

  const body = await req.json();
  const { userId, regionId, repIds } = body;

  if (!userId) return NextResponse.json({ error: "userId is required" }, { status: 400 });

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

  // Validate regionId if provided
  if (regionId) {
    const region = await prisma.representativeRegion.findFirst({
      where: { id: regionId, archived: false },
    });
    if (!region) return NextResponse.json({ error: "指定地区不存在或已归档" }, { status: 400 });
  }

  const existing = await prisma.crmRegionManager.findUnique({ where: { userId } });
  if (existing) return NextResponse.json({ error: "该用户已是地区经理" }, { status: 409 });

  const manager = await prisma.$transaction(async (tx) => {
    // Set the user's role to REGIONAL_MANAGER if not already
    if (user.role !== "ADMIN") {
      await tx.user.update({ where: { id: userId }, data: { role: "REGIONAL_MANAGER" } });
    }

    const created = await tx.crmRegionManager.create({
      data: {
        userId,
        regionId: regionId || null,
        reps: repIds?.length
          ? { create: repIds.map((repId: string) => ({ representativeId: repId })) }
          : undefined,
      },
      include: {
        user: { select: { id: true, name: true, email: true } },
        region: { select: { id: true, name: true } },
        reps: { include: { representative: { select: { id: true, name: true, email: true } } } },
      },
    });

    return created;
  });

  // Unconditional cache invalidation after transaction success.
  // The role may have changed to REGIONAL_MANAGER, or may have been left as-is
  // (if user was already ADMIN). Either way, invalidate to be safe.
  invalidateUserRole(userId);

  return NextResponse.json({ manager }, { status: 201 });
}

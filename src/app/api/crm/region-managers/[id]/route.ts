import { NextRequest, NextResponse } from "next/server";
import { requireCurrentAdmin } from "@/lib/user-management/permissions";
import { invalidateUserRole } from "@/lib/user-management/role-cache";
import { prisma } from "@/lib/prisma";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const adminCheck = await requireCurrentAdmin();
  if (!adminCheck.ok) {
    return NextResponse.json({ error: adminCheck.error }, { status: adminCheck.status });
  }

  const { id } = await params;
  const manager = await prisma.crmRegionManager.findUnique({ where: { id } });
  if (!manager) return NextResponse.json({ error: "Region manager not found" }, { status: 404 });

  const body = await req.json();
  const data: Record<string, unknown> = {};

  if (body.regionId !== undefined) {
    if (body.regionId === null || body.regionId === "") {
      data.regionId = null;
    } else {
      const region = await prisma.representativeRegion.findFirst({
        where: { id: body.regionId, archived: false },
      });
      if (!region) return NextResponse.json({ error: "指定地区不存在或已归档" }, { status: 400 });
      data.regionId = body.regionId;
    }
  }
  if (body.archived !== undefined) data.archived = body.archived;

  const updated = await prisma.$transaction(async (tx) => {
    // Sync rep assignments if repIds is provided
    if (Array.isArray(body.repIds)) {
      await tx.crmRegionManagerRepresentative.deleteMany({ where: { managerId: id } });
      if (body.repIds.length > 0) {
        await tx.crmRegionManagerRepresentative.createMany({
          data: body.repIds.map((repId: string) => ({ managerId: id, representativeId: repId })),
        });
      }
    }

    // Restore/set user role when archiving/unarchiving
    if (body.archived === true) {
      const managerUser = await tx.user.findUnique({ where: { id: manager.userId } });
      if (managerUser && managerUser.role === "REGIONAL_MANAGER") {
        // If the same email has an active Representative, restore to REPRESENTATIVE instead of USER
        const activeRep = await tx.representative.findFirst({
          where: { email: managerUser.email, archived: false },
        });
        await tx.user.update({
          where: { id: manager.userId },
          data: { role: activeRep ? "REPRESENTATIVE" : "USER" },
        });
      }
    } else if (body.archived === false) {
      await tx.user.update({ where: { id: manager.userId }, data: { role: "REGIONAL_MANAGER" } });
    }

    const result = await tx.crmRegionManager.update({
      where: { id },
      data,
      include: {
        user: { select: { id: true, name: true, email: true } },
        region: { select: { id: true, name: true } },
        reps: { include: { representative: { select: { id: true, name: true, email: true } } } },
      },
    });

    return result;
  });

  // Unconditional cache invalidation after transaction success.
  // Archiving may have rolled the role back to REPRESENTATIVE or USER;
  // restoring sets it to REGIONAL_MANAGER. In all cases the cache must be
  // invalidated so the next request sees the current role.
  invalidateUserRole(manager.userId);

  return NextResponse.json({ manager: updated });
}

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// POST /api/admin/data-governance/batch-restore-profiles
// Body: { profileIds?: string[] }
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const explicitIds: string[] | undefined = Array.isArray(body?.profileIds) ? body.profileIds : undefined;

  const where = explicitIds
    ? { id: { in: explicitIds }, archived: true }
    : { archived: true };

  // Phase E contract：Customer 锚点已删除，Profile 生命周期为唯一事实源
  const profiles = await prisma.crmCustomerProfile.findMany({
    where,
    select: {
      id: true,
      deleted: true,
      mergedIntoProfileId: true,
      _count: { select: { interactions: true, followUpTasks: true, visitCheckins: true } },
    },
  });

  let restored = 0;
  let skipped = 0;
  const errors: Array<{ profileId: string; error: string }> = [];
  const warnings: string[] = [];

  for (const profile of profiles) {
    // 仅恢复未删除、未合并的档案
    if (profile.deleted || profile.mergedIntoProfileId !== null) {
      skipped++;
      continue;
    }

    if (
      profile._count.interactions === 0 &&
      profile._count.followUpTasks === 0 &&
      profile._count.visitCheckins === 0
    ) {
      warnings.push(`profile ${profile.id} 无子记录，可能曾被重建`);
    }

    try {
      await prisma.crmCustomerProfile.update({
        where: { id: profile.id },
        data: { archived: false },
      });
      restored++;
    } catch (e) {
      const message = e instanceof Error ? e.message : "恢复失败";
      errors.push({ profileId: profile.id, error: message });
    }
  }

  return NextResponse.json({ restored, skipped, errors, warnings });
}

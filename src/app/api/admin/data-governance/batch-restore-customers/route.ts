import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// POST /api/admin/data-governance/batch-restore-customers
// Body: { profileIds?: string[] }
//
// Phase E1: 归档真相源为 CrmCustomerProfile.archived。本接口只恢复 Profile 归档状态。
// W7.3 Profile-only：只收 profileIds（旧 *CustomerId 参数 400），筛选只按 Profile 自身生命周期字段。
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = (await req.json().catch(() => ({}))) ?? {};

  // 旧 *CustomerId 系参数一律 400（键名枚举，避免在源码里引用已废弃契约）。
  const legacyKey = Object.keys(body).find((k) => /customerids?$/i.test(k));
  if (legacyKey) {
    return NextResponse.json(
      { error: `请使用 profileIds 指定客户（不再接受 ${legacyKey}）` },
      { status: 400 },
    );
  }

  const explicitIds: string[] | undefined = Array.isArray(body?.profileIds) ? body.profileIds : undefined;

  const profileWhere = explicitIds
    ? { id: { in: explicitIds }, archived: true }
    : { archived: true, deleted: false };

  const profiles = await prisma.crmCustomerProfile.findMany({
    where: profileWhere,
    select: { id: true },
  });

  const profileResult = await prisma.crmCustomerProfile.updateMany({
    where: { id: { in: profiles.map((p) => p.id) } },
    data: { archived: false },
  });

  return NextResponse.json({ restored: profileResult.count, profilesRestored: profileResult.count });
}

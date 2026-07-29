import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getEffectiveCrmVisibleProfileIds } from "@/lib/crm/permissions";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const visibleProfileIdSet = await getEffectiveCrmVisibleProfileIds(
    session.user.id,
    session.user.role,
  );

  const rows = await prisma.crmCustomerProfile.findMany({
    where: {
      archived: false,
      organizationId: { not: null },
      ...(visibleProfileIdSet ? { id: { in: [...visibleProfileIdSet] } } : {}),
    },
    select: {
      organizationId: true,
      organization: true,
    },
    distinct: ["organizationId"],
  });

  const options = rows
    .filter((row): row is { organizationId: string; organization: string } => {
      if (!row.organizationId) return false;
      if (!row.organization || !row.organization.trim()) return false;
      return true;
    })
    .map((row) => ({
      organizationId: row.organizationId,
      organization: row.organization.trim(),
    }))
    .sort((a, b) => a.organization.localeCompare(b.organization, "zh-CN"));

  return NextResponse.json({ options });
}

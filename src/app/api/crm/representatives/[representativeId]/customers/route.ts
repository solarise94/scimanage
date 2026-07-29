import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isRegionalManagerRole } from "@/lib/crm/permissions";
import { profileInclude } from "@/lib/crm/includes";
import { buildCrmProfileCustomerView } from "@/lib/customers/customer-business-fields";
import { buildRepresentativePerformanceScope } from "@/lib/crm/representative-performance";
import { toPublicProfile } from "@/lib/crm/public-dto";

function parsePage(raw: string | null, fallback = 1) {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

function parsePageSize(raw: string | null, fallback: number, max = 100) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), max);
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ representativeId: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role === "REPRESENTATIVE") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { representativeId } = await params;
  const rep = await prisma.representative.findUnique({
    where: { id: representativeId },
    select: { id: true, kind: true },
  });
  if (!rep || rep.kind === "SYSTEM") {
    return NextResponse.json({ error: "Representative not found" }, { status: 404 });
  }

  if (isRegionalManagerRole(session.user.role)) {
    const manager = await prisma.crmRegionManager.findUnique({
      where: { userId: session.user.id, archived: false },
      include: { reps: { where: { representativeId }, select: { id: true } } },
    });
    if (!manager || manager.reps.length === 0) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  const { searchParams } = req.nextUrl;
  const page = parsePage(searchParams.get("page"));
  const pageSize = parsePageSize(searchParams.get("pageSize"), 50);
  const skip = (page - 1) * pageSize;

  const scope = await buildRepresentativePerformanceScope(representativeId);
  const profileIds = scope.profileIds;
  const total = profileIds.length;

  const rows =
    total > 0
      ? await prisma.crmCustomerProfile.findMany({
          where: { id: { in: profileIds } },
          include: profileInclude,
          orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
          skip,
          take: pageSize,
        })
      : [];

  const customers = rows.map((p) => ({
    ...toPublicProfile(p),
    customerView: buildCrmProfileCustomerView(p),
  }));

  return NextResponse.json({
    customers,
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    truncated: total > skip + customers.length,
  });
}

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isRegionalManagerRole } from "@/lib/crm/permissions";
import { buildRepresentativePerformanceScope } from "@/lib/crm/representative-performance";

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
    select: { id: true, email: true, kind: true },
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

  const linkedUser = await prisma.user.findFirst({
    where: { email: rep.email, role: { in: ["REPRESENTATIVE", "REGIONAL_MANAGER"] } },
    select: { id: true },
  });

  const { searchParams } = req.nextUrl;
  const page = parsePage(searchParams.get("page"));
  const pageSize = parsePageSize(searchParams.get("pageSize"), 20);
  const skip = (page - 1) * pageSize;

  const scope = await buildRepresentativePerformanceScope(representativeId);
  const profileIds = scope.profileIds;

  if (!linkedUser || profileIds.length === 0) {
    return NextResponse.json({
      openFollowUps: [],
      page,
      pageSize,
      total: 0,
      totalPages: 1,
      truncated: false,
    });
  }

  const where = {
    ownerUserId: linkedUser.id,
    status: "OPEN" as const,
    profileId: { in: profileIds },
  };

  const [total, rows] = await Promise.all([
    prisma.crmFollowUpTask.count({ where }),
    prisma.crmFollowUpTask.findMany({
      where,
      include: {
        ownerUser: { select: { id: true, name: true } },
        createdByUser: { select: { id: true, name: true } },
        profile: { select: { id: true, name: true, customerCode: true } },
      },
      orderBy: [{ dueAt: "asc" }, { id: "asc" }],
      skip,
      take: pageSize,
    }),
  ]);

  const openFollowUps = rows.map((task) => ({
    ...task,
    profile: task.profile
      ? { id: task.profile.id, name: task.profile.name, customerCode: task.profile.customerCode }
      : task.profile,
  }));

  return NextResponse.json({
    openFollowUps,
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    truncated: total > skip + openFollowUps.length,
  });
}

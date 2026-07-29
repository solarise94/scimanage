import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { findActiveProfile } from "@/lib/crm/ids";
import { buildRepresentativePerformanceScope } from "@/lib/crm/representative-performance";
import { canReadRepresentativeReport } from "@/lib/crm/representative-report-access";

/** Compute week boundaries: Monday 00:00:00 to next Monday 00:00:00 */
function getWeekWindow() {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const day = now.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  const start = new Date(now);
  start.setDate(start.getDate() + diff);
  const end = new Date(start);
  end.setDate(end.getDate() + 7);
  return { start, end };
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ representativeId: string }> }
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { representativeId } = await params;
  const rep = await prisma.representative.findUnique({ where: { id: representativeId } });
  if (!rep) return NextResponse.json({ error: "Representative not found" }, { status: 404 });

  const readable = await canReadRepresentativeReport(
    session.user.id,
    session.user.role,
    representativeId,
  );
  if (!readable) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { searchParams } = new URL(req.url);
  const profileId = searchParams.get("profileId");
  // 旧 *CustomerId 系筛选参数一律 400（键名枚举，避免在源码里引用已废弃契约）。
  const legacyParam = [...searchParams.keys()].find((k) => /customerids?$/i.test(k));
  if (legacyParam) {
    return NextResponse.json(
      { error: `请使用 profileId 查询互动记录（不再接受 ${legacyParam}）` },
      { status: 400 },
    );
  }
  if (!profileId) {
    return NextResponse.json({ error: "profileId is required" }, { status: 400 });
  }

  const linkedUser = await prisma.user.findFirst({
    where: { email: rep.email },
    select: { id: true },
  });

  if (!linkedUser) {
    return NextResponse.json({ interactions: [] });
  }

  const ref = await findActiveProfile(profileId, prisma);
  if (!ref) {
    return NextResponse.json({ error: "Customer profile not found" }, { status: 404 });
  }

  // Ownership：必须落在本代表绩效 scope（含 Profile-only）
  const scope = await buildRepresentativePerformanceScope(representativeId);
  if (!scope.profileIds.includes(ref.profileId)) {
    return NextResponse.json(
      { error: "Forbidden: customer does not belong to this representative" },
      { status: 403 },
    );
  }

  const { start: periodStart, end: periodEnd } = getWeekWindow();

  const interactions = await prisma.crmInteraction.findMany({
    where: {
      profileId: ref.profileId,
      happenedAt: { gte: periodStart, lt: periodEnd },
    },
    orderBy: { happenedAt: "desc" },
    take: 5,
    select: {
      summaryTitle: true,
      summary: true,
      summaryNote: true,
      happenedAt: true,
    },
  });

  return NextResponse.json({
    interactions: interactions.map((ix) => ({
      summaryTitle: ix.summaryTitle,
      summary: ix.summary,
      summaryNote: ix.summaryNote,
      happenedAt: ix.happenedAt.toISOString(),
    })),
  });
}

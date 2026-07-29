import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { deriveGraduationStatus } from "@/lib/crm/profile-filters";
import { buildRepresentativePerformanceScope } from "@/lib/crm/representative-performance";
import { getCustomerOrganizationName } from "@/lib/customer-organization";
import { compactIds, findActiveProfile } from "@/lib/crm/ids";
import { profileInclude } from "@/lib/crm/includes";
import { buildCrmProfileCustomerView } from "@/lib/customers/customer-business-fields";
import {
  canAccessOwnRepresentativeReport,
  canReadRepresentativeReport,
} from "@/lib/crm/representative-report-access";
import { getBusinessRecognitionEvents, sumRecognitionEvents } from "@/lib/finance/business-recognition";
import { getRepresentativeCommunicationEvents } from "@/lib/crm/representative-communication-events";
import { getBusinessWeekWindow } from "@/lib/business-time";
import { getLastActorCheckinHappenedAtByProfileIds } from "@/lib/crm/checkin-event-time";

/** Shared permission checker for read access */
async function assertReportReadable(session: { user: { id: string; role: string } }, representativeId: string) {
  const rep = await prisma.representative.findUnique({ where: { id: representativeId } });
  if (!rep) return { ok: false, status: 404, error: "Representative not found" } as const;
  // U5：本部系统代表（kind=SYSTEM）不参与代表运营报表。
  if (rep.kind === "SYSTEM") {
    return { ok: false, status: 404, error: "系统代表不参与运营报表" } as const;
  }

  const readable = await canReadRepresentativeReport(
    session.user.id,
    session.user.role,
    representativeId,
  );
  if (!readable) {
    return { ok: false, status: 403, error: "Forbidden" } as const;
  }
  return { ok: true, rep } as const;
}

/** Get linked userId for a representative */
async function getLinkedUserId(repEmail: string) {
  const user = await prisma.user.findFirst({
    where: { email: repEmail, role: { in: ["REPRESENTATIVE", "REGIONAL_MANAGER"] } },
    select: { id: true },
  });
  return user?.id ?? null;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ representativeId: string }> }
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { representativeId } = await params;
  const perm = await assertReportReadable(session, representativeId);
  if (!perm.ok) return NextResponse.json({ error: perm.error }, { status: perm.status });
  const rep = perm.rep;

  const week = getBusinessWeekWindow();
  const periodStart = week.start;
  const periodEnd = week.end;
  const periodKey = week.periodKey;

  const userId = await getLinkedUserId(rep.email);

  const accountUnlinked = !userId;

  // Resolve effective performance scope（含 Profile-only）
  const scope = await buildRepresentativePerformanceScope(representativeId);
  const effectiveProfileIds = scope.profileIds;

  const orderSubjectWhere = effectiveProfileIds.length > 0
    ? { profileId: { in: effectiveProfileIds } }
    : null;

  // Summary stats —— 沟通事件与 PATCH 使用同一 effectiveProfileIds scope；空 scope fail-closed
  const [communicationEvents, reservedOrders, recognitionEvents, complaintStats] = await Promise.all([
    userId && effectiveProfileIds.length > 0
      ? getRepresentativeCommunicationEvents({
          actorUserIds: [userId],
          profileIds: effectiveProfileIds,
          from: periodStart,
          to: periodEnd,
        })
      : Promise.resolve([]),
    orderSubjectWhere
      ? prisma.order.findMany({
          where: {
            ...orderSubjectWhere,
            AND: [
              {
                OR: [
                  { orderedAt: { gte: periodStart, lt: periodEnd } },
                  { orderedAt: null, confirmedAt: { gte: periodStart, lt: periodEnd } },
                  { orderedAt: null, confirmedAt: null, createdAt: { gte: periodStart, lt: periodEnd } },
                ],
              },
            ],
            deleted: false,
            archived: false,
            status: { in: ["CONFIRMED", "DELIVERED", "CLOSED"] },
          },
          select: { profileId: true, totalAmount: true, financeAmountOverride: true },
        })
      : Promise.resolve([]),
    effectiveProfileIds.length > 0
      ? getBusinessRecognitionEvents({
          profileIds: effectiveProfileIds,
          periodStart,
          periodEnd,
        })
      : Promise.resolve([]),
    // Phase 4：客诉处理指标（该代表可见 profile 范围内）
    effectiveProfileIds.length > 0
      ? (async () => {
          const repProfileIds = effectiveProfileIds;
          if (repProfileIds.length === 0) return { total: 0, open: 0, highSeverity: 0 };
          const [total, open, highSeverity] = await Promise.all([
            prisma.crmComplaint.count({ where: { profileId: { in: repProfileIds } } }),
            prisma.crmComplaint.count({
              where: {
                profileId: { in: repProfileIds },
                status: { in: ["OPEN", "IN_PROGRESS", "WAITING_CUSTOMER", "RESOLVED"] },
              },
            }),
            prisma.crmComplaint.count({
              where: {
                profileId: { in: repProfileIds },
                status: { in: ["OPEN", "IN_PROGRESS", "WAITING_CUSTOMER", "RESOLVED"] },
                severity: { in: ["HIGH", "CRITICAL"] },
              },
            }),
          ]);
          return { total, open, highSeverity };
        })()
      : Promise.resolve({ total: 0, open: 0, highSeverity: 0 }),
  ]);
  const visitEvents = communicationEvents.filter((event) => event.sourceType === "CHECKIN");
  const visitCheckinCount = visitEvents.length;
  const communicationEventCount = communicationEvents.length;
  const communicatedProfileIds = compactIds(communicationEvents.map((event) => event.profileId));

  // New customers this week: based on effective anchorAt（含 Profile-only）
  const newProfileIdsThisWeek: string[] = [];
  for (const profileId of effectiveProfileIds) {
    const effective = scope.effectiveByProfileId.get(profileId);
    const anchorAt = effective?.anchorAt;
    if (!anchorAt || anchorAt < periodStart || anchorAt >= periodEnd) continue;
    newProfileIdsThisWeek.push(profileId);
  }
  const newCustomerCount = newProfileIdsThisWeek.length;

  const reservedOrderCount = reservedOrders.length;
  const { newBusinessCents, deliveryBusinessCents, confirmedBusinessCents } = sumRecognitionEvents(recognitionEvents);

  // 活动客户列表主键：profileId（含 Profile-only）
  const orderProfileIds = compactIds(
    reservedOrders.map((order) => order.profileId),
  );
  const visitedProfileIds = compactIds(visitEvents.map((event) => event.profileId));

  const allProfileIds = [...new Set([
    ...communicatedProfileIds,
    ...visitedProfileIds,
    ...newProfileIdsThisWeek,
    ...orderProfileIds,
  ])];

  // Fetch CRM profiles with full data（直接按 profileId，含 Profile-only）
  const profiles = allProfileIds.length > 0
    ? await prisma.crmCustomerProfile.findMany({
        where: { id: { in: allProfileIds } },
        include: profileInclude,
      })
    : [];
  const profileById = new Map(profiles.map((p) => [p.id, p]));

  // Weekly visit counts per profile
  const visitCountByProfile = new Map<string, number>();
  for (const event of visitEvents) {
    visitCountByProfile.set(
      event.profileId,
      (visitCountByProfile.get(event.profileId) || 0) + 1,
    );
  }

  // Latest visit / interaction / follow-up per profile
  const lastVisitByProfile = new Map<string, string | null>();
  const interactionByProfile = new Map<string, {
    summaryTitle: string | null;
    summary: string | null;
    summaryNote: string | null;
    happenedAt: Date;
  } | null>();
  const nextFollowUpByProfile = new Map<string, string | null>();

  // 批量取最近签到 / 互动 / 跟进，避免 per-profile N+1
  if (allProfileIds.length > 0) {
    const lastActorVisitMap = userId
      ? await getLastActorCheckinHappenedAtByProfileIds({
          userId,
          profileIds: allProfileIds,
        })
      : new Map<string, Date>();
    for (const [pid, at] of lastActorVisitMap) {
      lastVisitByProfile.set(pid, at.toISOString());
    }

    const [latestInteractions, openTasks] = await Promise.all([
      prisma.crmInteraction.findMany({
        where: { profileId: { in: allProfileIds } },
        select: {
          profileId: true,
          summaryTitle: true,
          summary: true,
          summaryNote: true,
          happenedAt: true,
        },
        orderBy: { happenedAt: "desc" },
      }),
      prisma.crmFollowUpTask.findMany({
        where: { profileId: { in: allProfileIds }, status: "OPEN" },
        select: { profileId: true, dueAt: true },
        orderBy: { dueAt: "asc" },
      }),
    ]);

    for (const ix of latestInteractions) {
      if (interactionByProfile.has(ix.profileId)) continue;
      interactionByProfile.set(ix.profileId, {
        summaryTitle: ix.summaryTitle,
        summary: ix.summary,
        summaryNote: ix.summaryNote,
        happenedAt: ix.happenedAt,
      });
    }
    for (const task of openTasks) {
      if (nextFollowUpByProfile.has(task.profileId)) continue;
      nextFollowUpByProfile.set(task.profileId, task.dueAt?.toISOString() ?? null);
    }
  }

  const communicatedCount = new Set([
    ...communicatedProfileIds,
  ]).size;

  // Build customer rows（profileId 主权）
  const customers = allProfileIds.map((pid) => {
    const profile = profileById.get(pid);
    const customerView = profile ? buildCrmProfileCustomerView(profile) : null;
    const ix = interactionByProfile.get(pid) || null;
    const demandSummary =
      ix?.summaryTitle?.trim() ||
      ix?.summary?.trim() ||
      ix?.summaryNote?.trim() ||
      profile?.summary?.trim() ||
      null;

    return {
      profileId: pid,
      customerName: customerView?.name || "未知",
      customerCode: customerView?.customerCode || "",
      organization: profile
        ? getCustomerOrganizationName({ organization: profile.organization, org: profile.org })
        : null,
      stage: profile?.stage || "",
      importance: profile?.importance || "",
      personCategory: profile?.personCategory || null,
      jobTitle: profile?.jobTitle || null,
      graduationStatus: deriveGraduationStatus(profile?.personCategory || null, profile?.graduationDate ?? null),
      weeklyVisitCount: visitCountByProfile.get(pid) || 0,
      lastVisitAt: lastVisitByProfile.get(pid) || null,
      latestDemand: demandSummary || null,
      latestInteractionAt: ix?.happenedAt?.toISOString() ?? null,
      nextFollowUpAt: nextFollowUpByProfile.get(pid) || null,
      hasOrderThisWeek: orderProfileIds.includes(pid),
      customerView,
    };
  });

  // Draft with lines
  const draft = await prisma.crmRepresentativeReportDraft.findUnique({
    where: {
      representativeId_periodType_periodKey: {
        representativeId,
        periodType: "WEEK",
        periodKey,
      },
    },
    include: {
      lines: { orderBy: { sortOrder: "asc" } },
    },
  });

  // 草稿行只认 profileId（缺 profileId 的遗留行视为不存在客户）
  const lineProfileIds = compactIds(draft?.lines.map((l) => l.profileId) ?? []);
  const existingProfiles = lineProfileIds.length > 0
    ? await prisma.crmCustomerProfile.findMany({
        where: { id: { in: lineProfileIds }, deleted: false, archived: false },
        select: { id: true },
      })
    : [];
  const existingProfileIds = new Set(existingProfiles.map((p) => p.id));

  // Supplement profiles for draft lines not already loaded
  const missingLineProfileIds = lineProfileIds.filter((id) => !profileById.has(id));
  if (missingLineProfileIds.length > 0) {
    const extraProfiles = await prisma.crmCustomerProfile.findMany({
      where: { id: { in: missingLineProfileIds } },
      include: profileInclude,
    });
    for (const p of extraProfiles) {
      profileById.set(p.id, p);
    }

    const extraPids = extraProfiles.map((p) => p.id);
    if (extraPids.length > 0 && userId) {
      const extraVisitRows = await prisma.crmVisitCheckin.findMany({
        where: {
          userId,
          status: "COMPLETED",
          profileId: { in: extraPids },
          OR: [
            { completedAt: { gte: periodStart, lt: periodEnd } },
            { completedAt: null, createdAt: { gte: periodStart, lt: periodEnd } },
          ],
        },
        select: { profileId: true },
      });
      const extraVisitCount = new Map<string, number>();
      for (const row of extraVisitRows) {
        extraVisitCount.set(row.profileId, (extraVisitCount.get(row.profileId) || 0) + 1);
      }
      for (const pid of extraPids) {
        visitCountByProfile.set(pid, extraVisitCount.get(pid) || 0);
      }
      const extraLast = await getLastActorCheckinHappenedAtByProfileIds({
        userId,
        profileIds: extraPids,
      });
      for (const [pid, at] of extraLast) {
        if (lastVisitByProfile.has(pid)) continue;
        lastVisitByProfile.set(pid, at.toISOString());
      }
    }
  }

  const lines = (draft?.lines ?? []).map((l) => {
    const profile = l.profileId ? profileById.get(l.profileId) ?? null : null;
    const customerView = profile ? buildCrmProfileCustomerView(profile) : null;
    const pid = profile?.id ?? l.profileId ?? null;
    const customerExists = pid
      ? existingProfileIds.has(pid) || (profile ? !profile.deleted && !profile.archived : false)
      : false;
    return {
      id: l.id,
      profileId: pid ?? "",
      customerName: l.customerName,
      customerCode: customerView?.customerCode || "",
      organization: profile
        ? getCustomerOrganizationName({ organization: profile.organization, org: profile.org })
        : l.organization,
      demand: l.demand,
      note: l.note,
      sortOrder: l.sortOrder,
      customerExists,
      stage: profile?.stage || "",
      importance: profile?.importance || "",
      weeklyVisitCount: pid ? (visitCountByProfile.get(pid) || 0) : 0,
      lastVisitAt: pid ? (lastVisitByProfile.get(pid) || null) : null,
      hasOrderThisWeek: pid ? orderProfileIds.includes(pid) : false,
    };
  });

  return NextResponse.json({
    representative: { id: rep.id, name: rep.name, email: rep.email },
    accountUnlinked,
    periodKey,
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
    periodStartDate: week.periodStartDate,
    periodEndDate: week.periodEndDate,
    summary: {
      visitCheckinCount,
      newCustomerCount,
      reservedOrderCount,
      communicationEventCount,
      communicatedCustomerCount: communicatedCount,
      newBusinessAmountCents: newBusinessCents,
      deliveryBusinessAmountCents: deliveryBusinessCents,
      confirmedBusinessAmountCents: confirmedBusinessCents,
      // 兼容旧字段名（仍为分）
      newBusinessAmount: newBusinessCents,
      deliveryBusinessAmount: deliveryBusinessCents,
      confirmedBusinessAmount: confirmedBusinessCents,
      complaintTotal: complaintStats.total,
      complaintOpen: complaintStats.open,
      complaintHighSeverity: complaintStats.highSeverity,
    },
    customers,
    lines,
    draftNote: draft?.note ?? null,
  });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ representativeId: string }> }
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { representativeId } = await params;
  const rep = await prisma.representative.findUnique({ where: { id: representativeId } });
  if (!rep) return NextResponse.json({ error: "Representative not found" }, { status: 404 });

  const canWrite = await canAccessOwnRepresentativeReport(
    session.user.id,
    session.user.role,
    representativeId,
  );
  if (!canWrite) {
    return NextResponse.json({ error: "Forbidden: only the linked sales user can edit their own report" }, { status: 403 });
  }

  const linkedUser = await prisma.user.findFirst({
    where: { email: rep.email, id: session.user.id },
  });
  if (!linkedUser) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await req.json();
  const { periodType, periodKey, note, lines: rawLines } = body;

  if (!periodType || !periodKey) {
    return NextResponse.json({ error: "periodType and periodKey are required" }, { status: 400 });
  }

  // Validate lines if provided
  let normalizedLines: Array<{
    profileId: string;
    customerName: string;
    organization: string | null;
    demand: string;
    note: string;
  }> | undefined;

  if (rawLines !== undefined) {
    if (!Array.isArray(rawLines)) {
      return NextResponse.json({ error: "lines must be an array" }, { status: 400 });
    }
    if (rawLines.length > 50) {
      return NextResponse.json({ error: "lines exceeds maximum of 50" }, { status: 400 });
    }

    const MAX_LEN = 2000;
    const resolved: Array<{
      profileId: string;
      customerName: string;
      organization: string | null;
      demand: string;
      note: string;
    }> = [];

    for (let i = 0; i < rawLines.length; i++) {
      const l = rawLines[i];
      if (!l || typeof l !== "object") {
        return NextResponse.json({ error: `lines[${i}] is not an object` }, { status: 400 });
      }
      const profileId =
        (typeof l.profileId === "string" && l.profileId.trim()) || "";
      if (!profileId) {
        // 旧 *CustomerId 系参数一律 400（键名枚举，避免在源码里引用已废弃契约）。
        const legacyKey = Object.keys(l).find((k) => /customerids?$/i.test(k));
        if (legacyKey) {
          return NextResponse.json(
            { error: `lines[${i}].profileId is required（不再接受 ${legacyKey}）` },
            { status: 400 },
          );
        }
        return NextResponse.json(
          { error: `lines[${i}].profileId is required` },
          { status: 400 },
        );
      }
      if (typeof l.customerName !== "string" || l.customerName.length > MAX_LEN) {
        return NextResponse.json({ error: `lines[${i}].customerName too long` }, { status: 400 });
      }
      if (l.organization && typeof l.organization !== "string") {
        return NextResponse.json({ error: `lines[${i}].organization must be a string` }, { status: 400 });
      }
      if (typeof l.demand !== "string" || l.demand.length > MAX_LEN) {
        return NextResponse.json({ error: `lines[${i}].demand too long` }, { status: 400 });
      }
      if (typeof l.note !== "string" || l.note.length > MAX_LEN) {
        return NextResponse.json({ error: `lines[${i}].note too long` }, { status: 400 });
      }

      const ref = await findActiveProfile(profileId, prisma);
      if (!ref) {
        return NextResponse.json({ error: `lines[${i}] customer not found` }, { status: 400 });
      }
      resolved.push({
        profileId: ref.profileId,
        customerName: String(l.customerName || "").slice(0, MAX_LEN),
        organization: l.organization ? String(l.organization).slice(0, MAX_LEN) : null,
        demand: String(l.demand || "").slice(0, MAX_LEN),
        note: String(l.note || "").slice(0, MAX_LEN),
      });
    }

    // Ownership：行内 Profile 必须落在本代表绩效 scope（含 Profile-only）
    const perfScope = await buildRepresentativePerformanceScope(representativeId);
    const owned = new Set(perfScope.profileIds);
    for (let i = 0; i < resolved.length; i++) {
      if (!owned.has(resolved[i].profileId)) {
        return NextResponse.json(
          { error: `lines[${i}] does not belong to you` },
          { status: 403 },
        );
      }
    }
    normalizedLines = resolved;
  }

  // Transactional save
  const result = await prisma.$transaction(async (tx) => {
    const draft = await tx.crmRepresentativeReportDraft.upsert({
      where: {
        representativeId_periodType_periodKey: {
          representativeId,
          periodType,
          periodKey,
        },
      },
      create: {
        representativeId,
        periodType,
        periodKey,
        note: note !== undefined ? (note?.trim() || "") : "",
        createdByUserId: session.user.id,
      },
      update: {
        ...(note !== undefined ? { note: note?.trim() || "" } : {}),
        updatedByUserId: session.user.id,
      },
    });

    if (normalizedLines !== undefined) {
      await tx.crmRepresentativeReportLine.deleteMany({
        where: { reportDraftId: draft.id },
      });
      if (normalizedLines.length > 0) {
        await tx.crmRepresentativeReportLine.createMany({
          data: normalizedLines.map((l, i) => ({
            reportDraftId: draft.id,
            profileId: l.profileId,
            customerName: l.customerName,
            organization: l.organization,
            demand: l.demand,
            note: l.note,
            sortOrder: i,
          })),
        });
      }
    }

    const updatedLines = await tx.crmRepresentativeReportLine.findMany({
      where: { reportDraftId: draft.id },
      orderBy: { sortOrder: "asc" },
    });

    return {
      draftNote: draft.note,
      lines: updatedLines.map((l) => ({
        id: l.id,
        profileId: l.profileId,
        customerName: l.customerName,
        organization: l.organization,
        demand: l.demand,
        note: l.note,
        sortOrder: l.sortOrder,
      })),
    };
  });

  return NextResponse.json(result);
}

// POST alias retained for backward compatibility (browser unload sendBeacon)
export { PATCH as POST };

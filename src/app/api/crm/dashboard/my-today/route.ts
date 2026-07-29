import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isRepresentativeRole, isRegionalManagerRole } from "@/lib/crm/permissions";
import { resolveDashboardScope, buildDashboardRows } from "@/lib/crm/dashboard-data";
import { getCrmLifecycleSummariesForProfiles } from "@/lib/crm/lifecycle";
import { COMPLAINT_OPEN_STATUSES } from "@/lib/crm/constants";
import type { CrmDashboardCustomerRow } from "@/lib/crm/types";
import { getBusinessDayWindow } from "@/lib/business-time";
import { getCrmPersonalDashboardSummary } from "@/lib/crm/dashboard-summary";

export interface MyTodayItem {
  id: string;
  profileId: string;
  customerName: string;
  organization: string | null;
  sourceLabel: "逾期跟进" | "今日跟进" | "沟通计划到期" | "需要拜访" | "近期下单" | "风险提醒";
  reason: string;
  dueAt: string | null;
  taskType: string | null;
  nextAction: "add_interaction" | "checkin" | "view_customer";
}

export interface MyTodayResponse {
  overdueTaskCount: number;
  dueTodayTaskCount: number;
  suggestedContactCount: number;
  suggestedVisitCount: number;
  items: MyTodayItem[];
  recentOrderedCustomers: CrmDashboardCustomerRow[];
}

/**
 * GET /api/crm/dashboard/my-today
 *
 * Returns the current user's "today workbench" data -- only their own
 * tasks and customer reminders. REGIONAL_MANAGER only gets their own
 * work, not their managed reps' tasks.
 */
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Only sales roles have a personal "today" workbench.
  if (!isRepresentativeRole(session.user.role) && !isRegionalManagerRole(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const now = new Date();
  const { start: todayStart, end: todayEnd } = getBusinessDayWindow(now);
  const contactCutoff = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // 7 days ahead
  const recentOrderCutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  // Scope: only the current user's own customers (not managed reps')
  const scope = await resolveDashboardScope(session.user.id, session.user.role);
  const myProfileIdArray = [...scope.myProfileIds];

  if (myProfileIdArray.length === 0) {
    return NextResponse.json<MyTodayResponse>({
      overdueTaskCount: 0,
      dueTodayTaskCount: 0,
      suggestedContactCount: 0,
      suggestedVisitCount: 0,
      items: [],
      recentOrderedCustomers: [],
    });
  }

  // Fetch all open follow-up tasks for my profiles, filtered to MY tasks only
  // (not tasks owned by others but on my customers).  Take 50 for the list;
  // KPI counts use separate DB count() queries below to avoid truncation.
  const openTasks = await prisma.crmFollowUpTask.findMany({
    where: {
      profileId: { in: myProfileIdArray },
      ownerUserId: session.user.id,
      status: "OPEN",
    },
    include: {
      profile: {
        select: {
          id: true,
          name: true,
          organization: true,
          org: { select: { canonicalName: true } },
          orgSite: { select: { siteName: true } },
        },
      },
    },
    orderBy: { dueAt: "asc" },
    take: 50,
  });

  // Lifecycle summaries for my profiles (含 Profile-only)
  const lifecycleMap = await getCrmLifecycleSummariesForProfiles(myProfileIdArray);

  // Profiles with their data for building items
  const myProfiles = await prisma.crmCustomerProfile.findMany({
    where: { id: { in: myProfileIdArray } },
    select: {
      id: true,
      name: true,
      organization: true,
      org: { select: { canonicalName: true } },
      orgSite: { select: { siteName: true } },
    },
  });
  const profileById = new Map(myProfiles.map((p) => [p.id, p]));

  // Build items from tasks
  const items: MyTodayItem[] = [];
  const seenItemKeys = new Set<string>();

  for (const task of openTasks) {
    const profile = task.profile;
    const customerName = profile.name || profile.id;
    const orgName = profile.org?.canonicalName?.trim() || profile.organization?.trim() || null;

    let sourceLabel: MyTodayItem["sourceLabel"];
    let reason: string;
    let nextAction: MyTodayItem["nextAction"];

    if (task.dueAt < now) {
      sourceLabel = "逾期跟进";
      reason = task.title;
      nextAction = task.taskType === "VISIT" ? "checkin" : "add_interaction";
    } else if (task.dueAt >= todayStart && task.dueAt < todayEnd) {
      sourceLabel = "今日跟进";
      reason = task.title;
      nextAction = task.taskType === "VISIT" ? "checkin" : "add_interaction";
    } else if (task.taskType === "VISIT") {
      sourceLabel = "需要拜访";
      reason = task.title;
      nextAction = "checkin";
    } else {
      // Future contact task -- skip from "today" items
      continue;
    }

    const itemKey = `task:${task.id}`;
    if (seenItemKeys.has(itemKey)) continue;
    seenItemKeys.add(itemKey);

    items.push({
      id: task.id,
      profileId: profile.id,
      customerName,
      organization: orgName,
      sourceLabel,
      reason,
      dueAt: task.dueAt.toISOString(),
      taskType: task.taskType,
      nextAction,
    });
  }

  // Communication plan due: profiles whose nextCommunicationTaskAt is within 7 days
  // and don't already have a task in the items
  for (const [profileId, lifecycle] of lifecycleMap) {
    const nextAt = lifecycle.nextCommunicationTaskAt;
    if (!nextAt || nextAt > contactCutoff) continue;
    if (nextAt < now) continue; // overdue ones should already have tasks

    const profile = profileById.get(profileId) ?? myProfiles.find((p) => p.id === profileId);
    if (!profile) continue;

    const itemKey = `comm-plan:${profile.id}`;
    if (seenItemKeys.has(itemKey)) continue;
    // Skip if we already have a task item for this profile
    if (items.some((i) => i.profileId === profile.id && (i.sourceLabel === "逾期跟进" || i.sourceLabel === "今日跟进"))) continue;

    seenItemKeys.add(itemKey);
    items.push({
      id: `comm-plan-${profile.id}`,
      profileId: profile.id,
      customerName: profile.name || profile.id,
      organization: profile.org?.canonicalName?.trim() || profile.organization?.trim() || null,
      sourceLabel: "沟通计划到期",
      reason: "沟通计划到期，建议联系客户",
      dueAt: nextAt.toISOString(),
      taskType: null,
      nextAction: "add_interaction",
    });
  }

  // Risk reminders: dormant warning + high-severity complaints
  const [dormantProfiles, highSeverityComplaints] = await Promise.all([
    prisma.crmCustomerProfile.findMany({
      where: {
        id: { in: myProfileIdArray },
      },
      select: {
        id: true,
        name: true,
        organization: true,
        org: { select: { canonicalName: true } },
        orgSite: { select: { siteName: true } },
      },
    }),
    prisma.crmComplaint.findMany({
      where: {
        profileId: { in: myProfileIdArray },
        status: { in: [...COMPLAINT_OPEN_STATUSES] },
        severity: { in: ["HIGH", "CRITICAL"] },
      },
      select: { profileId: true, title: true },
    }),
  ]);

  // Dormant risk customers
  for (const profile of dormantProfiles) {
    const lifecycle = lifecycleMap.get(profile.id);
    if (!lifecycle?.dormantRisk) continue;

    const itemKey = `risk-dormant:${profile.id}`;
    if (seenItemKeys.has(itemKey)) continue;
    if (items.some((i) => i.profileId === profile.id)) continue;

    seenItemKeys.add(itemKey);
    items.push({
      id: `risk-dormant-${profile.id}`,
      profileId: profile.id,
      customerName: profile.name || profile.id,
      organization: profile.org?.canonicalName?.trim() || profile.organization?.trim() || null,
      sourceLabel: "风险提醒",
      reason: "休眠预警：客户长时间无跟进",
      dueAt: null,
      taskType: null,
      nextAction: "add_interaction",
    });
  }

  // High-severity complaints
  for (const complaint of highSeverityComplaints) {
    const profile = profileById.get(complaint.profileId);
    if (!profile) continue;

    const itemKey = `risk-complaint:${complaint.profileId}`;
    if (seenItemKeys.has(itemKey)) continue;
    if (items.some((i) => i.profileId === complaint.profileId)) continue;

    seenItemKeys.add(itemKey);
    items.push({
      id: `risk-complaint-${complaint.profileId}`,
      profileId: complaint.profileId,
      customerName: profile.name || profile.id,
      organization: profile.org?.canonicalName?.trim() || profile.organization?.trim() || null,
      sourceLabel: "风险提醒",
      reason: `高严重客诉：${complaint.title}`,
      dueAt: null,
      taskType: null,
      nextAction: "view_customer",
    });
  }

  // Sort items: overdue first, then today, then visit, then comm-plan, then risk
  const labelOrder: Record<MyTodayItem["sourceLabel"], number> = {
    "逾期跟进": 0,
    "今日跟进": 1,
    "需要拜访": 2,
    "沟通计划到期": 3,
    "近期下单": 4,
    "风险提醒": 5,
  };
  items.sort((a, b) => {
    const labelDiff = labelOrder[a.sourceLabel] - labelOrder[b.sourceLabel];
    if (labelDiff !== 0) return labelDiff;
    if (a.dueAt && b.dueAt) return new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime();
    return 0;
  });

  // Recent ordered customers (last 30 days)
  const allRows = await buildDashboardRows(myProfileIdArray, now);
  const recentOrderedCustomers = allRows
    .filter((r) => r.lastHistoricalOrderAt && new Date(r.lastHistoricalOrderAt) >= recentOrderCutoff)
    .sort((a, b) => (b.lastHistoricalOrderAt ?? "").localeCompare(a.lastHistoricalOrderAt ?? ""))
    .slice(0, 5);

  // Add recent-ordered as items too (if not already covered)
  for (const row of recentOrderedCustomers) {
    const itemKey = `recent-order:${row.profileId}`;
    if (seenItemKeys.has(itemKey)) continue;
    if (items.some((i) => i.profileId === row.profileId)) continue;

    seenItemKeys.add(itemKey);
    items.push({
      id: `recent-order-${row.profileId}`,
      profileId: row.profileId,
      customerName: row.customerName,
      organization: row.organization,
      sourceLabel: "近期下单",
      reason: "客户近期有新订单，建议跟进",
      dueAt: row.lastHistoricalOrderAt,
      taskType: null,
      nextAction: "add_interaction",
    });
  }

  // Counts share the lightweight dashboard summary helper so the home page and
  // CRM workbench cannot drift in role/profile/time semantics.
  const {
    overdueTaskCount,
    dueTodayTaskCount,
    suggestedContactCount,
    suggestedVisitCount,
  } = await getCrmPersonalDashboardSummary(session.user.id, session.user.role, now);

  // Limit items to 30
  const limitedItems = items.slice(0, 30);

  return NextResponse.json<MyTodayResponse>({
    overdueTaskCount,
    dueTodayTaskCount,
    suggestedContactCount,
    suggestedVisitCount,
    items: limitedItems,
    recentOrderedCustomers,
  });
}

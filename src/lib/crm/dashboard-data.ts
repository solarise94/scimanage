/**
 * Shared dashboard data helpers.
 *
 * Extracted from the original /api/crm/dashboard route so that
 * /api/crm/dashboard/my-today and /api/crm/dashboard/admin-overview
 * can reuse the same scoping and row-building logic without
 * diverging into a second set of calculation formulas.
 * 旧 GET /api/crm/dashboard 已 410 退役。
 *
 * W6.4：scope 只认 profileIds（含 Profile-only）；不再维护 Customer 锚点集合或 orphan Customer。
 */

import { prisma } from "@/lib/prisma";
import {
  isRepresentativeRole,
  isRegionalManagerRole,
  getRegionalManagerUserIds,
} from "@/lib/crm/permissions";
import {
  resolveEffectiveRepresentativesForProfiles,
} from "@/lib/crm/customer-effective-representative";
import { getCrmLifecycleSummariesForProfiles } from "@/lib/crm/lifecycle";
import { getCustomerOrganizationName } from "@/lib/customer-organization";
import { COMPLAINT_OPEN_STATUSES } from "@/lib/crm/constants";
import type { CrmDashboardCustomerRow } from "@/lib/crm/types";

export interface DashboardScope {
  /** Profile IDs visible to the current user. */
  visibleProfileIds: Set<string>;
  /** Profile IDs whose effective owner is the current user. */
  myProfileIds: Set<string>;
  /** True if the user is REPRESENTATIVE or REGIONAL_MANAGER. */
  isScoped: boolean;
}

/**
 * Resolve the dashboard scope for the current session user.
 * Returns visible/my profile ID sets based on effective representative ownership
 * （含 Profile-only 机构绑定；RECALLED 不进 scope）。
 */
export async function resolveDashboardScope(
  userId: string,
  role: string,
): Promise<DashboardScope> {
  const isScoped = isRepresentativeRole(role) || isRegionalManagerRole(role);

  const allProfiles = await prisma.crmCustomerProfile.findMany({
    where: { archived: false, deleted: false },
    select: {
      id: true,
      ownerUserId: true,
      assignmentStatus: true,
    },
  });

  const profileEffectiveMap = await resolveEffectiveRepresentativesForProfiles(
    allProfiles.map((p) => p.id),
  );

  let allowedOwnerIds: string[] | null = null;
  if (isScoped) {
    if (isRepresentativeRole(role)) {
      allowedOwnerIds = [userId];
    } else if (isRegionalManagerRole(role)) {
      const repUserIds = await getRegionalManagerUserIds(userId);
      allowedOwnerIds = repUserIds && repUserIds.length > 0 ? [userId, ...repUserIds] : [userId];
    }
  }

  const visibleProfileIds = new Set<string>();
  const myProfileIds = new Set<string>();

  for (const profile of allProfiles) {
    // Scoped sales: only ASSIGNED（RECALLED/UNASSIGNED 入池，不进 Dashboard）
    if (isScoped && profile.assignmentStatus !== "ASSIGNED") continue;

    const effectiveOwnerUserId =
      profileEffectiveMap.get(profile.id)?.ownerUserId ?? profile.ownerUserId;
    const isVisible =
      !isScoped
      || (allowedOwnerIds !== null
        && effectiveOwnerUserId !== null
        && allowedOwnerIds.includes(effectiveOwnerUserId));
    if (isVisible) {
      visibleProfileIds.add(profile.id);
      if (effectiveOwnerUserId === userId) {
        myProfileIds.add(profile.id);
      }
    }
  }

  return {
    visibleProfileIds,
    myProfileIds,
    isScoped,
  };
}

/**
 * Build a dashboard customer row from a profile.
 * Reused by dashboard, my-today, and admin-overview.
 */
export async function buildDashboardRows(
  profileIds: string[],
  now: Date,
): Promise<CrmDashboardCustomerRow[]> {
  if (profileIds.length === 0) return [];

  const profiles = await prisma.crmCustomerProfile.findMany({
    where: { id: { in: profileIds } },
    select: {
      id: true,
      name: true,
      customerCode: true,
      organization: true,
      org: { select: { canonicalName: true } },
      orgSite: { select: { siteName: true } },
      lastFollowUpAt: true,
      nextFollowUpAt: true,
      ownerUser: { select: { name: true } },
    },
  });

  const [lifecycleMap, overdueTasks] = await Promise.all([
    getCrmLifecycleSummariesForProfiles(profileIds),
    prisma.crmFollowUpTask.findMany({
      where: {
        profileId: { in: profileIds },
        status: "OPEN",
        dueAt: { lt: now },
      },
      select: { profileId: true },
    }),
  ]);

  const overdueProfileIds = new Set(overdueTasks.map((t) => t.profileId));

  return profiles.map((profile) => {
    const lifecycle = lifecycleMap.get(profile.id);
    const warningReasons: string[] = [];
    if (lifecycle?.dormantRisk) warningReasons.push("休眠预警");
    if (overdueProfileIds.has(profile.id)) warningReasons.push("跟进逾期");
    if (lifecycle?.overdueCommunicationTaskCount) warningReasons.push("沟通任务逾期");

    return {
      profileId: profile.id,
      customerName: profile.name || profile.id,
      customerCode: profile.customerCode || "",
      organization: getCustomerOrganizationName(profile),
      ownerName: profile.ownerUser?.name ?? "",
      historicalOrderCount: lifecycle?.historicalOrderCount ?? 0,
      lastHistoricalOrderAt: lifecycle?.lastHistoricalOrderAt?.toISOString() ?? null,
      isRepeatCustomer: lifecycle?.isRepeatCustomer ?? false,
      lastFollowUpAt: profile.lastFollowUpAt?.toISOString() ?? null,
      nextFollowUpAt: profile.nextFollowUpAt?.toISOString() ?? null,
      nextCommunicationTaskAt: lifecycle?.nextCommunicationTaskAt?.toISOString() ?? null,
      warningReasons,
    };
  });
}

/**
 * Count pending admin governance items.
 */
export async function getAdminPendingCounts() {
  const [
    pendingApplications,
    pendingOrgBindingTasks,
    pendingMergeTasks,
    pendingOrgReviewTasks,
  ] = await Promise.all([
    prisma.crmCustomerApplication.count({ where: { status: "PENDING" } }),
    prisma.customerOrgBindingTask.count({ where: { status: "PENDING" } }),
    prisma.customerMergeTask.count({ where: { status: "PENDING" } }),
    prisma.organizationReviewTask.count({ where: { status: "PENDING" } }),
  ]);
  return { pendingApplications, pendingOrgBindingTasks, pendingMergeTasks, pendingOrgReviewTasks };
}

/**
 * Count open and high-severity complaints for a set of profile IDs.
 */
export async function getComplaintCounts(profileIds: string[]) {
  if (profileIds.length === 0) return { openComplaintCount: 0, highSeverityComplaintCount: 0 };
  const filter = { profileId: { in: profileIds }, status: { in: [...COMPLAINT_OPEN_STATUSES] } };
  const [openComplaintCount, highSeverityComplaintCount] = await Promise.all([
    prisma.crmComplaint.count({ where: filter }),
    prisma.crmComplaint.count({ where: { ...filter, severity: { in: ["HIGH", "CRITICAL"] } } }),
  ]);
  return { openComplaintCount, highSeverityComplaintCount };
}

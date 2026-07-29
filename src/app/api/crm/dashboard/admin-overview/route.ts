import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { resolveDashboardScope, buildDashboardRows, getAdminPendingCounts, getComplaintCounts } from "@/lib/crm/dashboard-data";
import { resolveEffectiveRepresentativesForProfiles } from "@/lib/crm/customer-effective-representative";
import { loadRepresentativeOpsFactsBatch } from "@/lib/crm/representative-ops-facts";
import { REFLOW_THRESHOLD_DAYS } from "@/lib/crm/constants";
import { collectByChunks } from "@/lib/finance/query-chunk";
import type { CrmDashboardCustomerRow, CrmInteractionItem } from "@/lib/crm/types";
import { getCrmAdminDashboardSummary } from "@/lib/crm/dashboard-summary";

export interface AdminOverviewResponse {
  // Global KPIs
  totalProfiles: number;
  pendingFollowUps: number;
  overdueFollowUps: number;
  communicationCoverageRate30d: number;
  recentOrderedCustomerCount: number;
  repeatCustomerCount: number;
  dormantWarningCustomerCount: number;
  openComplaintCount: number;
  highSeverityComplaintCount: number;
  // Admin pending governance
  pendingApplications: number;
  pendingOrgBindingTasks: number;
  pendingMergeTasks: number;
  pendingOrgReviewTasks: number;
  // Representative alerts
  representativeAlerts: Array<{
    representativeId: string;
    name: string;
    overdueFollowUps: number;
    longUnvisitedCount: number;
  }>;
  // Compact customer lists
  recentOrderedCustomers: CrmDashboardCustomerRow[];
  repeatCustomers: CrmDashboardCustomerRow[];
  warningCustomers: CrmDashboardCustomerRow[];
  // Recent interactions (global, with deep-link)
  recentInteractions: CrmInteractionItem[];
}

/**
 * GET /api/crm/dashboard/admin-overview
 *
 * Returns a global operations overview for ADMIN users.
 * Focuses on management actions: KPIs, representative alerts,
 * pending governance items, and customer lists.
 */
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const now = new Date();
  const d30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const recentOrderCutoff = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);

  // ADMIN sees all profiles
  const scope = await resolveDashboardScope(session.user.id, session.user.role);
  const visibleProfileIdArray = [...scope.visibleProfileIds];

  const emptyScope = visibleProfileIdArray.length === 0;
  const [
    adminSummary,
    adminPending,
    complaintCounts,
    recentInteractionsRaw,
    allRows,
  ] = await Promise.all([
    getCrmAdminDashboardSummary(session.user.id, session.user.role, now),
    getAdminPendingCounts(),
    getComplaintCounts(visibleProfileIdArray),
    emptyScope
      ? Promise.resolve([])
      : collectByChunks(visibleProfileIdArray, (chunk) =>
          prisma.crmInteraction.findMany({
            where: { profileId: { in: chunk } },
            include: {
              createdByUser: { select: { id: true, name: true } },
              profile: { select: { id: true, name: true } },
            },
            orderBy: { happenedAt: "desc" },
            take: 10,
          }),
        ).then((rows) =>
          rows
            .sort((a, b) => b.happenedAt.getTime() - a.happenedAt.getTime())
            .slice(0, 10),
        ),
    // KPI cards + compact lists share Profile-lifecycle rows (含 Profile-only)
    buildDashboardRows(visibleProfileIdArray, now),
  ]);

  const recentOrderedRows = allRows.filter(
    (r) => r.lastHistoricalOrderAt && new Date(r.lastHistoricalOrderAt) >= recentOrderCutoff,
  );
  const repeatRows = allRows.filter((r) => r.isRepeatCustomer);

  const recentOrderedCustomers = [...recentOrderedRows]
    .sort((a, b) => (b.lastHistoricalOrderAt ?? "").localeCompare(a.lastHistoricalOrderAt ?? ""))
    .slice(0, 5);

  const repeatCustomers = [...repeatRows]
    .sort((a, b) => (b.lastHistoricalOrderAt ?? "").localeCompare(a.lastHistoricalOrderAt ?? ""))
    .slice(0, 5);

  const warningCustomers = allRows
    .filter((r) => r.warningReasons.length > 0)
    .sort((a, b) => (b.lastHistoricalOrderAt ?? "").localeCompare(a.lastHistoricalOrderAt ?? ""))
    .slice(0, 5);

  const recentOrderedCustomerCount = recentOrderedRows.length;
  const repeatCustomerCount = repeatRows.length;
  const dormantWarningCustomerCount = allRows.filter((r) => r.warningReasons.includes("休眠预警")).length;

  const totalProfiles = adminSummary.totalProfiles;
  const communicationCoverageRate30d = adminSummary.communicationCoverageRate30d;

  // Representative alerts：统一 effective resolver（含 Profile-only），仅 ASSIGNED，避免残留 MANAGING tag 误归属
  const assignedProfiles =
    visibleProfileIdArray.length > 0
      ? await prisma.crmCustomerProfile.findMany({
          where: {
            id: { in: visibleProfileIdArray },
            assignmentStatus: "ASSIGNED",
            archived: false,
            deleted: false,
          },
          select: { id: true },
        })
      : [];
  const assignedProfileIds = assignedProfiles.map((p) => p.id);
  const profileEffectiveMap =
    assignedProfileIds.length > 0
      ? await resolveEffectiveRepresentativesForProfiles(assignedProfileIds)
      : new Map();

  const repProfileMap = new Map<string, Set<string>>();
  for (const profileId of assignedProfileIds) {
    const representativeId = profileEffectiveMap.get(profileId)?.representativeId;
    if (!representativeId) continue;
    const pset = repProfileMap.get(representativeId) || new Set<string>();
    pset.add(profileId);
    repProfileMap.set(representativeId, pset);
  }
  const repIds = [...repProfileMap.keys()];
  const reps = repIds.length > 0
    ? await prisma.representative.findMany({
        where: { id: { in: repIds }, kind: "HUMAN", archived: false },
        select: { id: true, name: true },
      })
    : [];

  // 与列表/详情同源：owner + effective profile scope
  const repRows = reps.length > 0
    ? await prisma.representative.findMany({
        where: { id: { in: reps.map((r) => r.id) } },
        select: { id: true, email: true, name: true },
      })
    : [];
  const emails = repRows.map((r) => r.email);
  const linkedUsers = emails.length > 0
    ? await prisma.user.findMany({
        where: { email: { in: emails }, role: { in: ["REPRESENTATIVE", "REGIONAL_MANAGER"] } },
        select: { id: true, email: true },
      })
    : [];
  const emailToUserId = new Map(linkedUsers.map((u) => [u.email, u.id]));
  const thresholdDate = new Date(now.getTime() - REFLOW_THRESHOLD_DAYS * 24 * 60 * 60 * 1000);
  const opsSubjects = repRows.map((r) => ({
    representativeId: r.id,
    linkedUserId: emailToUserId.get(r.email) ?? null,
    profileIds: [...(repProfileMap.get(r.id) ?? [])],
  }));
  const opsFacts = await loadRepresentativeOpsFactsBatch(opsSubjects, {
    from: d30,
    to: now,
    now,
    longUnvisitedThresholdDate: thresholdDate,
  });
  const nameById = new Map(repRows.map((r) => [r.id, r.name]));
  const representativeAlerts: AdminOverviewResponse["representativeAlerts"] = [];
  for (const [repId, facts] of opsFacts) {
    if (facts.overdueFollowUps > 0 || facts.longUnvisitedCount > 0) {
      representativeAlerts.push({
        representativeId: repId,
        name: nameById.get(repId) || repId,
        overdueFollowUps: facts.overdueFollowUps,
        longUnvisitedCount: facts.longUnvisitedCount,
      });
    }
  }
  representativeAlerts.sort((a, b) => b.overdueFollowUps - a.overdueFollowUps || b.longUnvisitedCount - a.longUnvisitedCount);

  // Map recent interactions to CrmInteractionItem
  const recentInteractions: CrmInteractionItem[] = recentInteractionsRaw.map((i) => ({
    id: i.id,
    profileId: i.profileId,
    type: i.type,
    summary: i.summary,
    detail: i.detail,
    happenedAt: i.happenedAt.toISOString(),
    nextActionAt: i.nextActionAt?.toISOString() ?? null,
    relatedProjectId: i.relatedProjectId,
    sourceType: i.sourceType,
    sourceId: i.sourceId,
    createdByUserId: i.createdByUserId,
    createdByUser: { id: i.createdByUser.id, name: i.createdByUser.name },
    voiceUrl: i.voiceUrl,
    transcript: i.transcript,
    summaryTitle: i.summaryTitle,
    summaryNote: i.summaryNote,
    asrStatus: i.asrStatus,
    createdAt: i.createdAt.toISOString(),
    profile: i.profile
      ? {
          id: i.profile.id,
          name: i.profile.name,
        }
      : undefined,
  }));

  return NextResponse.json<AdminOverviewResponse>({
    totalProfiles,
    pendingFollowUps: adminSummary.pendingFollowUps,
    overdueFollowUps: adminSummary.overdueFollowUps,
    communicationCoverageRate30d,
    recentOrderedCustomerCount,
    repeatCustomerCount,
    dormantWarningCustomerCount,
    openComplaintCount: complaintCounts.openComplaintCount,
    highSeverityComplaintCount: complaintCounts.highSeverityComplaintCount,
    pendingApplications: adminPending.pendingApplications,
    pendingOrgBindingTasks: adminPending.pendingOrgBindingTasks,
    pendingMergeTasks: adminPending.pendingMergeTasks,
    pendingOrgReviewTasks: adminPending.pendingOrgReviewTasks,
    representativeAlerts: representativeAlerts.slice(0, 10),
    recentOrderedCustomers,
    repeatCustomers,
    warningCustomers,
    recentInteractions,
  });
}

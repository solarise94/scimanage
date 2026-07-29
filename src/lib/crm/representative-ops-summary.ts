import { prisma } from "@/lib/prisma";
import { REFLOW_THRESHOLD_DAYS } from "@/lib/crm/constants";
import { groupProfileIdsByEffectiveOwnerForRepresentatives } from "@/lib/crm/representative-performance";
import { loadRepresentativeOpsFactsBatch } from "@/lib/crm/representative-ops-facts";

export interface RepresentativeOpsDashboardSummary {
  activeRepresentativeCount: number;
  interactionCount30d: number;
  overdueFollowUps: number;
  longUnvisitedCount: number;
  hasManagedRepresentatives: boolean;
}

export async function getRepresentativeOpsDashboardSummary(
  userId: string,
  role: string,
  now: Date = new Date(),
): Promise<RepresentativeOpsDashboardSummary> {
  let allowedRepresentativeIds: string[] | null = null;
  if (role === "REGIONAL_MANAGER") {
    const manager = await prisma.crmRegionManager.findUnique({
      where: { userId, archived: false },
      include: { reps: { select: { representativeId: true } } },
    });
    allowedRepresentativeIds = manager?.reps.map((link) => link.representativeId) ?? [];
  }

  const representatives = await prisma.representative.findMany({
    where: {
      kind: "HUMAN",
      archived: false,
      ...(allowedRepresentativeIds ? { id: { in: allowedRepresentativeIds } } : {}),
    },
    select: { id: true, email: true },
  });
  if (representatives.length === 0) {
    return {
      activeRepresentativeCount: 0,
      interactionCount30d: 0,
      overdueFollowUps: 0,
      longUnvisitedCount: 0,
      hasManagedRepresentatives: role !== "REGIONAL_MANAGER" || (allowedRepresentativeIds?.length ?? 0) > 0,
    };
  }

  const linkedUsers = await prisma.user.findMany({
    where: {
      email: { in: representatives.map((rep) => rep.email) },
      role: { in: ["REPRESENTATIVE", "REGIONAL_MANAGER"] },
    },
    select: { id: true, email: true },
  });
  const userIdByEmail = new Map(linkedUsers.map((user) => [user.email, user.id]));
  const profileIdsByRepresentative = await groupProfileIdsByEffectiveOwnerForRepresentatives(
    representatives.map((rep) => ({
      representativeId: rep.id,
      linkedUserId: userIdByEmail.get(rep.email) ?? null,
    })),
  );
  const subjects = representatives.map((rep) => ({
    representativeId: rep.id,
    linkedUserId: userIdByEmail.get(rep.email) ?? null,
    profileIds: profileIdsByRepresentative.get(rep.id) ?? [],
  }));
  const facts = await loadRepresentativeOpsFactsBatch(subjects, {
    from: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000),
    to: now,
    now,
    longUnvisitedThresholdDate: new Date(
      now.getTime() - REFLOW_THRESHOLD_DAYS * 24 * 60 * 60 * 1000,
    ),
  });

  let interactionCount30d = 0;
  let overdueFollowUps = 0;
  let longUnvisitedCount = 0;
  for (const item of facts.values()) {
    interactionCount30d += item.interactionCount;
    overdueFollowUps += item.overdueFollowUps;
    longUnvisitedCount += item.longUnvisitedCount;
  }

  return {
    activeRepresentativeCount: representatives.length,
    interactionCount30d,
    overdueFollowUps,
    longUnvisitedCount,
    hasManagedRepresentatives: true,
  };
}

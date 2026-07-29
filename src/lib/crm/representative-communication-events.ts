import { prisma } from "@/lib/prisma";
import type { Prisma, PrismaClient } from "@prisma/client";

type DbClient = PrismaClient | Prisma.TransactionClient;

const REPRESENTATIVE_ACTOR_ROLES = ["REPRESENTATIVE", "REGIONAL_MANAGER"] as const;

export type RepresentativeCommunicationEvent = {
  eventKey: string;
  sourceType: "INTERACTION" | "CHECKIN";
  sourceId: string;
  actorUserId: string;
  profileId: string;
  happenedAt: Date;
  interactionType: string | null;
  originType: "MANUAL" | "CUSTOMER_APPLICATION" | "CHECKIN";
  originId: string | null;
};

/**
 * 代表沟通的单一事实源：
 * - 所有合法 interaction（含 NOTE）按 createdByUserId 归属；
 * - completed checkin 按 userId 归属；
 * - 被 checkin.interactionId 引用的派生 VISIT 不再作为 interaction 重复计数；
 * - ADMIN/USER 行为不会进入代表指标。
 */
export async function getRepresentativeCommunicationEvents(
  params: {
    actorUserIds?: string[];
    profileIds?: string[];
    from: Date;
    to: Date;
  },
  db: DbClient = prisma,
): Promise<RepresentativeCommunicationEvent[]> {
  const requestedActorIds = [...new Set((params.actorUserIds ?? []).filter(Boolean))];
  const requestedProfileIds = [...new Set((params.profileIds ?? []).filter(Boolean))];

  const eligibleUsers = await db.user.findMany({
    where: {
      role: { in: [...REPRESENTATIVE_ACTOR_ROLES] },
      ...(requestedActorIds.length > 0 ? { id: { in: requestedActorIds } } : {}),
    },
    select: { id: true },
  });
  const actorUserIds = eligibleUsers.map((user) => user.id);
  if (actorUserIds.length === 0) return [];

  const profileFilter = requestedProfileIds.length > 0
    ? { profileId: { in: requestedProfileIds } }
    : {};

  const [checkins, linkedCheckins] = await Promise.all([
    db.crmVisitCheckin.findMany({
      where: {
        ...profileFilter,
        userId: { in: actorUserIds },
        status: "COMPLETED",
        OR: [
          { completedAt: { gte: params.from, lt: params.to } },
          { completedAt: null, createdAt: { gte: params.from, lt: params.to } },
        ],
      },
      select: {
        id: true,
        userId: true,
        profileId: true,
        completedAt: true,
        createdAt: true,
        interactionId: true,
      },
    }),
    db.crmVisitCheckin.findMany({
      where: {
        ...profileFilter,
        interactionId: { not: null },
      },
      select: { interactionId: true },
    }),
  ]);

  const linkedInteractionIds = linkedCheckins
    .map((checkin) => checkin.interactionId)
    .filter((id): id is string => !!id);

  const interactions = await db.crmInteraction.findMany({
    where: {
      ...profileFilter,
      createdByUserId: { in: actorUserIds },
      happenedAt: { gte: params.from, lt: params.to },
      ...(linkedInteractionIds.length > 0 ? { id: { notIn: linkedInteractionIds } } : {}),
    },
    select: {
      id: true,
      createdByUserId: true,
      profileId: true,
      type: true,
      happenedAt: true,
      sourceType: true,
      sourceId: true,
    },
  });

  const interactionEvents: RepresentativeCommunicationEvent[] = interactions.map((interaction) => ({
    eventKey: `interaction:${interaction.id}`,
    sourceType: "INTERACTION",
    sourceId: interaction.id,
    actorUserId: interaction.createdByUserId,
    profileId: interaction.profileId,
    happenedAt: interaction.happenedAt,
    interactionType: interaction.type,
    originType: interaction.sourceType === "CUSTOMER_APPLICATION" ? "CUSTOMER_APPLICATION" : "MANUAL",
    originId: interaction.sourceId,
  }));

  const checkinEvents: RepresentativeCommunicationEvent[] = checkins.map((checkin) => ({
    eventKey: `checkin:${checkin.id}`,
    sourceType: "CHECKIN",
    sourceId: checkin.id,
    actorUserId: checkin.userId,
    profileId: checkin.profileId,
    happenedAt: checkin.completedAt ?? checkin.createdAt,
    interactionType: "VISIT",
    originType: "CHECKIN",
    originId: checkin.id,
  }));

  return [...interactionEvents, ...checkinEvents].sort(
    (a, b) => b.happenedAt.getTime() - a.happenedAt.getTime(),
  );
}

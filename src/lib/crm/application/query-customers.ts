/**
 * Canonical actor-aware CRM customer search (T5.1).
 *
 * Shared by Agent `crm.search_customers`.
 * Scope uses `getEffectiveCrmVisibleProfileIds`; filters use AND-composition.
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { BusinessActor } from "@/lib/application/actor";
import { getEffectiveCrmVisibleProfileIds } from "@/lib/crm/permissions";
import { assertCrmAgentReadAccess } from "@/lib/crm/application/crm-agent-access";

export type CustomerSearchParams = {
  query?: string | null;
  stage?: string | null;
  limit?: number;
};

export type CustomerSearchItem = {
  profileId: string;
  customerName: string;
  organization: string;
  stage: string;
  importance: string;
  ownerName: string;
  lastInteractionAt: string | null;
  followUpCount: number;
  interactionCount: number;
};

const SEARCH_SELECT = {
  id: true,
  name: true,
  stage: true,
  importance: true,
  lastFollowUpAt: true,
  organization: true,
  ownerUser: { select: { name: true } },
  _count: { select: { followUpTasks: true, interactions: true } },
} satisfies Prisma.CrmCustomerProfileSelect;

type SearchRecord = Prisma.CrmCustomerProfileGetPayload<{ select: typeof SEARCH_SELECT }>;

export function shapeCustomerSearchItem(profile: SearchRecord): CustomerSearchItem {
  return {
    profileId: profile.id,
    customerName: profile.name ?? "未命名客户",
    organization: profile.organization ?? "",
    stage: profile.stage,
    importance: profile.importance,
    ownerName: profile.ownerUser?.name ?? "",
    lastInteractionAt: profile.lastFollowUpAt?.toISOString() ?? null,
    followUpCount: profile._count.followUpTasks,
    interactionCount: profile._count.interactions,
  };
}

export async function searchCustomersForActor(
  actor: BusinessActor,
  params: CustomerSearchParams = {},
): Promise<{ items: CustomerSearchItem[] }> {
  assertCrmAgentReadAccess(actor);

  const limit = Math.max(1, Math.min(30, Math.trunc(params.limit ?? 10)));
  const query = params.query?.trim() ?? "";
  const stage = params.stage?.trim() ?? "";

  const visibleProfileIds = await getEffectiveCrmVisibleProfileIds(actor.userId, actor.role);
  const andConditions: Prisma.CrmCustomerProfileWhereInput[] = [
    { archived: false, deleted: false },
  ];
  if (visibleProfileIds) {
    andConditions.push({ id: { in: [...visibleProfileIds] } });
  }

  if (stage) {
    andConditions.push({ stage });
  }

  if (query) {
    andConditions.push({
      OR: [
        { name: { contains: query } },
        { customerCode: { contains: query } },
        { organization: { contains: query } },
        { principal: { contains: query } },
        { summary: { contains: query } },
      ],
    });
  }

  const profiles = await prisma.crmCustomerProfile.findMany({
    where: { AND: andConditions },
    take: limit,
    orderBy: { updatedAt: "desc" },
    select: SEARCH_SELECT,
  });

  return { items: profiles.map(shapeCustomerSearchItem) };
}

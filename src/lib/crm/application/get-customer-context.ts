/**
 * Canonical actor-aware CRM customer context query (T5.1).
 *
 * Shared by Agent `crm.get_customer_context`.
 * Out-of-scope profiles raise NotFoundError (no existence leak).
 */
import { prisma } from "@/lib/prisma";
import type { BusinessActor } from "@/lib/application/actor";
import { NotFoundError } from "@/lib/application/errors";
import {
  assertCrmProfileAccess,
  CrmAccessError,
  CrmAccessForbiddenError,
  CrmAccessNotFoundError,
} from "@/lib/crm/permissions";
import { assertCrmAgentReadAccess } from "@/lib/crm/application/crm-agent-access";

export type CustomerContextResult = {
  profileId: string;
  customerName: string;
  stage: string;
  importance: string;
  organization: string;
  principal: string;
  ownerName: string;
  email: string;
  wechat: string;
  lastInteractionAt: string | null;
  recentInteractions: Array<{
    id: string;
    type: string;
    summary: string;
    happenedAt: string;
  }>;
};

export async function getCustomerContextForActor(
  actor: BusinessActor,
  profileId: string,
): Promise<CustomerContextResult> {
  assertCrmAgentReadAccess(actor);

  try {
    await assertCrmProfileAccess(profileId, actor.userId, actor.role);
  } catch (error) {
    if (error instanceof CrmAccessNotFoundError || error instanceof CrmAccessForbiddenError) {
      throw new NotFoundError("客户资料不存在或已删除");
    }
    if (error instanceof CrmAccessError) {
      throw new NotFoundError("客户资料不存在或已删除");
    }
    throw error;
  }

  const profile = await prisma.crmCustomerProfile.findUnique({
    where: { id: profileId },
    select: {
      id: true,
      name: true,
      stage: true,
      importance: true,
      organization: true,
      principal: true,
      email: true,
      wechat: true,
      lastFollowUpAt: true,
      ownerUser: { select: { name: true } },
      interactions: {
        orderBy: { happenedAt: "desc" },
        take: 5,
        select: { id: true, type: true, summary: true, happenedAt: true },
      },
    },
  });
  if (!profile) {
    throw new NotFoundError("客户资料不存在或已删除");
  }

  return {
    profileId: profile.id,
    customerName: profile.name ?? "未命名客户",
    stage: profile.stage,
    importance: profile.importance,
    organization: profile.organization ?? "",
    principal: profile.principal ?? "",
    ownerName: profile.ownerUser?.name ?? "",
    email: profile.email ?? "",
    wechat: profile.wechat ?? "",
    lastInteractionAt: profile.lastFollowUpAt?.toISOString() ?? null,
    recentInteractions: profile.interactions.map((i) => ({
      id: i.id,
      type: i.type,
      summary: i.summary,
      happenedAt: i.happenedAt.toISOString(),
    })),
  };
}

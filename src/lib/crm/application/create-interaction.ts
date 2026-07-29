/**
 * Canonical actor-aware CRM interaction command (T5.3).
 *
 * Shared by Web `POST /api/crm/profiles/[id]/interactions` and Agent `crm.create_interaction`.
 */
import type { CrmInteraction } from "@prisma/client";
import type { BusinessActor, InvocationContext } from "@/lib/application/actor";
import {
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "@/lib/application/errors";
import { assertCrmRepSelfServiceAccess } from "@/lib/crm/application/crm-agent-access";
import {
  assertCrmProfileAccess,
  CrmAccessError,
  CrmAccessForbiddenError,
  CrmAccessNotFoundError,
  isRegionalManagerRole,
  isRepresentativeRole,
} from "@/lib/crm/permissions";
import { CRM_INTERACTION_TYPES, type CrmInteractionType } from "@/lib/crm/constants";
import { createCrmInteraction } from "@/lib/crm/services/interaction";

export type CreateInteractionInput = {
  profileId: string;
  type: string;
  summary: string;
  detail?: string | null;
  happenedAt: string | Date;
  nextActionAt?: string | Date | null;
  relatedProjectId?: string | null;
};

export type CreateInteractionResult = {
  interaction: CrmInteraction;
  customerName: string;
};

export const INTERACTION_TYPE_LABELS: Record<string, string> = {
  CALL: "电话",
  WECHAT: "微信",
  EMAIL: "邮件",
  MEETING: "会议",
  VISIT: "拜访",
  REFERRAL: "转介绍",
  NOTE: "备注",
};

function parseInteractionDate(value: string | Date, field: string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new ValidationError(`${field} 必须是有效日期`);
  }
  return date;
}

async function assertProfileAccessForInteraction(
  actor: BusinessActor,
  profileId: string,
): Promise<{ customerName: string }> {
  if (!isRepresentativeRole(actor.role) && !isRegionalManagerRole(actor.role)) {
    const { prisma } = await import("@/lib/prisma");
    const profile = await prisma.crmCustomerProfile.findUnique({
      where: { id: profileId },
      select: { id: true, name: true },
    });
    if (!profile) {
      throw new NotFoundError("Profile not found");
    }
    return { customerName: profile.name ?? "未命名客户" };
  }

  try {
    await assertCrmProfileAccess(profileId, actor.userId, actor.role);
  } catch (error) {
    if (error instanceof CrmAccessNotFoundError) {
      throw new NotFoundError("Profile not found");
    }
    if (error instanceof CrmAccessForbiddenError || error instanceof CrmAccessError) {
      throw new ForbiddenError();
    }
    throw error;
  }

  const { prisma } = await import("@/lib/prisma");
  const profile = await prisma.crmCustomerProfile.findUnique({
    where: { id: profileId },
    select: { id: true, name: true },
  });
  if (!profile) {
    throw new NotFoundError("Profile not found");
  }
  return { customerName: profile.name ?? "未命名客户" };
}

export function normalizeInteractionType(value: string): CrmInteractionType {
  if (!CRM_INTERACTION_TYPES.includes(value as CrmInteractionType)) {
    throw new ValidationError(`type must be one of: ${CRM_INTERACTION_TYPES.join(", ")}`);
  }
  return value as CrmInteractionType;
}

export async function createInteractionForActor(
  actor: BusinessActor,
  invocation: InvocationContext,
  input: CreateInteractionInput,
): Promise<CreateInteractionResult> {
  if (invocation.channel === "agent") {
    assertCrmRepSelfServiceAccess(actor);
  }

  const profileId = input.profileId?.trim();
  const summary = input.summary?.trim();
  if (!profileId || !input.type || !summary) {
    throw new ValidationError("profileId, type, and summary are required");
  }

  const type = normalizeInteractionType(input.type);
  const happenedAt = parseInteractionDate(input.happenedAt, "happenedAt");
  const nextActionAt =
    input.nextActionAt == null || input.nextActionAt === ""
      ? null
      : parseInteractionDate(input.nextActionAt, "nextActionAt");

  const { customerName } = await assertProfileAccessForInteraction(actor, profileId);

  try {
    const interaction = await createCrmInteraction({
      profileId,
      userId: actor.userId,
      type,
      summary,
      detail: input.detail,
      happenedAt,
      nextActionAt,
      relatedProjectId: input.relatedProjectId ?? null,
    });
    return { interaction, customerName };
  } catch (error) {
    const msg = error instanceof Error ? error.message : "创建失败";
    throw new ValidationError(msg);
  }
}

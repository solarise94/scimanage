/**
 * Shared CRM interaction service.
 *
 * Extracted from `src/app/api/crm/profiles/[id]/interactions/route.ts` POST so
 * that both the API route and the Agent action (`crm.create_interaction`) share
 * the same business logic.
 *
 * @see docs/agent-mobile-crm-genui-functional-design-2026-07-14.md §10.2
 */

import type { PrismaClient, Prisma, CrmInteraction } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { syncCrmLifecycleAfterInteraction } from "@/lib/crm/lifecycle";
import { interactionOperatorInclude } from "@/lib/crm/includes";
import { CRM_INTERACTION_TYPES } from "@/lib/crm/constants";

type DbClient = PrismaClient | Prisma.TransactionClient;

/**
 * Create a CRM interaction record and trigger lifecycle sync (best-effort).
 *
 * The lifecycle sync runs OUTSIDE the create transaction (best-effort), matching
 * the existing API route behavior.
 */
export async function createCrmInteraction(params: {
  profileId: string;
  userId: string;
  type: string;
  summary: string;
  detail?: string | null;
  happenedAt: Date;
  nextActionAt?: Date | null;
  relatedProjectId?: string | null;
  sourceType?: string;
  sourceId?: string;
  db?: DbClient;
}): Promise<CrmInteraction> {
  const db = params.db ?? prisma;

  // Validate type
  if (!CRM_INTERACTION_TYPES.includes(params.type as (typeof CRM_INTERACTION_TYPES)[number])) {
    throw new Error(`不支持的沟通类型: ${params.type}`);
  }
  if (!params.summary.trim()) {
    throw new Error("沟通摘要不能为空");
  }

  const interaction = await db.crmInteraction.create({
    data: {
      profileId: params.profileId,
      type: params.type,
      summary: params.summary.trim(),
      detail: params.detail || null,
      happenedAt: params.happenedAt,
      nextActionAt: params.nextActionAt ?? null,
      relatedProjectId: params.relatedProjectId || null,
      createdByUserId: params.userId,
      sourceType: params.sourceType ?? "MANUAL",
      sourceId: params.sourceId,
    },
    include: interactionOperatorInclude,
  });

  // Best-effort lifecycle sync (not awaited inside transaction)
  try {
    await syncCrmLifecycleAfterInteraction(params.profileId, {
      happenedAt: interaction.happenedAt,
      nextActionAt: interaction.nextActionAt,
      actorUserId: params.userId,
    });
  } catch (error) {
    console.error(`[CRM][INTERACTION] lifecycle sync failed for profile ${params.profileId}:`, error);
  }

  return interaction;
}

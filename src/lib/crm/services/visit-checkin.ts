/**
 * Shared visit-checkin service.
 *
 * Extracted from `src/app/api/crm/profiles/[id]/checkins/` routes so that both
 * the API routes and the Agent action (`crm.create_visit_checkin`) share the
 * same business logic for DRAFT creation and atomic COMPLETED transition.
 *
 * @see docs/agent-mobile-crm-genui-functional-design-2026-07-14.md §7.1, §10.2, §15.3
 */

import type { Prisma, PrismaClient, CrmVisitCheckin, CrmInteraction } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { validateCheckinVoiceUrl } from "@/lib/crm/media";
import { transitionCrmStage } from "@/lib/crm/lifecycle";

type DbClient = PrismaClient | Prisma.TransactionClient;

const CHECKIN_INCLUDE = {
  media: true,
  user: { select: { id: true, name: true } },
} as const;

/**
 * Create a DRAFT checkin.  Does NOT create an interaction or trigger lifecycle.
 * The caller is responsible for calling `completeVisitCheckin` afterwards.
 */
export async function createCheckinDraft(params: {
  profileId: string;
  userId: string;
  lat?: number | null;
  lng?: number | null;
  accuracy?: number | null;
  addressSnapshot?: string | null;
  mapProvider?: string | null;
  db?: DbClient;
}): Promise<CrmVisitCheckin> {
  const db = params.db ?? prisma;
  return db.crmVisitCheckin.create({
    data: {
      profileId: params.profileId,
      userId: params.userId,
      lat: params.lat ?? null,
      lng: params.lng ?? null,
      accuracy: params.accuracy ?? null,
      addressSnapshot: params.addressSnapshot ?? null,
      mapProvider: params.mapProvider ?? null,
      status: "DRAFT",
    },
    include: CHECKIN_INCLUDE,
  });
}

/**
 * Check whether a checkin has sufficient evidence to be completed.
 * Requires at least one of: geo, photo, or valid voice.
 */
export function hasCheckinEvidence(checkin: {
  lat: number | null;
  lng: number | null;
  media: Array<{ url: string }>;
  voiceUrl: string | null;
  id: string;
}, additionalVoiceUrl?: string): boolean {
  const hasGeo = checkin.lat != null && checkin.lng != null;
  const hasPhoto = checkin.media.length > 0;
  const hasValidVoice = !!(
    additionalVoiceUrl ||
    (checkin.voiceUrl && validateCheckinVoiceUrl(checkin.voiceUrl, checkin.id))
  );
  return hasGeo || hasPhoto || hasValidVoice;
}

/**
 * Atomically complete a DRAFT checkin.
 *
 * Uses `updateMany({ where: { id, status: "DRAFT", ... } })` to claim the
 * completion right - only one concurrent request can succeed.  On success,
 * creates a VISIT interaction (attributed to the original checkin creator, not
 * the completer), back-links the interactionId, and triggers CRM lifecycle
 * stage transition.
 *
 * Object-level permission: when `expectedProfileId` and `expectedUserId` are
 * provided, the atomic claim includes them in the WHERE clause, ensuring only
 * the checkin's original creator (or ADMIN) can complete it, and only for the
 * expected profile.  ADMIN can pass `allowAdminOverride: true` to bypass the
 * userId check while still enforcing profileId.
 *
 * Returns `{ alreadyCompleted: true }` if another request already completed it
 * (idempotent - no duplicate interaction is created).
 */
export async function completeVisitCheckin(params: {
  checkinId: string;
  voiceUrl?: string;
  expectedProfileId?: string;
  expectedUserId?: string;
  allowAdminOverride?: boolean;
  db?: DbClient;
}): Promise<{
  checkin: CrmVisitCheckin;
  interaction: CrmInteraction | null;
  alreadyCompleted: boolean;
}> {
  const db = params.db ?? prisma;

  // Load the checkin with media for evidence validation
  const checkin = await db.crmVisitCheckin.findUnique({
    where: { id: params.checkinId },
    include: { media: true },
  });
  if (!checkin) {
    throw new Error("Checkin not found");
  }

  // Object-level permission: verify the checkin belongs to the expected profile
  // and was created by the expected user (unless admin override).
  if (params.expectedProfileId && checkin.profileId !== params.expectedProfileId) {
    throw new Error("FORBIDDEN");
  }
  if (params.expectedUserId && !params.allowAdminOverride && checkin.userId !== params.expectedUserId) {
    throw new Error("FORBIDDEN");
  }

  // Idempotency: already completed
  if (checkin.status === "COMPLETED") {
    const completed = await db.crmVisitCheckin.findUnique({
      where: { id: params.checkinId },
      include: CHECKIN_INCLUDE,
    });
    return { checkin: completed!, interaction: null, alreadyCompleted: true };
  }

  // Evidence validation
  if (!hasCheckinEvidence(checkin, params.voiceUrl)) {
    throw new Error("完成签到需要定位成功、至少上传1张照片或上传录音");
  }

  // Build update data
  const updateData: Prisma.CrmVisitCheckinUpdateInput = {};
  if (params.voiceUrl) {
    updateData.voiceUrl = params.voiceUrl;
    if (!checkin.voiceUrl && checkin.asrStatus === "NONE") {
      updateData.asrStatus = "UPLOADED";
    }
  }

  const now = new Date();

  // Build the atomic claim WHERE clause with object-level guards
  const claimWhere: Prisma.CrmVisitCheckinWhereInput = {
    id: params.checkinId,
    status: "DRAFT",
  };
  if (params.expectedProfileId) {
    claimWhere.profileId = params.expectedProfileId;
  }
  if (params.expectedUserId && !params.allowAdminOverride) {
    claimWhere.userId = params.expectedUserId;
  }

  // Always use the top-level prisma client for $transaction - TransactionClient
  // does not support nested transactions.
  const result = await prisma.$transaction(async (tx) => {
    // Atomic DRAFT -> COMPLETED claim. Only one concurrent request wins.
    // Includes profileId/userId in WHERE for object-level permission enforcement.
    const claimed = await tx.crmVisitCheckin.updateMany({
      where: claimWhere,
      data: {
        ...updateData,
        status: "COMPLETED",
        completedAt: now,
      },
    });

    if (claimed.count === 0) {
      // Another request completed it concurrently
      const current = await tx.crmVisitCheckin.findUnique({
        where: { id: params.checkinId },
        include: CHECKIN_INCLUDE,
      });
      return { checkin: current!, interaction: null as CrmInteraction | null, alreadyCompleted: true };
    }

    // Create the VISIT interaction attributed to the original checkin creator
    const interaction = await tx.crmInteraction.create({
      data: {
        profileId: checkin.profileId,
        type: "VISIT",
        summary: checkin.addressSnapshot ? `拜访签到: ${checkin.addressSnapshot}` : "拜访签到",
        // 签到事实归属原始签到人；管理员代为提交完成不改变行为人。
        createdByUserId: checkin.userId,
        happenedAt: now,
        sourceType: "CHECKIN",
        sourceId: params.checkinId,
      },
    });

    // Back-link interaction to checkin
    await tx.crmVisitCheckin.update({
      where: { id: params.checkinId },
      data: { interactionId: interaction.id },
    });

    // Trigger lifecycle stage transition (inside the transaction)
    await transitionCrmStage(
      checkin.profileId,
      { type: "CHECKIN", happenedAt: now, checkinId: params.checkinId },
      tx,
    );

    const completed = await tx.crmVisitCheckin.findUnique({
      where: { id: params.checkinId },
      include: CHECKIN_INCLUDE,
    });

    return { checkin: completed!, interaction, alreadyCompleted: false };
  });

  return result;
}

/**
 * Convenience: create a DRAFT and immediately complete it in one call.
 * Used by the Agent action `crm.create_visit_checkin` when the user has
 * already obtained location evidence and wants a one-step save.
 */
export async function createAndCompleteCheckin(params: {
  profileId: string;
  userId: string;
  lat: number;
  lng: number;
  accuracy?: number | null;
  addressSnapshot?: string | null;
  mapProvider?: string | null;
}): Promise<{ checkin: CrmVisitCheckin; interaction: CrmInteraction | null; alreadyCompleted: boolean }> {
  const draft = await createCheckinDraft({
    profileId: params.profileId,
    userId: params.userId,
    lat: params.lat,
    lng: params.lng,
    accuracy: params.accuracy,
    addressSnapshot: params.addressSnapshot,
    mapProvider: params.mapProvider,
  });

  return completeVisitCheckin({ checkinId: draft.id });
}

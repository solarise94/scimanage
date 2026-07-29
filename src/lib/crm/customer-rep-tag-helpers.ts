/**
 * Retire every other representative's active MANAGING tag on a profile to
 * FOLLOWED history (ownership transfer semantics), leaving `exceptRepId`'s tag
 * untouched. Mirrors the pattern used by customer-pool/assign, recall, and
 * representative archive. Safe to call when there are no other MANAGING tags.
 *
 * Phase E contract：参数 / 查询 / 写入只认 profileId（Customer 锚点列已删除）。
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

type DbLike = typeof prisma | Prisma.TransactionClient;

export async function retireOtherManagingTags(
  db: DbLike,
  params: {
    profileId: string;
    exceptRepId: string;
    now: Date;
    actingUserId: string;
    note: string;
  },
): Promise<void> {
  const { profileId, exceptRepId, now, actingUserId, note } = params;

  const priorManaging = await db.customerRepTag.findMany({
    where: {
      profileId,
      tagType: "MANAGING",
      isActive: true,
      representativeId: { not: exceptRepId },
    },
    select: { id: true, representativeId: true, startedAt: true },
  });

  for (const t of priorManaging) {
    await db.customerRepTag.upsert({
      where: {
        profileId_representativeId_tagType: {
          profileId,
          representativeId: t.representativeId,
          tagType: "FOLLOWED",
        },
      },
      create: {
        profileId,
        representativeId: t.representativeId,
        tagType: "FOLLOWED",
        isActive: false,
        isPrimary: false,
        startedAt: t.startedAt,
        endedAt: now,
        source: "HANDOVER",
        note,
        createdByUserId: actingUserId,
      },
      update: { endedAt: now },
    });
  }

  if (priorManaging.length > 0) {
    await db.customerRepTag.updateMany({
      where: { id: { in: priorManaging.map((t) => t.id) } },
      data: { isActive: false, endedAt: now, isPrimary: false },
    });
  }
}

/**
 * Upsert a representative's MANAGING tag as the active primary on a profile.
 */
export async function upsertManagingTag(
  db: DbLike,
  params: {
    profileId: string;
    representativeId: string;
    now: Date;
    actingUserId: string;
    source?: string;
  },
): Promise<void> {
  const { profileId, representativeId, now, actingUserId, source = "MANUAL" } = params;

  await db.customerRepTag.upsert({
    where: {
      profileId_representativeId_tagType: {
        profileId,
        representativeId,
        tagType: "MANAGING",
      },
    },
    create: {
      profileId,
      representativeId,
      tagType: "MANAGING",
      isActive: true,
      isPrimary: true,
      source,
      createdByUserId: actingUserId,
    },
    update: {
      isActive: true,
      isPrimary: true,
      endedAt: null,
      startedAt: now,
    },
  });
}

/**
 * Retire a specific representative's active MANAGING tag on a profile to
 * FOLLOWED history.
 */
export async function retireManagingTag(
  db: DbLike,
  params: {
    profileId: string;
    representativeId: string;
    now: Date;
    actingUserId: string;
    note: string;
  },
): Promise<void> {
  const { profileId, representativeId, now, actingUserId, note } = params;

  const managing = await db.customerRepTag.findFirst({
    where: {
      profileId,
      representativeId,
      tagType: "MANAGING",
      isActive: true,
    },
    select: { id: true, startedAt: true },
  });

  if (!managing) return;

  await db.customerRepTag.upsert({
    where: {
      profileId_representativeId_tagType: {
        profileId,
        representativeId,
        tagType: "FOLLOWED",
      },
    },
    create: {
      profileId,
      representativeId,
      tagType: "FOLLOWED",
      isActive: false,
      isPrimary: false,
      startedAt: managing.startedAt,
      endedAt: now,
      source: "HANDOVER",
      note,
      createdByUserId: actingUserId,
    },
    update: { endedAt: now },
  });

  await db.customerRepTag.update({
    where: { id: managing.id },
    data: { isActive: false, endedAt: now, isPrimary: false },
  });
}

/**
 * 显式负责人变更时同步 MANAGING tag，保证 scoped 可见性与 owner 一致。
 */
export async function syncManagingTagForProfileOwner(
  db: DbLike,
  params: {
    profileId: string;
    ownerUserId: string;
    actingUserId: string;
    note?: string;
  },
): Promise<void> {
  const ownerUser = await db.user.findUnique({
    where: { id: params.ownerUserId },
    select: { email: true },
  });
  const ownerRep = ownerUser?.email
    ? await db.representative.findUnique({
        where: { email: ownerUser.email, archived: false, kind: "HUMAN" },
        select: { id: true },
      })
    : null;
  if (!ownerRep) return;

  const now = new Date();
  await retireOtherManagingTags(db, {
    profileId: params.profileId,
    exceptRepId: ownerRep.id,
    now,
    actingUserId: params.actingUserId,
    note: params.note ?? "负责人变更：管理关系同步",
  });
  await upsertManagingTag(db, {
    profileId: params.profileId,
    representativeId: ownerRep.id,
    now,
    actingUserId: params.actingUserId,
  });
}

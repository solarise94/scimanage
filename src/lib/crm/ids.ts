import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/** Compact nullable ID arrays for APIs that take `string[]` ids. */
export function compactIds(ids: Array<string | null | undefined>): string[] {
  return [...new Set(ids.filter((id): id is string => Boolean(id)))];
}

type DbLike = typeof prisma | Prisma.TransactionClient;

export type ResolvedCustomerRef = {
  profileId: string;
};

/**
 * W5.1：只按 Profile.id 查找活动档案（未删除、未归档）。
 * 不接受遗留 Customer.id；找不到返回 null。
 */
export async function findActiveProfile(
  profileId: string | null | undefined,
  db: DbLike = prisma,
): Promise<ResolvedCustomerRef | null> {
  if (!profileId || typeof profileId !== "string" || !profileId.trim()) return null;
  const trimmed = profileId.trim();
  const profile = await db.crmCustomerProfile.findFirst({
    where: { id: trimmed, deleted: false, archived: false },
    select: { id: true },
  });
  if (!profile) return null;
  return {
    profileId: profile.id,
  };
}

/**
 * W5.1：写路径 fail-closed —— 仅接受活动 Profile.id。
 * @throws Error with message PROFILE_NOT_FOUND when missing
 */
export async function requireActiveProfileId(
  profileId: string | null | undefined,
  db: DbLike = prisma,
): Promise<ResolvedCustomerRef> {
  const ref = await findActiveProfile(profileId, db);
  if (!ref) {
    throw new Error("PROFILE_NOT_FOUND");
  }
  return ref;
}

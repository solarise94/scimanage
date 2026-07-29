/**
 * 中立的 user ↔ Representative bridge 与 RM scope helper（W6.9.1）。
 *
 * 从 customer-visibility 抽出，解除：
 *   customer-effective-representative →（动态）customer-visibility → customer-effective-representative
 * 的循环依赖。本文件不得 import resolver / visibility / permissions。
 *
 * 依赖方向：
 *   representative-scope ← visibility / permissions / effective-representative / owner-representative
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

type DbLike = typeof prisma | Prisma.TransactionClient;

const SALES_USER_ROLES = ["REPRESENTATIVE", "REGIONAL_MANAGER"] as const;

/**
 * Resolve the set of userIds a regional manager can see in CRM.
 * Returns null if the manager has no assigned representatives.
 */
export async function getRegionalManagerUserIds(
  managerUserId: string,
  db: DbLike = prisma,
): Promise<string[] | null> {
  const manager = await db.crmRegionManager.findUnique({
    where: { userId: managerUserId, archived: false },
    include: {
      reps: {
        include: {
          representative: { select: { email: true } },
        },
      },
    },
  });
  if (!manager || manager.reps.length === 0) return null;

  const emails = manager.reps.map((r) => r.representative.email);
  const repUsers = await db.user.findMany({
    where: { email: { in: emails }, role: { in: [...SALES_USER_ROLES] } },
    select: { id: true },
  });
  return repUsers.map((u) => u.id);
}

export async function getManagedRepresentativeIds(
  managerUserId: string,
  db: DbLike = prisma,
): Promise<string[]> {
  const manager = await db.crmRegionManager.findUnique({
    where: { userId: managerUserId, archived: false },
    select: {
      reps: {
        select: { representativeId: true },
      },
    },
  });
  if (!manager) return [];
  return manager.reps.map((link) => link.representativeId);
}

export async function getRepresentativeIdByUserEmail(
  email: string | null | undefined,
  db: DbLike = prisma,
): Promise<string | null> {
  if (!email) return null;
  const rep = await db.representative.findUnique({
    where: { email },
    select: { id: true },
  });
  return rep?.id ?? null;
}

/**
 * 允许的 owner user id 集合（自己 / RM 时含下辖）。
 */
export async function getAllowedOwnerIds(
  userId: string,
  role: string,
  db: DbLike = prisma,
): Promise<string[]> {
  if (role === "REPRESENTATIVE") return [userId];
  if (role === "REGIONAL_MANAGER") {
    const repUserIds = await getRegionalManagerUserIds(userId, db);
    return repUserIds && repUserIds.length > 0 ? [userId, ...repUserIds] : [userId];
  }
  return [];
}

/**
 * user(s) → repId 映射（email 桥接）。
 * 有效代表口径：
 *   Representative.archived === false && Representative.kind === "HUMAN"
 *   && Representative.email → User.email 命中 && User.role ∈ {REPRESENTATIVE, REGIONAL_MANAGER}
 */
export async function resolveRepIdsByUserIds(
  userIds: string[],
  db: DbLike = prisma,
): Promise<Map<string, string>> {
  if (userIds.length === 0) return new Map();
  const users = await db.user.findMany({
    where: { id: { in: userIds }, role: { in: [...SALES_USER_ROLES] } },
    select: { id: true, email: true },
  });
  const reps = await db.representative.findMany({
    where: {
      email: { in: users.map((u) => u.email).filter(Boolean) as string[] },
      archived: false,
      kind: "HUMAN",
    },
    select: { id: true, email: true },
  });
  const emailToRepId = new Map(reps.map((r) => [r.email, r.id]));
  const userToRep = new Map<string, string>();
  for (const u of users) {
    const repId = emailToRepId.get(u.email);
    if (repId) userToRep.set(u.id, repId);
  }
  return userToRep;
}

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { resolveRepIdsByUserIds } from "@/lib/crm/representative-scope";

type DbLike = typeof prisma | Prisma.TransactionClient;

const SALES_USER_ROLES = new Set(["REPRESENTATIVE", "REGIONAL_MANAGER"]);

export async function resolveRepresentativeForOwnerUser(
  ownerUser: { email: string | null; role: string } | null | undefined,
  db: DbLike = prisma,
): Promise<{ representativeId: string | null; representativeName: string | null }> {
  if (!ownerUser?.email) return { representativeId: null, representativeName: null };
  if (!SALES_USER_ROLES.has(ownerUser.role)) {
    return { representativeId: null, representativeName: null };
  }

  const rep = await db.representative.findFirst({
    where: { email: ownerUser.email, archived: false },
    select: { id: true, name: true },
  });

  if (!rep) return { representativeId: null, representativeName: null };

  return { representativeId: rep.id, representativeName: rep.name };
}

export async function resolveRepresentativeForOwnerUserId(
  ownerUserId: string | null | undefined,
  db: DbLike = prisma,
): Promise<{ representativeId: string | null; representativeName: string | null }> {
  if (!ownerUserId) return { representativeId: null, representativeName: null };

  const ownerUser = await db.user.findUnique({
    where: { id: ownerUserId },
    select: { email: true, role: true },
  });

  if (!ownerUser) return { representativeId: null, representativeName: null };

  return resolveRepresentativeForOwnerUser(ownerUser, db);
}

/** 批量解析 ownerUserId → representative，避免列表 N+1。 */
export async function resolveRepresentativesForOwnerUserIds(
  ownerUserIds: string[],
  db: DbLike = prisma,
): Promise<Map<string, { representativeId: string | null; representativeName: string | null }>> {
  const uniqueOwnerIds = [...new Set(ownerUserIds.filter(Boolean))];
  const userToRep = await resolveRepIdsByUserIds(uniqueOwnerIds, db);
  const repIds = [...new Set(userToRep.values())];
  const reps = repIds.length > 0
    ? await db.representative.findMany({
        where: { id: { in: repIds }, archived: false },
        select: { id: true, name: true },
      })
    : [];
  const repNameById = new Map(reps.map((r) => [r.id, r.name]));

  const result = new Map<string, { representativeId: string | null; representativeName: string | null }>();
  for (const ownerId of ownerUserIds) {
    const repId = userToRep.get(ownerId) ?? null;
    result.set(ownerId, {
      representativeId: repId,
      representativeName: repId ? (repNameById.get(repId) ?? null) : null,
    });
  }
  return result;
}

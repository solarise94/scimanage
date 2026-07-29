/**
 * T3.5 — actor-scoped active project rows for hot-projects aggregation.
 *
 * Keeps `project` Prisma access out of agent-runtime; hot-projects applies
 * activity signals, sorting and limit on top of these candidates.
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { BusinessActor } from "@/lib/application/actor";
import { getReadableProjectIds } from "@/lib/permissions";

/** Active project statuses considered for hot-project prompts. */
export const HOT_PROJECT_ACTIVE_STATUSES = ["NOT_STARTED", "IN_PROGRESS"] as const;

/** ADMIN candidate pool size — recent active top-N, not full table scan. */
export const HOT_PROJECT_ADMIN_CANDIDATE_POOL = 200;

/** Scope chunk size for non-ADMIN readable id lists (SQLite param limit). */
export const HOT_PROJECT_SCOPE_CHUNK_SIZE = 500;

export const HOT_PROJECT_CANDIDATE_SELECT = {
  id: true,
  name: true,
  projectNo: true,
  status: true,
  representative: true,
  profileId: true,
  profile: { select: { name: true, organization: true } },
  updatedAt: true,
} satisfies Prisma.ProjectSelect;

export type HotProjectCandidateRow = Prisma.ProjectGetPayload<{
  select: typeof HOT_PROJECT_CANDIDATE_SELECT;
}>;

export type ListHotProjectCandidatesOpts = {
  adminCandidatePool?: number;
  scopeChunkSize?: number;
};

/**
 * List active, non-archived, non-deleted projects visible to the actor.
 * Does not sort or limit — caller ranks and slices (hot-projects layer).
 */
export async function listHotProjectCandidatesForActor(
  actor: BusinessActor,
  opts: ListHotProjectCandidatesOpts = {},
): Promise<HotProjectCandidateRow[]> {
  const adminPool = opts.adminCandidatePool ?? HOT_PROJECT_ADMIN_CANDIDATE_POOL;
  const chunkSize = opts.scopeChunkSize ?? HOT_PROJECT_SCOPE_CHUNK_SIZE;
  const baseWhere: Prisma.ProjectWhereInput = {
    status: { in: [...HOT_PROJECT_ACTIVE_STATUSES] },
    archived: false,
    deleted: false,
    // Phase 0 review #5：Agent 热门项目候选排除治理桶（PRJ-OTHER 等），
    // 否则治理桶默认 NOT_STARTED 会进入管理员候选。
    systemType: "NORMAL",
  };

  const scopeIds = await getReadableProjectIds(actor.userId, actor.role);

  if (scopeIds !== null) {
    if (scopeIds.length === 0) return [];

    const rows: HotProjectCandidateRow[] = [];
    for (let i = 0; i < scopeIds.length; i += chunkSize) {
      const chunk = scopeIds.slice(i, i + chunkSize);
      const part = await prisma.project.findMany({
        where: { ...baseWhere, id: { in: chunk } },
        select: HOT_PROJECT_CANDIDATE_SELECT,
      });
      rows.push(...part);
    }
    return rows;
  }

  return prisma.project.findMany({
    where: baseWhere,
    orderBy: { updatedAt: "desc" },
    take: adminPool,
    select: HOT_PROJECT_CANDIDATE_SELECT,
  });
}

/**
 * T2.6 — order↔project link activity signals for hot-projects aggregation.
 *
 * Keeps `orderProjectLink` Prisma access out of agent-runtime; hot-projects
 * only consumes this helper for the order-link half of last-activity.
 */
import { prisma } from "@/lib/prisma";

/**
 * For each projectId, return the max `OrderProjectLink.updatedAt`.
 * Projects with no links are omitted from the map.
 */
export async function maxOrderProjectLinkUpdatedAtByProjectIds(
  projectIds: string[],
): Promise<Map<string, Date>> {
  const map = new Map<string, Date>();
  if (projectIds.length === 0) return map;

  const rows = await prisma.orderProjectLink.groupBy({
    by: ["projectId"],
    where: { projectId: { in: projectIds } },
    _max: { updatedAt: true },
  });
  for (const r of rows) {
    if (r._max.updatedAt) map.set(r.projectId, r._max.updatedAt);
  }
  return map;
}

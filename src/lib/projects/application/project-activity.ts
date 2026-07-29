/**
 * T3.5 — project activity signals for hot-projects aggregation.
 *
 * Keeps `activityLog` Prisma access out of agent-runtime. Ticket aggregation
 * remains in hot-projects until T4 ticket query service exists.
 */
import { prisma } from "@/lib/prisma";

/**
 * For each projectId, return the max `ActivityLog.createdAt` within `since`.
 * Projects with no matching logs are omitted from the map.
 */
export async function maxActivityLogUpdatedAtByProjectIds(
  projectIds: string[],
  since: Date,
): Promise<Map<string, Date>> {
  const map = new Map<string, Date>();
  if (projectIds.length === 0) return map;

  const rows = await prisma.activityLog.groupBy({
    by: ["projectId"],
    where: { projectId: { in: projectIds }, createdAt: { gte: since } },
    _max: { createdAt: true },
  });
  for (const r of rows) {
    if (r.projectId && r._max.createdAt) map.set(r.projectId, r._max.createdAt);
  }
  return map;
}

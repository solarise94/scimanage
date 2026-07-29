/**
 * T4.4 — ticket activity signals for hot-projects aggregation.
 *
 * Keeps `ticket` Prisma groupBy out of agent-runtime.
 */
import { prisma } from "@/lib/prisma";

/**
 * For each projectId, return the max `Ticket.updatedAt`.
 * Projects with no tickets are omitted from the map.
 */
export async function maxTicketUpdatedAtByProjectIds(
  projectIds: string[],
): Promise<Map<string, Date>> {
  const map = new Map<string, Date>();
  if (projectIds.length === 0) return map;

  const rows = await prisma.ticket.groupBy({
    by: ["projectId"],
    where: { projectId: { in: projectIds } },
    _max: { updatedAt: true },
  });
  for (const row of rows) {
    if (row.projectId && row._max.updatedAt) {
      map.set(row.projectId, row._max.updatedAt);
    }
  }
  return map;
}

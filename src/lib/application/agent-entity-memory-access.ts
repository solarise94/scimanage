import { getReadableProjectIds } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";

type EntityMemoryRef = {
  entityType: string;
  entityId: string;
  metadataJson?: string | null;
};

function containsInternalProjectNotes(memory: EntityMemoryRef): boolean {
  if (!memory.metadataJson) return false;
  try {
    const metadata = JSON.parse(memory.metadataJson) as {
      containsInternalProjectNotes?: unknown;
    };
    return metadata.containsInternalProjectNotes === true;
  } catch {
    return false;
  }
}

/**
 * Re-check project scope before stale entity-memory snapshots are injected or
 * returned. Non-project memories keep their existing domain-specific scope.
 *
 * Permission lookup failures fail closed for project memories so an optional
 * memory feature cannot become an authorization bypass.
 */
export async function filterEntityMemoriesForActor<T extends EntityMemoryRef>(
  actor: { userId: string; role: string },
  memories: T[],
): Promise<T[]> {
  if (!memories.some((memory) => memory.entityType === "project")) {
    return memories;
  }

  try {
    const readableProjectIds = await getReadableProjectIds(actor.userId, actor.role);
    const readable = readableProjectIds === null
      ? null
      : new Set(readableProjectIds);
    const canViewInternalProjectNotes =
      actor.role === "ADMIN" || actor.role === "USER";

    return memories.filter((memory) => {
      if (memory.entityType !== "project") return true;
      if (readable && !readable.has(memory.entityId)) return false;
      if (
        !canViewInternalProjectNotes
        && containsInternalProjectNotes(memory)
      ) {
        return false;
      }
      return true;
    });
  } catch (error) {
    console.error(
      "entity memory project permission re-check failed:",
      error instanceof Error ? error.message : error,
    );
    return memories.filter((memory) => memory.entityType !== "project");
  }
}

export async function listActiveEntityMemoriesForActor(
  actor: { userId: string; role: string },
  limit = 15,
) {
  const memories = await prisma.agentEntityMemory.findMany({
    where: { userId: actor.userId, status: "ACTIVE" },
    orderBy: { activityScore: "desc" },
    take: Math.max(1, Math.min(30, Math.floor(limit))),
    select: {
      entityType: true,
      entityId: true,
      name: true,
      summary: true,
      lastActiveAt: true,
      metadataJson: true,
    },
  });

  return filterEntityMemoriesForActor(actor, memories);
}

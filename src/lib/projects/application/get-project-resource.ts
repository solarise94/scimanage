/**
 * Lightweight project resource location fields for Agent resource resolver (T3.5).
 *
 * Same scope/deleted口径 as detail/summary; out-of-scope and missing both raise
 * NotFoundError (§2.3 — no existence leak).
 */
import { prisma } from "@/lib/prisma";
import type { BusinessActor } from "@/lib/application/actor";
import { NotFoundError } from "@/lib/application/errors";
import { canReadProject } from "@/lib/permissions";

export async function getProjectResourceForActor(
  actor: BusinessActor,
  projectId: string,
): Promise<{ id: string; name: string }> {
  const readable = await canReadProject(projectId, actor.userId, actor.role);
  if (!readable) {
    throw new NotFoundError(`找不到项目「${projectId}」，或没有查看权限`);
  }

  const project = await prisma.project.findFirst({
    where: { id: projectId, deleted: false },
    select: { id: true, name: true },
  });
  if (!project) {
    throw new NotFoundError(`找不到项目「${projectId}」，或没有查看权限`);
  }

  return { id: project.id, name: project.name };
}

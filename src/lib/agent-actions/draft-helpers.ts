import { assertProjectContextReadable, getRepresentativeProjectIds, isRepresentative } from "@/lib/permissions";
import { buildProjectPluginContext } from "@/lib/plugins/context";
import { getPlugin } from "@/lib/plugins/registry";
import type { FormDraftPlugin, FormDraftResult, PluginActor, ProjectPluginContext } from "@/lib/plugins/types";
import { AgentActionForbiddenError, AgentActionInputError } from "./errors";
import type { BusinessActor } from "@/lib/application/actor";

export function toPluginActor(actor: BusinessActor): PluginActor {
  return {
    id: actor.userId,
    name: actor.name || "",
    email: actor.email || "",
    role: actor.role,
  };
}

export async function getScopedProjectDraftContext(
  actor: BusinessActor,
  projectId?: string,
): Promise<ProjectPluginContext | undefined> {
  if (!projectId) return undefined;

  if (isRepresentative(actor.role)) {
    const repProjectIds = await getRepresentativeProjectIds(actor.userId);
    if (!repProjectIds.includes(projectId)) {
      throw new AgentActionForbiddenError();
    }
    return undefined;
  }

  try {
    await assertProjectContextReadable(projectId, actor.userId, actor.role);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message === "NOT_FOUND") {
      throw new AgentActionInputError("项目不存在");
    }
    throw new AgentActionForbiddenError();
  }

  return buildProjectPluginContext(projectId);
}

export async function runProjectAutoDraft(
  actor: BusinessActor,
  formKey: string,
  text: string,
  projectId?: string,
): Promise<FormDraftResult> {
  const plugin = await getPlugin("project.auto-draft");
  if (!plugin || plugin.manifest.capability !== "form-draft") {
    throw new AgentActionInputError("project.auto-draft 插件不可用");
  }

  const projectCtx = await getScopedProjectDraftContext(actor, projectId);
  return (plugin as FormDraftPlugin).execute(
    text,
    toPluginActor(actor),
    formKey,
    projectCtx,
  );
}

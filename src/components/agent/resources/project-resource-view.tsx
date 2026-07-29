"use client";

/**
 * ProjectResourceView — embedded project detail for the Agent workspace.
 *
 * Mirrors {@link OrderResourceView}: a thin wrapper around the shared
 * {@link ProjectDetailView} (the same body the `/projects/[id]` page uses),
 * mounted inside a {@link ResourceNavigationEmbeddedProvider} so internal
 * links (ticket / order / customer / finance workbench) push onto the Agent
 * resource history instead of leaving the workspace.
 *
 * Data is loaded by `ProjectDetailView` via TanStack Query keyed at
 * `["project", entityId]`, `["timeline", entityId]`, `["tickets", entityId]`
 * and `["procurement-channels"]` — all shared with the standalone page, so
 * opening the resource after viewing the page is instant and mutations on
 * either side refresh both.
 *
 * reloadToken (panel/sheet header "refresh") imperatively invalidates the
 * project's detail/timeline/tickets keys via a consumedRef so a history
 * back/forward remount doesn't fire a duplicate request.
 */

import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ProjectDetailView } from "@/components/projects/project-detail-view";
import {
  ResourceNavigationEmbeddedProvider,
  type ResourceViewMode,
} from "../resource-navigation-context";
import type {
  AgentResourceLocation,
  AgentResourceRequest,
} from "@/lib/agent-resources/types";

function ProjectResourceViewInner({
  location,
  mode,
  reloadToken,
}: {
  location: AgentResourceLocation;
  mode: ResourceViewMode;
  reloadToken: number;
}) {
  const projectId = location.entityId;
  const queryClient = useQueryClient();

  // reloadToken bumps when the user hits "refresh" in the panel header.
  // Imperatively invalidate (don't put the token in the queryKey — that would
  // break cache sharing with the standalone page). Track the consumed token so
  // a history back/forward remount doesn't fire a duplicate request.
  const consumedReloadTokenRef = useRef(reloadToken);
  useEffect(() => {
    if (reloadToken === consumedReloadTokenRef.current) return;
    consumedReloadTokenRef.current = reloadToken;
    void queryClient.invalidateQueries({ queryKey: ["project", projectId] });
    void queryClient.invalidateQueries({ queryKey: ["timeline", projectId] });
    void queryClient.invalidateQueries({ queryKey: ["tickets", projectId] });
  }, [reloadToken, queryClient, projectId]);

  return <ProjectDetailView projectId={projectId} mode={mode} />;
}

/**
 * Public entry: wraps the inner view with the embedded resource navigation
 * provider so ticket/order/customer links and the post-delete navigation
 * push onto the Agent resource history instead of leaving the workspace.
 */
export function ProjectResourceView({
  location,
  mode,
  reloadToken,
  onOpenResource,
}: {
  location: AgentResourceLocation;
  mode: ResourceViewMode;
  reloadToken: number;
  onOpenResource: (request: AgentResourceRequest) => void;
}) {
  // This View is always rendered inside a Panel or Sheet (embedded).
  const embeddedMode: "panel" | "sheet" = mode === "panel" ? "panel" : "sheet";
  return (
    <ResourceNavigationEmbeddedProvider mode={embeddedMode} onOpenResource={onOpenResource}>
      <ProjectResourceViewInner
        location={location}
        mode={mode}
        reloadToken={reloadToken}
      />
    </ResourceNavigationEmbeddedProvider>
  );
}

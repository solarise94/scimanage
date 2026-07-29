"use client";

/**
 * TicketResourceView — embedded ticket detail for the Agent workspace.
 *
 * Mirrors the CustomerResourceView pattern: a thin outer wrapper that installs
 * the embedded resource navigation provider, plus an inner component that
 * reuses the shared `TicketDetailView` and wires the panel/sheet reload token
 * to an imperative refetch of the shared `["ticket", entityId]` cache.
 *
 * Cache sharing: `TicketDetailView` uses the same `["ticket", entityId]`
 * queryKey as the standalone `/tickets/[id]` page, so opening the resource
 * after viewing the page is instant and mutations on either side refresh both.
 */

import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { TicketDetailView } from "@/components/tickets/ticket-detail-view";
import {
  ResourceNavigationEmbeddedProvider,
  type ResourceViewMode,
} from "../resource-navigation-context";
import type {
  AgentResourceLocation,
  AgentResourceRequest,
} from "@/lib/agent-resources/types";

function TicketResourceViewInner({
  location,
  mode,
  reloadToken,
}: {
  location: AgentResourceLocation;
  mode: ResourceViewMode;
  reloadToken: number;
}) {
  const ticketId = location.entityId;
  const queryClient = useQueryClient();

  // reloadToken bumps when the user hits "refresh" in the panel header. We
  // don't put it in the queryKey (that would break cache sharing with the
  // standalone page); instead we imperatively invalidate when it changes.
  // Track the consumed token so a history back/forward remount doesn't fire a
  // duplicate request.
  const consumedReloadTokenRef = useRef(reloadToken);
  useEffect(() => {
    if (reloadToken === consumedReloadTokenRef.current) return;
    consumedReloadTokenRef.current = reloadToken;
    void queryClient.invalidateQueries({ queryKey: ["ticket", ticketId] });
  }, [reloadToken, ticketId, queryClient]);

  return <TicketDetailView ticketId={ticketId} mode={mode} />;
}

/**
 * Public entry: wraps the inner view with the embedded resource navigation
 * provider so project links and the post-delete navigation push onto the
 * Agent resource history instead of leaving the workspace.
 */
export function TicketResourceView({
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
      <TicketResourceViewInner location={location} mode={mode} reloadToken={reloadToken} />
    </ResourceNavigationEmbeddedProvider>
  );
}

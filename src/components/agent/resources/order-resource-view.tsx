"use client";

/**
 * OrderResourceView — embedded order detail for the Agent workspace.
 *
 * Mirrors {@link CustomerResourceView}: a thin wrapper around the shared
 * {@link OrderDetailView} (the same body the `/orders?focus=` drawer uses),
 * mounted inside a {@link ResourceNavigationEmbeddedProvider} so internal
 * links (customer profile / project / finance workbench) push onto the Agent
 * resource history instead of leaving the workspace.
 *
 * Data is loaded by `OrderDetailView` via TanStack Query keyed at
 * `["order", entityId]` — shared with the standalone drawer and with
 * `OrderRevisionDialog`'s invalidation, so mutations on either side refresh
 * both.
 *
 * reloadToken (panel/sheet header "refresh") imperatively invalidates the same
 * key via a consumedRef so a history back/forward remount doesn't fire a
 * duplicate request.
 */

import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useSession } from "next-auth/react";
import { OrderDetailView } from "@/components/orders/order-detail-view";
import {
  ResourceNavigationEmbeddedProvider,
  type ResourceViewMode,
} from "../resource-navigation-context";
import type {
  AgentResourceLocation,
  AgentResourceRequest,
} from "@/lib/agent-resources/types";

function OrderResourceViewInner({
  location,
  mode,
  reloadToken,
}: {
  location: AgentResourceLocation;
  mode: ResourceViewMode;
  reloadToken: number;
}) {
  const orderId = location.entityId;
  const { data: session } = useSession();
  const role = session?.user?.role;
  const isAdmin = role === "ADMIN";
  const userId = session?.user?.id;
  const queryClient = useQueryClient();

  // reloadToken bumps when the user hits "refresh" in the panel header.
  // Imperatively invalidate (don't put the token in the queryKey — that would
  // break cache sharing with the standalone drawer). Track the consumed token
  // so a history back/forward remount (which already refetches via
  // refetchOnMount:"always" inside OrderDetailView) doesn't duplicate.
  const consumedReloadTokenRef = useRef(reloadToken);
  useEffect(() => {
    if (reloadToken === consumedReloadTokenRef.current) return;
    consumedReloadTokenRef.current = reloadToken;
    void queryClient.invalidateQueries({ queryKey: ["order", orderId] });
  }, [reloadToken, queryClient, orderId]);

  return (
    <OrderDetailView
      orderId={orderId}
      isAdmin={isAdmin}
      userId={userId}
      role={role}
      mode={mode === "panel" ? "panel" : "sheet"}
      onChanged={() => {
        // /orders list page uses hand-written fetch + useState, not TanStack
        // Query; there is no list query to invalidate. We still invalidate the
        // orders-related query subtrees so any other surface backed by TanStack
        // Query (e.g. finance/costs invoices pages) stays fresh.
        queryClient.invalidateQueries({ queryKey: ["orders"] });
        queryClient.invalidateQueries({ queryKey: ["order", orderId] });
      }}
    />
  );
}

/**
 * Public entry: wraps the inner view with the embedded resource navigation
 * provider so in-app links inside the View push onto the Agent resource
 * history.
 */
export function OrderResourceView({
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
      <OrderResourceViewInner
        location={location}
        mode={mode}
        reloadToken={reloadToken}
      />
    </ResourceNavigationEmbeddedProvider>
  );
}

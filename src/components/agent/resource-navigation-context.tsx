"use client";

/**
 * Resource navigation context.
 *
 * Embedded business Views (CustomerDetailView etc.) call
 * `useResourceNavigation()` to navigate between in-app resources.  In
 * `page` mode (standalone route) it delegates to the Next.js router; in
 * `panel` / `sheet` mode it pushes onto the Agent resource history so the
 * user stays inside the workspace.
 *
 * This lets a View share its full implementation between the standalone page
 * and the embedded container without branching on "am I in a panel?".
 */

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import type {
  AgentResourceEntityType,
  AgentResourceRequest,
} from "@/lib/agent-resources/types";

export type ResourceViewMode = "page" | "panel" | "sheet";

export interface ResourceNavigationHandlers {
  mode: ResourceViewMode;
  /** Navigate to an entity resource (preferred for in-app links). */
  onNavigateResource?: (entityType: AgentResourceEntityType, entityId: string, label?: string) => void;
  /** Navigate to an href (full-page links). */
  onNavigateHref?: (href: string) => void;
}

const ResourceNavigationContext = createContext<ResourceNavigationHandlers>({ mode: "page" });

/**
 * Page-mode provider: uses Next router for both entity and href navigation.
 * Used by standalone detail pages.
 */
export function ResourceNavigationPageProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const value = useMemo<ResourceNavigationHandlers>(
    () => ({
      mode: "page",
      onNavigateHref: (href) => router.push(href),
      // In page mode entity links also just push the canonical href; the
      // standalone page is the canonical destination anyway.
      onNavigateResource: (_entityType, entityId) => router.push(buildEntityHref(_entityType, entityId)),
    }),
    [router],
  );
  return (
    <ResourceNavigationContext.Provider value={value}>
      {children}
    </ResourceNavigationContext.Provider>
  );
}

/**
 * Embedded provider (panel/sheet): delegates to the Agent resource navigation
 * hook (push onto resource history instead of leaving the workspace).
 */
export function ResourceNavigationEmbeddedProvider({
  mode,
  onOpenResource,
  children,
}: {
  mode: Extract<ResourceViewMode, "panel" | "sheet">;
  onOpenResource: (request: AgentResourceRequest) => void;
  children: ReactNode;
}) {
  const value = useMemo<ResourceNavigationHandlers>(
    () => ({
      mode,
      onNavigateResource: (entityType, entityId, label) =>
        onOpenResource({ type: "entity", entityType, entityId, label }),
      onNavigateHref: (href) => onOpenResource({ type: "href", href }),
    }),
    [mode, onOpenResource],
  );
  return (
    <ResourceNavigationContext.Provider value={value}>
      {children}
    </ResourceNavigationContext.Provider>
  );
}

export function useResourceNavigation(): ResourceNavigationHandlers {
  return useContext(ResourceNavigationContext);
}

/** Client-side canonical href builder (mirrors server resolver routes). */
export function buildEntityHref(entityType: AgentResourceEntityType, entityId: string): string {
  switch (entityType) {
    case "customer": return `/crm/customers/${entityId}`;
    case "order": return `/orders?focus=${entityId}`;
    case "project": return `/projects/${entityId}`;
    case "ticket": return `/tickets/${entityId}`;
    case "invoice": return `/finance/invoices?invoiceId=${entityId}`;
  }
}

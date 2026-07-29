/**
 * Agent Resource types.
 *
 * A "resource" is a canonical, permission-checked business object (customer,
 * order, project, ticket, invoice) that the user can open *inside* the Agent
 * workspace — desktop right-hand Resource Panel or mobile full-screen Resource
 * Sheet — without leaving the conversation.
 *
 * Key contract: resources are resolved **server-side**.  The client only
 * decides the container (panel vs sheet).  The server returns a canonical
 * descriptor with the verified route, title and whether the entity can be
 * embedded.  The Resource View then loads its own data via the existing
 * business APIs and shares TanStack Query cache with the full pages.
 *
 * @see docs/agent-resource-panel-mobile-resource-view-upgrade-plan-2026-07-21.md
 */

/** Kinds of business resources the Agent workspace can embed. */
export type AgentResourceKind =
  | "crm_customer"
  | "order"
  | "project"
  | "ticket"
  | "invoice";

/** Entity type used in client-side resource requests and server resolution. */
export type AgentResourceEntityType =
  | "customer"
  | "order"
  | "project"
  | "ticket"
  | "invoice";

/**
 * Canonical resource location returned by the server resolver.
 *
 * The client never builds detail URLs itself — it sends an entity request and
 * receives this descriptor after the server has verified the entity exists and
 * the user can read it.
 */
export interface AgentResourceLocation {
  /** Stable unique key for React keys and history dedupe (e.g. `customer:<id>`). */
  key: string;
  kind: AgentResourceKind;
  entityType: AgentResourceEntityType;
  entityId: string;
  /** Canonical in-app href (e.g. `/crm/customers/<id>`, `/orders?focus=<id>`). */
  href: string;
  /** Human-readable title for the panel/sheet header. */
  title: string;
  /** Optional initial tab/sub-view (e.g. `interactions`). */
  initialTab?: string;
  /** Whether the server confirmed this entity has an embeddable View. */
  canEmbed: boolean;
}

/**
 * Client-side request to open a resource.
 *
 * GenUI cards send `type: "entity"` (preferred); Markdown links send
 * `type: "href"`.  The resolver normalizes both to an `AgentResourceLocation`.
 */
export type AgentResourceRequest =
  | {
      type: "entity";
      entityType: AgentResourceEntityType;
      entityId: string;
      label?: string;
      initialTab?: string;
    }
  | { type: "href"; href: string; label?: string };

/** Where the caller wants the resource to open. */
export type AgentResourceTarget = "workspace" | "page";

/** Resolve result: either an embeddable resource or a redirect to a full page. */
export type AgentResourceResolution =
  | { mode: "resource"; location: AgentResourceLocation }
  | { mode: "navigate"; href: string; label: string };

/** Shared shape returned by `POST /api/agent/resources/resolve`. */
export interface AgentResourceResolveResponse {
  ok: true;
  resolution: AgentResourceResolution;
}

/**
 * Server-side Agent Resource resolver.
 *
 * Single source of truth for canonical resource routes + object-level
 * permission checks.  Consumed by:
 *   - `POST /api/agent/resources/resolve` (GenUI / Markdown resource requests)
 *   - `POST /api/agent/view-intents/apply` (legacy `focus_entity` intents)
 *
 * The resolver only decides *whether* an entity is reachable and *what its
 * canonical href is*.  It never returns entity payload — the embedded View
 * loads its own data via the existing business APIs and shares the TanStack
 * Query cache with the full pages.
 */

import { findActiveProfile } from "@/lib/crm/ids";
import { getCustomerContextForActor } from "@/lib/crm/application/get-customer-context";
import { canReadFinance } from "@/lib/finance/permissions";
import { getInvoiceResourceForActor } from "@/lib/finance/application/query-invoice-detail";
import { isOrderAccessBlocked } from "@/lib/orders/permissions";
import { getOrderResourceForActor } from "@/lib/orders/application/get-order-detail";
import { getProjectResourceForActor } from "@/lib/projects/application/get-project-resource";
import { getTicketResourceForActor } from "@/lib/tickets/application/get-ticket-detail";
import {
  AgentActionForbiddenError,
  AgentActionInputError,
  AgentActionNotFoundError,
  mapDomainErrorToAgentError,
} from "@/lib/agent-actions/errors";
import type {
  AgentResourceEntityType,
  AgentResourceKind,
  AgentResourceLocation,
  AgentResourceResolution,
} from "./types";

/** Allowed entity types for resolve requests (runtime whitelist). */
export const AGENT_RESOURCE_ENTITY_TYPES = [
  "customer",
  "order",
  "project",
  "ticket",
  "invoice",
] as const satisfies readonly AgentResourceEntityType[];

export function isAgentResourceEntityType(value: string): value is AgentResourceEntityType {
  return (AGENT_RESOURCE_ENTITY_TYPES as readonly string[]).includes(value);
}

/** Kinds that currently have an embeddable Resource View on the client. */
const EMBEDDABLE_KINDS = new Set<AgentResourceKind>(["crm_customer", "order", "project", "ticket"]);

function kindForEntityType(entityType: AgentResourceEntityType): AgentResourceKind {
  switch (entityType) {
    case "customer": return "crm_customer";
    case "order": return "order";
    case "project": return "project";
    case "ticket": return "ticket";
    case "invoice": return "invoice";
  }
}

function buildLocation(
  entityType: AgentResourceEntityType,
  entityId: string,
  href: string,
  title: string,
  initialTab?: string,
): AgentResourceLocation {
  const kind = kindForEntityType(entityType);
  return {
    key: `${entityType}:${entityId}`,
    kind,
    entityType,
    entityId,
    href,
    title,
    initialTab,
    canEmbed: EMBEDDABLE_KINDS.has(kind),
  };
}

// ─── Per-entity resolvers ────────────────────────────────────────────────────

async function resolveCustomer(userId: string, role: string, entityId: string, initialTab?: string): Promise<AgentResourceLocation> {
  const ref = await findActiveProfile(entityId);
  if (!ref) {
    throw new AgentActionNotFoundError(entityId);
  }
  const actor = { userId, role, name: null, email: null };
  let customerName = "客户详情";
  try {
    const context = await getCustomerContextForActor(actor, ref.profileId);
    customerName = context.customerName?.trim() || "客户详情";
  } catch (e: unknown) {
    mapDomainErrorToAgentError(e, { resourceLabel: "客户资料" });
  }
  return buildLocation(
    "customer",
    ref.profileId,
    `/crm/customers/${ref.profileId}`,
    customerName,
    initialTab,
  );
}

async function resolveOrder(userId: string, role: string, entityId: string): Promise<AgentResourceLocation> {
  if (isOrderAccessBlocked(role)) {
    throw new AgentActionForbiddenError("Order access is blocked");
  }
  let order: { id: string; orderNo: string; title: string };
  try {
    order = await getOrderResourceForActor(
      { userId, role, name: null, email: null },
      entityId,
    );
  } catch (err) {
    mapDomainErrorToAgentError(err, { resourceLabel: "订单" });
  }
  return buildLocation(
    "order",
    order.id,
    `/orders?focus=${order.id}`,
    order.title?.trim() || order.orderNo || "订单详情",
  );
}

async function resolveProject(userId: string, role: string, entityId: string): Promise<AgentResourceLocation> {
  let project: { id: string; name: string };
  try {
    project = await getProjectResourceForActor(
      { userId, role, name: null, email: null },
      entityId,
    );
  } catch (err) {
    mapDomainErrorToAgentError(err, { resourceLabel: "项目" });
  }
  return buildLocation(
    "project",
    project.id,
    `/projects/${project.id}`,
    project.name?.trim() || "项目详情",
  );
}

async function resolveTicket(userId: string, role: string, entityId: string): Promise<AgentResourceLocation> {
  try {
    const ticket = await getTicketResourceForActor({ userId, role }, entityId);
    return buildLocation(
      "ticket",
      entityId,
      `/tickets/${ticket.id}`,
      ticket.title?.trim() || "工单详情",
    );
  } catch (err) {
    mapDomainErrorToAgentError(err, { resourceLabel: "工单" });
  }
}

async function resolveInvoice(userId: string, role: string, entityId: string): Promise<AgentResourceLocation> {
  if (!canReadFinance(role)) {
    throw new AgentActionForbiddenError("Invoice is not readable");
  }

  try {
    const resource = await getInvoiceResourceForActor(
      { userId, role, name: null, email: null },
      entityId,
    );
    return buildLocation("invoice", resource.id, resource.href, resource.title);
  } catch (err) {
    mapDomainErrorToAgentError(err, { resourceLabel: "发票" });
  }
}

/**
 * Resolve an entity request into a canonical location, applying object-level
 * permissions.  Throws `AgentAction*Error` on missing/forbidden entities.
 */
export async function resolveEntityLocation(
  userId: string,
  role: string,
  entityType: AgentResourceEntityType,
  entityId: string,
  initialTab?: string,
): Promise<AgentResourceLocation> {
  if (!entityType || !entityId) {
    throw new AgentActionInputError("entityType and entityId are required");
  }
  switch (entityType) {
    case "customer": return resolveCustomer(userId, role, entityId, initialTab);
    case "order": return resolveOrder(userId, role, entityId);
    case "project": return resolveProject(userId, role, entityId);
    case "ticket": return resolveTicket(userId, role, entityId);
    case "invoice": return resolveInvoice(userId, role, entityId);
  }
}

/**
 * Produce a resolution for an already-validated canonical location.
 *
 * Used when the caller has already resolved the entity (e.g. via
 * `resolveEntityLocation`) and just needs to package it as either an embeddable
 * resource or a navigate-away.
 */
export function locationToResolution(location: AgentResourceLocation): AgentResourceResolution {
  if (location.canEmbed) {
    return { mode: "resource", location };
  }
  return { mode: "navigate", href: location.href, label: location.title };
}

/**
 * Recognize in-app *detail* hrefs (Markdown links the model writes) and map
 * them to entity requests so they get the same permission check + canonical
 * resolution as GenUI clicks.  Returns null for non-detail hrefs — those fall
 * back to the navigate allowlist.
 *
 * Recognized shapes:
 *   /crm/customers/{id}            -> customer
 *   /projects/{id}                 -> project
 *   /tickets/{id}                  -> ticket
 *   /orders?focus={id}             -> order
 *   /finance/invoices?invoiceId={id} -> invoice
 */
export function parseEntityHref(
  href: string,
): { entityType: AgentResourceEntityType; entityId: string } | null {
  if (!href.startsWith("/")) return null;
  const [path, query] = href.split("?");

  const detailMatch = path.match(/^\/(crm\/customers|projects|tickets)\/([^/?]+)$/);
  if (detailMatch) {
    const segment = detailMatch[1];
    const entityType: AgentResourceEntityType =
      segment === "crm/customers" ? "customer" : segment === "projects" ? "project" : "ticket";
    const entityId = decodeURIComponent(detailMatch[2]).trim();
    return entityId ? { entityType, entityId } : null;
  }

  if (query) {
    const params = new URLSearchParams(query);
    if (path === "/orders") {
      const focus = params.get("focus")?.trim();
      if (focus) return { entityType: "order", entityId: focus };
    }
    if (path === "/finance/invoices") {
      const invoiceId = params.get("invoiceId")?.trim();
      if (invoiceId) return { entityType: "invoice", entityId: invoiceId };
    }
  }
  return null;
}

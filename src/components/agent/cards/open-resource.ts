import type { AgentResourceEntityType } from "@/lib/agent-resources/types";
import type { AgentCardProps } from "../agent-ui-types";

type OpenHandlers = Pick<AgentCardProps, "onOpenResource" | "onApplyViewIntent">;

/**
 * Open a business entity via Resource Panel when available; otherwise fall back
 * to view-intent (focus_entity for embeddable kinds, navigate for invoice).
 */
export function openEntityResource(
  entityType: AgentResourceEntityType,
  entityId: string,
  label: string,
  { onOpenResource, onApplyViewIntent }: OpenHandlers,
) {
  if (!entityId) return;
  if (onOpenResource) {
    onOpenResource({
      type: "entity",
      entityType,
      entityId,
      label,
    });
    return;
  }
  if (entityType === "invoice") {
    onApplyViewIntent({
      type: "navigate",
      route: `/finance/invoices?invoiceId=${encodeURIComponent(entityId)}`,
      label,
    });
    return;
  }
  onApplyViewIntent({
    type: "focus_entity",
    entityType,
    entityId,
    label,
  });
}

export const ENTITY_ROW_BUTTON_CLASS =
  "flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40";

export const ENTITY_BLOCK_BUTTON_CLASS =
  "group flex w-full items-center justify-between gap-2 rounded-xl bg-muted/30 px-3 py-2 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40";

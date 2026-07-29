"use client";

import type { AgentViewIntent } from "@/lib/agent-runtime/types";
import type { AgentResourceRequest } from "@/lib/agent-resources/types";
import type { AgentCardProps, AgentUiSource } from "./agent-ui-types";
import { normalizeAgentUi, buildAgentUiSource } from "./agent-ui-adapters";
import type { AgentProposal } from "./chat-panel";
import { FallbackToolCard } from "./cards/card-shell";

// ---- Card component type ----
type CardComponent = React.ComponentType<AgentCardProps>;

// ---- Registry (populated as cards are implemented) ----
const registry = new Map<string, CardComponent>();

export function registerAgentUiCard(type: string, component: CardComponent) {
  registry.set(type, component);
}

/**
 * Whether a real GenUI card is registered for this tool result.
 * Used by the message stream: tools without a card render as a compact
 * one-line record instead of the generic white fallback card.
 */
export function hasAgentUiCard(
  actionKey: string,
  input: unknown,
  output: unknown,
  status: AgentUiSource["status"],
): boolean {
  const source = buildAgentUiSource({ actionKey, input, output, status });
  const descriptor = normalizeAgentUi(source);
  return Boolean(descriptor && registry.has(descriptor.type));
}

// ---- Stable wrapper that renders the dynamically-looked-up card ----
// Declared outside render to satisfy react-hooks/static-components.
// The dynamic registry lookup is an intentional pattern: the registry maps
// UI types to card components at module load time, and this wrapper resolves
// the mapping at render time. The components themselves are stable references.
function RegisteredCard(props: AgentCardProps & { type: string }) {
  const { type, ...cardProps } = props;
  const Card = registry.get(type);
  if (!Card) {
    return <FallbackToolCard actionKey={cardProps.descriptor.type} />;
  }
  // eslint-disable-next-line react-hooks/static-components
  return <Card {...cardProps} />;
}

/**
 * Renders the appropriate GenUI card for an AgentUiSource.
 *
 * Normalizes the source into a descriptor, looks up the card component in the
 * registry, and renders it.  Unrecognized actionKeys fall back to a safe
 * generic tool status card.
 */
export function AgentUiRenderer({
  actionKey,
  input,
  output,
  proposal,
  status,
  proposalBusyId,
  onConfirmProposal,
  onRejectProposal,
  onUpdateProposal,
  onApplyViewIntent,
  onOpenResource,
  onCreateProposal,
  onSendPrefilled,
  onCardDirtyChange,
  fallbackCardId,
}: {
  actionKey: string;
  input: unknown;
  output?: unknown;
  proposal?: AgentProposal;
  status: AgentUiSource["status"];
  proposalBusyId?: string | null;
  onConfirmProposal: (id: string) => void;
  onRejectProposal: (id: string) => void;
  onUpdateProposal: (id: string, input: Record<string, unknown>) => Promise<AgentProposal>;
  onApplyViewIntent: (intent: AgentViewIntent) => void;
  onOpenResource?: (
    request: AgentResourceRequest,
    options?: { target?: "workspace" | "page" },
  ) => void;
  onCreateProposal?: (actionKey: string, input: Record<string, unknown>) => Promise<AgentProposal | null>;
  onSendPrefilled?: (message: string, context?: Record<string, unknown>) => void;
  onCardDirtyChange?: (cardId: string, dirty: boolean) => void;
  /** Stable ID for dirty-card tracking when no proposal ID exists (e.g. timeline item.id). */
  fallbackCardId?: string;
}) {
  // Build source with Pi tool output unwrapping (handles both Pi and legacy)
  const source = buildAgentUiSource({ actionKey, input, output, proposal, status });
  const descriptor = normalizeAgentUi(source);

  // Use the unwrapped proposal if Pi extracted one
  const effectiveProposal = source.proposal ?? proposal;

  // Build a stable cardId for dirty-card tracking.
  // Falls back to actionKey + profileId from input, or actionKey + descriptor
  // type. Never uses Date.now() (impure in render).
  const inputProfileId = typeof input === "object" && input && "profileId" in input
    ? String((input as Record<string, unknown>).profileId)
    : undefined;
  const cardId = effectiveProposal?.id
    ?? fallbackCardId
    ?? (inputProfileId ? `${actionKey}:${inputProfileId}` : `${actionKey}:${descriptor?.type ?? "unknown"}`);

  if (!descriptor) {
    // Fallback: safe generic tool status card
    return (
      <FallbackToolCard
        actionKey={actionKey}
        label={typeof source.output === "object" && source.output && "label" in source.output ? String((source.output as Record<string, unknown>).label) : actionKey}
        error={status === "error" ? "执行失败" : undefined}
      />
    );
  }

  return (
    <RegisteredCard
      type={descriptor.type}
      descriptor={descriptor}
      proposal={effectiveProposal}
      proposalBusyId={proposalBusyId}
      onConfirmProposal={onConfirmProposal}
      onRejectProposal={onRejectProposal}
      onUpdateProposal={onUpdateProposal}
      onApplyViewIntent={onApplyViewIntent}
      onOpenResource={onOpenResource}
      onCreateProposal={onCreateProposal}
      onSendPrefilled={onSendPrefilled}
      onCardDirtyChange={onCardDirtyChange ? (dirty: boolean) => onCardDirtyChange(cardId, dirty) : undefined}
    />
  );
}

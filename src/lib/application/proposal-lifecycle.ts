/**
 * Server-side proposal lifecycle handler registry.
 *
 * Action definitions only declare a lifecycle key/intent (proposalLifecycleKey).
 * Domain services register a handler under that key; the proposal service looks
 * the handler up and invokes persist/revert inside its own transactions.
 *
 * The Prisma transaction client stays on this server-side seam and never leaks
 * into action files or the public AgentActionDefinition type (see migration
 * standard §1.4 / T1).
 */
import type { Prisma } from "@prisma/client";

/** Minimal actor shape for domain lifecycle hooks (no Prisma coupling). */
export type ProposalLifecycleActor = {
  userId: string;
  role: string;
  agentRunId?: string | null;
  chatSessionId?: string | null;
};

export type ProposalLifecycleRevertTarget = {
  id: string;
  actionKey: string;
  inputJson: string;
};

export interface ProposalLifecycleHandler {
  key: string;
  /**
   * Called inside the proposal-creation transaction after the AgentProposal row
   * is created. Domain state is advanced atomically (e.g. import row
   * CONFIRMED_* → PROPOSED). A 0-row effect must throw a structured 409 so the
   * whole transaction rolls back and no orphan proposal remains.
   */
  persist?: (
    tx: Prisma.TransactionClient,
    actor: ProposalLifecycleActor,
    input: Record<string, unknown>,
    proposalId: string,
  ) => Promise<void>;
  /**
   * Called inside the reject / stale-recovery / confirm-failure transaction to
   * roll domain state back (e.g. import row PROPOSED → CONFIRMED_*). Not
   * implementing this keeps the action's behavior unchanged.
   */
  revert?: (
    tx: Prisma.TransactionClient,
    actor: ProposalLifecycleActor,
    proposal: ProposalLifecycleRevertTarget,
  ) => Promise<void>;
}

declare global {
  var __proposalLifecycleRegistry: Map<string, ProposalLifecycleHandler> | undefined;
}

function store(): Map<string, ProposalLifecycleHandler> {
  if (!globalThis.__proposalLifecycleRegistry) {
    globalThis.__proposalLifecycleRegistry = new Map<string, ProposalLifecycleHandler>();
  }
  return globalThis.__proposalLifecycleRegistry;
}

export function registerProposalLifecycle(handler: ProposalLifecycleHandler): void {
  store().set(handler.key, handler);
}

export function getProposalLifecycle(
  key: string | null | undefined,
): ProposalLifecycleHandler | undefined {
  if (!key) return undefined;
  return store().get(key);
}

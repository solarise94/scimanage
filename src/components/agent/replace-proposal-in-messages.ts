import type { AgentChatMessage, AgentProposal } from "./chat-panel";

/** Replace a proposal object nested inside a tool output (Pi-wrapped or flat). */
function replaceProposalInToolOutput(output: unknown, updated: AgentProposal): unknown {
  if (!output || typeof output !== "object") return output;
  const obj = output as Record<string, unknown>;

  // Pi-wrapped: { details: { mode, proposal } }
  if (obj.details && typeof obj.details === "object") {
    const details = obj.details as Record<string, unknown>;
    if (details.proposal && typeof details.proposal === "object") {
      const nested = details.proposal as AgentProposal;
      if (nested.id === updated.id) {
        return { ...obj, details: { ...details, proposal: updated } };
      }
    }
  }

  // Flat: { proposal: {...} }
  if (obj.proposal && typeof obj.proposal === "object") {
    const nested = obj.proposal as AgentProposal;
    if (nested.id === updated.id) {
      return { ...obj, proposal: updated };
    }
  }

  return output;
}

/**
 * Update every occurrence of a proposal (by id) across message.proposals and
 * timeline tool outputs. Used after confirm / reject / PATCH so the original
 * card transitions out of PENDING instead of leaving a stale duplicate.
 */
export function replaceProposalInMessages(
  messages: AgentChatMessage[],
  updated: AgentProposal,
): AgentChatMessage[] {
  return messages.map((message) => {
    let changed = false;

    const proposals = message.proposals?.map((proposal) => {
      if (proposal.id !== updated.id) return proposal;
      changed = true;
      return updated;
    });

    const timeline = message.timeline?.map((item) => {
      if (item.kind !== "tool") return item;
      const nextOutput = replaceProposalInToolOutput(item.output, updated);
      if (nextOutput === item.output) return item;
      changed = true;
      return { ...item, output: nextOutput };
    });

    if (!changed) return message;
    return {
      ...message,
      ...(proposals ? { proposals } : {}),
      ...(timeline ? { timeline } : {}),
    };
  });
}

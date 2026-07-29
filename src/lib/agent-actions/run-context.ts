/**
 * Agent adapter for AgentRun / chat-session ownership + internal tool token.
 *
 * Prisma-free adapter: all AgentRun CRUD, run→actor resolution and chat-session
 * ownership checks live in the runtime service `@/lib/application/agent-runs`.
 * Re-exported here so existing `@/lib/agent-actions/run-context` import paths
 * stay stable. The internal tool token helpers keep no Prisma access and remain
 * in this adapter.
 */
import { randomUUID } from "crypto";

export {
  createAgentRunFromSession,
  getOrCreateAgentRunFromSession,
  getExecutionContextFromAgentRun,
  getTrustedAgentRunSource,
  listAgentRunsForUser,
  ensureAgentRunBelongsToSession,
  verifyChatSessionForActor,
} from "@/lib/application/agent-runs";

declare global {
  var __agentInternalToolToken: string | undefined;
}

export function getInternalToolToken() {
  const configured = process.env.AGENT_INTERNAL_TOOL_TOKEN?.trim();
  if (configured) return configured;
  if (!globalThis.__agentInternalToolToken) {
    globalThis.__agentInternalToolToken = randomUUID();
  }
  return globalThis.__agentInternalToolToken;
}

export function isValidInternalToolToken(token: string | null | undefined) {
  if (!token) return false;
  return token === getInternalToolToken();
}

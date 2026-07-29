/**
 * Agent adapter for AgentActionLog persistence.
 *
 * Prisma-free re-export: the actual persistence lives in the runtime service
 * `@/lib/application/agent-action-logs`. Kept as a thin adapter so existing
 * `@/lib/agent-actions/logs` import paths stay stable.
 */
export { createAgentActionLog, writeAgentActionLog } from "@/lib/application/agent-action-logs";

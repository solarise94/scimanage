/**
 * Agent adapter for Proposal confirm/reject chat events.
 *
 * Prisma-free re-export: the actual persistence lives in the application
 * service `@/lib/application/agent-proposal-chat-events`. Kept as a thin adapter so existing
 * `@/lib/agent-runtime/proposal-chat-events` import paths stay stable.
 */
export * from "@/lib/application/agent-proposal-chat-events";

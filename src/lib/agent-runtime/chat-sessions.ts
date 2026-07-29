/**
 * Agent adapter for Chat session CRUD + message commit.
 *
 * Prisma-free re-export: the actual persistence lives in the application
 * service `@/lib/application/agent-chat-sessions`. Kept as a thin adapter so existing
 * `@/lib/agent-runtime/chat-sessions` import paths stay stable.
 */
export * from "@/lib/application/agent-chat-sessions";

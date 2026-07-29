/**
 * Agent adapter for Agent memory CRUD + recall.
 *
 * Prisma-free re-export: the actual persistence lives in the application
 * service `@/lib/application/agent-memory`. Kept as a thin adapter so existing
 * `@/lib/agent-runtime/memory` import paths stay stable.
 */
export * from "@/lib/application/agent-memory";

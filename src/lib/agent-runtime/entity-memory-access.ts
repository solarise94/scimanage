/**
 * Agent adapter for Entity memory read-side ACL.
 *
 * Prisma-free re-export: the actual persistence lives in the application
 * service `@/lib/application/agent-entity-memory-access`. Kept as a thin adapter so existing
 * `@/lib/agent-runtime/entity-memory-access` import paths stay stable.
 */
export * from "@/lib/application/agent-entity-memory-access";

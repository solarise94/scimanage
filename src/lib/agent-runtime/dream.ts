/**
 * Agent adapter for Offline dream cycle.
 *
 * Prisma-free re-export: the actual persistence lives in the application
 * service `@/lib/application/agent-dream-cycle`. Kept as a thin adapter so existing
 * `@/lib/agent-runtime/dream` import paths stay stable.
 */
export * from "@/lib/application/agent-dream-cycle";

/**
 * Agent adapter for the proposal lifecycle service.
 *
 * Prisma-free re-export: the actual persistence lives in the application
 * service `@/lib/application/agent-proposals`. Kept as a thin adapter so
 * existing `@/lib/agent-actions/proposals` import paths stay stable.
 */
export * from "@/lib/application/agent-proposals";

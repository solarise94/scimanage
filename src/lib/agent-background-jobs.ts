/**
 * Agent adapter for background job scheduling/persistence.
 *
 * Prisma-free re-export: the actual persistence lives in the application
 * service `@/lib/application/agent-background-jobs`. Kept as a thin adapter so
 * existing `@/lib/agent-background-jobs` import paths stay stable.
 */
export * from "@/lib/application/agent-background-jobs";

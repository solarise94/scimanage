/**
 * Agent adapter for task workspace persistence.
 *
 * Prisma-free re-export: the actual persistence lives in the application
 * service `@/lib/application/agent-task-workspace`. Kept as a thin adapter so
 * existing `@/lib/agent-task-workspace` import paths stay stable.
 */
export * from "@/lib/application/agent-task-workspace";

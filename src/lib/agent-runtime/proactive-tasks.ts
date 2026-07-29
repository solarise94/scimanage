/**
 * Agent adapter for Proactive task CRUD + due runner.
 *
 * Prisma-free re-export: the actual persistence lives in the application
 * service `@/lib/application/agent-proactive-tasks`. Kept as a thin adapter so existing
 * `@/lib/agent-runtime/proactive-tasks` import paths stay stable.
 */
export * from "@/lib/application/agent-proactive-tasks";

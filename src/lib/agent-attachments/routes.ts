/**
 * Agent adapter for attachment→business-target routing state machine.
 *
 * Prisma-free re-export: the actual persistence lives in the application
 * service `@/lib/application/agent-attachment-routes`. Kept as a thin adapter
 * so existing `@/lib/agent-attachments/routes` import paths stay stable.
 */
export * from "@/lib/application/agent-attachment-routes";

/**
 * Agent adapter for attachment staging lifecycle.
 *
 * Prisma-free re-export: the actual persistence lives in the application
 * service `@/lib/application/agent-attachment-staging`. Kept as a thin adapter
 * so existing `@/lib/agent-attachments/staging` import paths stay stable.
 */
export * from "@/lib/application/agent-attachment-staging";

/**
 * System-level user enumeration for Agent dream cycle (T3.5).
 *
 * Dream cron runs without a per-request BusinessActor; this helper defines the
 * minimal eligible role set for entity memory refresh and consolidation.
 * Each user's business reads still use that user's own actor downstream.
 */
import { prisma } from "@/lib/prisma";

export const DREAM_CYCLE_ELIGIBLE_ROLES = [
  "ADMIN",
  "USER",
  "REPRESENTATIVE",
  "REGIONAL_MANAGER",
] as const;

export type DreamCycleEligibleUser = {
  id: string;
  role: string;
};

/**
 * Users that participate in nightly entity memory refresh / consolidation.
 * Optional `limit` supports smoke/debug runs.
 */
export async function listDreamCycleEligibleUsers(opts?: {
  limit?: number;
}): Promise<DreamCycleEligibleUser[]> {
  return prisma.user.findMany({
    where: { role: { in: [...DREAM_CYCLE_ELIGIBLE_ROLES] } },
    select: { id: true, role: true },
    ...(Number.isFinite(opts?.limit) ? { take: opts!.limit } : {}),
  });
}

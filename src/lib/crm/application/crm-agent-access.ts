/**
 * CRM Agent read / rep-self-service capability gates (T5.1).
 *
 * availability() hints live in action adapters; services re-check here.
 */
import type { BusinessActor } from "@/lib/application/actor";
import { ForbiddenError } from "@/lib/application/errors";
import { isRegionalManagerRole, isRepresentativeRole } from "@/lib/crm/permissions";

export function canUseCrmAgent(role: string): boolean {
  return isRepresentativeRole(role) || role === "ADMIN";
}

export function canReadCrmAgent(role: string): boolean {
  return canUseCrmAgent(role) || isRegionalManagerRole(role);
}

export function assertCrmAgentReadAccess(actor: BusinessActor): void {
  if (!canReadCrmAgent(actor.role)) {
    throw new ForbiddenError("无权访问 CRM 客户查询");
  }
}

export function assertCrmRepSelfServiceAccess(actor: BusinessActor): void {
  if (!canUseCrmAgent(actor.role)) {
    throw new ForbiddenError("无权访问代表自助 CRM 查询");
  }
}

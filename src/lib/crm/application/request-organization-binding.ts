/**
 * Canonical actor-aware representative organization binding command (T5.4).
 *
 * Self-service path only: result is always PENDING (never ADMIN auto-ACTIVE).
 * Shared by Agent `crm.request_organization_binding` and Web
 * `POST /api/crm/representative-organizations` when the caller binds their own rep
 * (no `representativeId` proxy, non-ADMIN).
 */
import type { BusinessActor, InvocationContext } from "@/lib/application/actor";
import { ForbiddenError, ValidationError } from "@/lib/application/errors";
import { assertCrmRepSelfServiceAccess } from "@/lib/crm/application/crm-agent-access";
import {
  requestOrganizationBindingForSelf,
  type BindingWarningCode,
  type RequestOrganizationBindingResult,
} from "@/lib/crm/services/representative-organization-request";

export type RequestOrganizationBindingInput = {
  organizationId?: string;
  canonicalName?: string;
  organizationSiteId?: string;
};

export type { BindingWarningCode, RequestOrganizationBindingResult };

const WEB_SELF_SERVICE_ROLES = new Set(["REPRESENTATIVE", "REGIONAL_MANAGER"]);

function assertWebSelfServiceAccess(actor: BusinessActor): void {
  if (!WEB_SELF_SERVICE_ROLES.has(actor.role)) {
    throw new ForbiddenError();
  }
}

export async function requestOrganizationBindingForActor(
  actor: BusinessActor,
  invocation: InvocationContext,
  input: RequestOrganizationBindingInput,
): Promise<RequestOrganizationBindingResult> {
  if (invocation.channel === "agent") {
    assertCrmRepSelfServiceAccess(actor);
  } else {
    assertWebSelfServiceAccess(actor);
  }

  const organizationId = input.organizationId?.trim() || undefined;
  const canonicalName = input.canonicalName?.trim() || undefined;
  const organizationSiteId = input.organizationSiteId?.trim() || undefined;

  if (!organizationId && !canonicalName) {
    throw new ValidationError("organizationId 或 canonicalName 至少需要一个");
  }
  if (!organizationId && organizationSiteId) {
    throw new ValidationError("新单位绑定申请不能指定院区");
  }
  if (!actor.email) {
    throw new ValidationError("当前账号无邮箱，无法解析代表");
  }

  return requestOrganizationBindingForSelf({
    userId: actor.userId,
    userEmail: actor.email,
    role: actor.role,
    organizationId,
    canonicalName,
    organizationSiteId,
  });
}

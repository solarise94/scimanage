/**
 * Canonical actor-aware customer application submit command (T5.4).
 *
 * Shared by Agent `crm.submit_customer_application` and Web
 * `POST /api/crm/customer-applications`.
 */
import type { BusinessActor, InvocationContext } from "@/lib/application/actor";
import { ForbiddenError, ValidationError } from "@/lib/application/errors";
import { assertCrmRepSelfServiceAccess } from "@/lib/crm/application/crm-agent-access";
import {
  submitCustomerApplication,
  type SubmitCustomerApplicationParams,
  type SubmitCustomerApplicationResult,
} from "@/lib/crm/services/customer-application-submit";

export type SubmitCustomerApplicationInput = {
  name: string;
  organizationId?: string;
  organizationSiteId?: string;
  organizationRawInput?: string;
  organization?: string;
  principal?: string;
  email?: string;
  wechat?: string;
  miniProgramId?: string;
  address?: string;
  notes?: string;
  location?: { lat: number; lng: number; address: string };
  duplicateDecision?: "CREATE_NEW";
  dryRun?: boolean;
};

export type { SubmitCustomerApplicationResult };

const WEB_SUBMIT_ROLES = new Set(["ADMIN", "REPRESENTATIVE", "REGIONAL_MANAGER"]);

function assertWebSubmitAccess(actor: BusinessActor): void {
  if (!WEB_SUBMIT_ROLES.has(actor.role)) {
    throw new ForbiddenError();
  }
}

export async function submitCustomerApplicationForActor(
  actor: BusinessActor,
  invocation: InvocationContext,
  input: SubmitCustomerApplicationInput,
): Promise<SubmitCustomerApplicationResult> {
  if (invocation.channel === "agent") {
    assertCrmRepSelfServiceAccess(actor);
  } else {
    assertWebSubmitAccess(actor);
  }

  const name = input.name?.trim();
  if (!name) {
    throw new ValidationError("客户姓名为必填项");
  }

  const params: SubmitCustomerApplicationParams = {
    userId: actor.userId,
    role: actor.role,
    name,
    organizationId: input.organizationId,
    organizationSiteId: input.organizationSiteId,
    organizationRawInput: input.organizationRawInput,
    organization: input.organization,
    principal: input.principal,
    email: input.email,
    wechat: input.wechat,
    miniProgramId: input.miniProgramId,
    address: input.address,
    notes: input.notes,
    location: input.location,
    duplicateDecision: input.duplicateDecision,
    dryRun: input.dryRun,
  };

  return submitCustomerApplication(params);
}

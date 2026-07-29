/**
 * Shared customer-application submit service.
 *
 * Extracted from `src/app/api/crm/customer-applications/route.ts` POST so that
 * both the API route and the Agent action (`crm.submit_customer_application`)
 * share the same business logic for duplicate detection, Customer+Profile
 * creation, and supervisor review queue entry.
 *
 * @see docs/agent-mobile-crm-genui-functional-design-2026-07-14.md §8.6, §10.2
 */

import type { CrmCustomerApplication } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  buildApplicationProfileData,
  buildCustomerData,
  createApplicationCustomerWithProfile,
  findDuplicateCustomers,
  checkOrgOwnership,
  checkCustomerOwnershipConflict,
  type DuplicateCandidate,
} from "@/lib/crm/customer-application-review";
import { resolveCustomerOrganizationWrite } from "@/lib/customers/customer-organization-write";
import { generateCustomerCode } from "@/lib/customer-code";
import { notifyApplicationSupervisors } from "@/lib/crm/supervisor";

const applicationInclude = {
  submittedByUser: { select: { id: true, name: true, email: true } },
  reviewedByUser: { select: { id: true, name: true } },
  createdCrmProfile: { select: { id: true, name: true, customerCode: true } },
};

function pruneCandidate(c: {
  id: string; name: string; customerCodeLast6: string;
  organization: string | null; hasCrmProfile: boolean; matchReasons: string[];
  matchedName?: string; matchedNameType?: string;
}) {
  return {
    id: c.id,
    name: c.name,
    customerCodeLast6: c.customerCodeLast6,
    organization: c.organization,
    hasCrmProfile: c.hasCrmProfile,
    matchReasons: c.matchReasons,
    matchedName: c.matchedName,
    matchedNameType: c.matchedNameType,
  };
}

export interface SubmitCustomerApplicationParams {
  userId: string;
  role: string;
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
  /** When true, only runs validation/duplicate detection without creating records. */
  dryRun?: boolean;
}

export interface SubmitCustomerApplicationResult {
  application: CrmCustomerApplication;
  profileId: string;
  blockingDuplicates: DuplicateCandidate[];
}

/**
 * Submit a new customer application.
 *
 * Flow:
 * 1. Resolve organization (must be valid/bound).
 * 2. Duplicate detection (blocking + weak).
 * 3. If blocking duplicates and no CREATE_NEW decision -> return candidates.
 * 4. Conflict checks (org ownership, customer ownership).
 * 5. Auto-approve: create Customer + CrmCustomerProfile in a transaction.
 * 6. Application record: status=APPROVED, autoApproved=true, supervisorReviewStatus=PENDING.
 * 7. Notify supervisors (best-effort).
 *
 * When `dryRun` is true, steps 5-7 are skipped - only validation and duplicate
 * detection run, returning blocking candidates for the proposal buildProposal phase.
 */
export async function submitCustomerApplication(
  params: SubmitCustomerApplicationParams,
): Promise<SubmitCustomerApplicationResult> {
  const {
    userId, role, name, organizationId, organizationSiteId,
    organizationRawInput, organization, principal, email, wechat, miniProgramId,
    address, notes, location, duplicateDecision, dryRun,
  } = params;

  if (!name?.trim()) {
    throw new Error("客户姓名为必填项");
  }

  // 1. Resolve organization
  const rawOrgText = organizationRawInput?.trim() || organization?.trim() || null;
  const orgWrite = await resolveCustomerOrganizationWrite({
    organizationId: organizationId || null,
    organizationSiteId: organizationSiteId || null,
    organizationText: organization?.trim() || null,
    organizationRawInput: organizationRawInput?.trim() || null,
  });
  if (!orgWrite.ok) {
    throw new Error(orgWrite.message);
  }
  if (!orgWrite.organizationId) {
    throw new Error("客户单位为必填项，请选择已绑定单位或先申请单位绑定");
  }

  const orgValidation = {
    organizationId: orgWrite.organizationId,
    organizationSiteId: orgWrite.organizationSiteId,
    canonicalName: orgWrite.organization,
  };

  // 2. Duplicate detection
  const { blocking, weak } = await findDuplicateCustomers({
    name: name.trim(),
    email,
    wechat,
    miniProgramId,
    organizationId: orgValidation.organizationId || null,
    organizationRawInput: rawOrgText,
    organization,
    principal,
  });
  const allCandidates = [...blocking, ...weak];

  // 3. Blocking duplicates without CREATE_NEW
  if (blocking.length > 0 && duplicateDecision !== "CREATE_NEW") {
    return {
      application: null as unknown as CrmCustomerApplication,
      profileId: "",
      blockingDuplicates: blocking,
    };
  }

  // Dry run: stop here, return blocking duplicates (empty at this point)
  if (dryRun) {
    return {
      application: null as unknown as CrmCustomerApplication,
      profileId: "",
      blockingDuplicates: [],
    };
  }

  // 4. Conflict checks
  const isDirectRepSubmission = role === "REPRESENTATIVE";
  const hasOrgConflict = isDirectRepSubmission
    ? await checkOrgOwnership(userId, orgValidation.organizationId, orgValidation.organizationSiteId)
    : false;
  const hasCustConflict = checkCustomerOwnershipConflict(allCandidates, userId);

  let conflictType: string | null = null;
  if (hasOrgConflict && hasCustConflict) conflictType = "BOTH";
  else if (hasOrgConflict) conflictType = "ORG_CONFLICT";
  else if (hasCustConflict) conflictType = "CUSTOMER_CONFLICT";

  const isOverride = blocking.length > 0 && duplicateDecision === "CREATE_NEW";
  const duplicateCheckStatus = isOverride ? "OVERRIDDEN_NEW" : (blocking.length > 0 ? "CANDIDATES_FOUND" : "CLEAN");
  const supervisorReviewReason = isOverride ? "DUPLICATE_OVERRIDE" : (conflictType || "NORMAL");

  const appData = {
    name: name.trim(),
    principal: principal?.trim() || null,
    email: email?.trim() || null,
    wechat: wechat?.trim() || null,
    organization: orgValidation.canonicalName || organization?.trim() || null,
    organizationId: orgValidation.organizationId || null,
    organizationSiteId: orgValidation.organizationSiteId || null,
    organizationRawInput: rawOrgText,
    address: address?.trim() || null,
    miniProgramId: miniProgramId?.trim() || null,
    notes: notes?.trim() || null,
  };

  const customerData = buildCustomerData(appData, orgValidation);

  // 5. Auto-approve: create Customer + CrmCustomerProfile (3-attempt retry on P2002)
  let application: CrmCustomerApplication | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      application = await prisma.$transaction(async (tx) => {
        const customerCode = await generateCustomerCode(tx);
        const profileData = buildApplicationProfileData(customerData);
        const { profileId } = await createApplicationCustomerWithProfile(tx, {
          name: customerData.name,
          customerCode,
          profileFields: profileData,
          placeholderOwnerUserId: userId,
          fallbackOwnerUserId: userId,
          actingUserId: userId,
          actingNote: "客户申请自动创建：管理关系转为跟进历史",
        });

        if (location?.address?.trim()) {
          await tx.crmCustomerAddress.create({
            data: {
              profileId,
              sourceType: "CUSTOMER_APPLICATION",
              addressText: location.address.trim(),
              lat: location.lat,
              lng: location.lng,
              isPrimary: true,
            },
          });
        }

        const app = await tx.crmCustomerApplication.create({
          data: {
            name: appData.name,
            principal: appData.principal,
            email: appData.email,
            wechat: appData.wechat,
            organization: appData.organization,
            organizationId: appData.organizationId,
            organizationSiteId: appData.organizationSiteId,
            organizationRawInput: appData.organizationRawInput,
            address: appData.address,
            miniProgramId: appData.miniProgramId,
            notes: appData.notes,
            locationLat: location?.lat ?? null,
            locationLng: location?.lng ?? null,
            locationAddress: location?.address?.trim() || null,
            status: "APPROVED",
            autoApproved: true,
            autoApprovedAt: new Date(),
            submittedByUserId: userId,
            createdCrmProfileId: profileId,
            supervisorReviewStatus: "PENDING",
            supervisorReviewReason,
            duplicateCheckStatus,
            duplicateCandidatesJson: allCandidates.length > 0 ? JSON.stringify(allCandidates.map(pruneCandidate)) : null,
            conflictType,
            adminReviewStatus: "PENDING",
          },
          include: applicationInclude,
        });

        if (appData.notes) {
          await tx.crmInteraction.create({
            data: {
              profileId,
              type: "NOTE",
              summary: appData.notes,
              happenedAt: app.createdAt,
              createdByUserId: userId,
              sourceType: "CUSTOMER_APPLICATION",
              sourceId: app.id,
            },
          });
        }

        return app;
      });
      break;
    } catch (e: unknown) {
      const isPrismaUnique = typeof e === "object" && e !== null && "code" in e && (e as { code: string }).code === "P2002";
      if (!isPrismaUnique || attempt === 2) {
        throw e;
      }
    }
  }

  if (!application) {
    throw new Error("申请提交失败");
  }

  // 6. Notify supervisors (best-effort)
  notifyApplicationSupervisors(application.id, supervisorReviewReason).catch(() => {});

  return {
    application,
    profileId: application.createdCrmProfileId ?? "",
    blockingDuplicates: [],
  };
}

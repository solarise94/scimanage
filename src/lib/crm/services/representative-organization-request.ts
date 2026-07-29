/**
 * Shared representative-organization-request service.
 *
 * Extracted from `src/app/api/crm/representative-organizations/route.ts` POST.
 *
 * Key constraint: this service is for REPRESENTATIVE self-service only.
 * The status is ALWAYS "PENDING" - the ADMIN/RM auto-ACTIVE branch from the
 * route is intentionally NOT exposed here.  This prevents the Agent action
 * from accidentally opening the auto-approve path to representatives.
 *
 * @see docs/agent-mobile-crm-genui-functional-design-2026-07-14.md §8.5, §10.2
 */

import type { RepresentativeOrganization } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getRepresentativeIdByUserEmail, isRegionalManagerRole } from "@/lib/crm/permissions";
import { resolveOrganization } from "@/lib/organization-resolver";
import { notifyBindingReviewers } from "@/lib/crm/supervisor";
import {
  findRepresentativeBindingByScope,
  hasActiveBindingAtLevel,
  validateRepresentativeBindingScope,
} from "@/lib/crm/representative-binding";

export type BindingWarningCode =
  | "ORG_BOUND_BY_OTHER_REP"
  | "ORG_PENDING_BY_OTHER_REP"
  | "ORG_NAME_PENDING_BY_OTHER_REP";

function normalizeOrgName(text: string): string {
  return text.replace(/\s+/g, "").toLowerCase();
}

async function collectExistingOrgWarnings(
  representativeId: string,
  organizationId: string,
  organizationSiteId: string | null,
): Promise<BindingWarningCode[]> {
  const warnings: BindingWarningCode[] = [];

  const otherActive = await prisma.representativeOrganization.findFirst({
    where: {
      organizationId,
      organizationSiteId: organizationSiteId ?? null,
      status: "ACTIVE",
      representativeId: { not: representativeId },
    },
    select: { id: true },
  });
  if (otherActive) warnings.push("ORG_BOUND_BY_OTHER_REP");

  const otherPending = await prisma.representativeOrganization.findFirst({
    where: {
      organizationId,
      organizationSiteId: organizationSiteId ?? null,
      status: "PENDING",
      representativeId: { not: representativeId },
    },
    select: { id: true },
  });
  if (otherPending) warnings.push("ORG_PENDING_BY_OTHER_REP");

  return warnings;
}

async function collectRequestedNameWarnings(
  representativeId: string,
  requestedOrganizationNormalizedName: string,
): Promise<BindingWarningCode[]> {
  const otherPending = await prisma.representativeOrganization.findFirst({
    where: {
      representativeId: { not: representativeId },
      organizationId: null,
      requestedOrganizationNormalizedName,
      status: "PENDING",
    },
    select: { id: true },
  });

  return otherPending ? ["ORG_NAME_PENDING_BY_OTHER_REP"] : [];
}

export interface RequestOrganizationBindingResult {
  binding: RepresentativeOrganization & {
    organization: { canonicalName: string } | null;
  };
  warnings: BindingWarningCode[];
  isNewOrg: boolean;
}

/**
 * Submit an organization binding request for the current representative.
 *
 * The actor is always a REPRESENTATIVE, so the result is always PENDING.
 * Supports two paths:
 * 1. Existing organization: select org + optional site.
 * 2. New organization: provide canonicalName, cannot specify site.
 *
 * For new organizations, creates OrganizationReviewTask + PENDING binding in
 * a single transaction with sourceId backfill.
 */
export async function requestOrganizationBindingForSelf(params: {
  userId: string;
  userEmail: string;
  role: string;
  organizationId?: string;
  canonicalName?: string;
  organizationSiteId?: string;
}): Promise<RequestOrganizationBindingResult> {
  const { userId, userEmail, role } = params;

  if (!params.organizationId && !params.canonicalName) {
    throw new Error("organizationId 或 canonicalName 至少需要一个");
  }

  const siteId = params.organizationSiteId?.trim() || null;
  const isSales = role === "REPRESENTATIVE" || isRegionalManagerRole(role);

  // Resolve own representative
  if (!userEmail) {
    throw new Error("当前账号无邮箱，无法解析代表");
  }
  const repId = await getRepresentativeIdByUserEmail(userEmail);
  if (!repId) {
    throw new Error("Representative not found");
  }

  // Representative self-service: ALWAYS PENDING (never auto-ACTIVE)
  const status = "PENDING";
  let warningCodes: BindingWarningCode[] = [];

  let orgId: string | null = params.organizationId || null;
  let requestedOrgName: string | null = null;
  let requestedOrganizationNormalizedName: string | null = null;

  // If canonicalName provided and no orgId, try to resolve
  if (!orgId && params.canonicalName?.trim()) {
    const resolved = await resolveOrganization(params.canonicalName.trim());
    if (resolved.status === "exact" && resolved.organizationId) {
      orgId = resolved.organizationId;
    } else {
      // New org path
      const newRequestedOrgName = params.canonicalName.trim();
      const newRequestedOrgNormalizedName = normalizeOrgName(newRequestedOrgName);
      if (siteId) {
        throw new Error("新单位绑定申请不能指定院区");
      }
      requestedOrgName = newRequestedOrgName;
      requestedOrganizationNormalizedName = newRequestedOrgNormalizedName;
      warningCodes = await collectRequestedNameWarnings(repId, newRequestedOrgNormalizedName);

      // Dedup: check existing pending new-org request for same rep + normalized name
      const existingPending = await prisma.representativeOrganization.findFirst({
        where: {
          representativeId: repId,
          organizationId: null,
          requestedOrganizationNormalizedName: newRequestedOrgNormalizedName,
          status: "PENDING",
        },
      });
      if (existingPending) {
        throw new Error("该单位绑定申请已存在，正在等待审核");
      }

      let newBinding: RepresentativeOrganization & { organization: { canonicalName: string } | null };
      try {
        newBinding = await prisma.$transaction(async (tx) => {
          const task = await tx.organizationReviewTask.create({
            data: {
              rawInput: newRequestedOrgName,
              normalizedInput: newRequestedOrgNormalizedName,
              status: "PENDING",
              sourceType: "REP_ORG_BINDING_REQUEST",
              sourceId: "",
            },
          });

          const created = await tx.representativeOrganization.create({
            data: {
              representativeId: repId,
              organizationId: null,
              organizationSiteId: null,
              requestedOrganizationName: newRequestedOrgName,
              requestedOrganizationNormalizedName: newRequestedOrgNormalizedName,
              organizationReviewTaskId: task.id,
              status: "PENDING",
              source: isSales ? "REP_REQUEST" : "MANUAL",
              requestedByUserId: userId,
            },
            include: { organization: { select: { canonicalName: true } } },
          });

          await tx.organizationReviewTask.update({
            where: { id: task.id },
            data: { sourceId: created.id },
          });

          return created;
        });
      } catch (e: unknown) {
        const isPrismaUnique = typeof e === "object" && e !== null && "code" in e && (e as { code: string }).code === "P2002";
        if (isPrismaUnique) {
          throw new Error("绑定已存在");
        }
        throw e;
      }

      notifyBindingReviewers(newBinding.id, repId, newRequestedOrgName, warningCodes).catch(() => {});

      return { binding: newBinding, warnings: warningCodes, isNewOrg: true };
    }
  }

  // Existing-org flow
  if (orgId) {
    const scopeValidation = await validateRepresentativeBindingScope(prisma, orgId, siteId);
    if (!scopeValidation.ok) {
      throw new Error(scopeValidation.error);
    }

    warningCodes = await collectExistingOrgWarnings(repId, orgId, siteId);

    const existing = await findRepresentativeBindingByScope(prisma, {
      representativeId: repId,
      organizationId: orgId,
      organizationSiteId: siteId ?? null,
    });
    if (existing) {
      if (existing.status === "REJECTED" || existing.status === "ARCHIVED") {
        const updated = await prisma.representativeOrganization.update({
          where: { id: existing.id },
          data: {
            status,
            isPrimary: false, // PENDING is never primary
            reviewNote: null,
            reviewedByUserId: null,
            reviewedAt: null,
          },
          include: { organization: { select: { canonicalName: true } } },
        });
        notifyBindingReviewers(updated.id, repId, updated.organization?.canonicalName || orgId, warningCodes).catch(() => {});
        return { binding: updated, warnings: warningCodes, isNewOrg: false };
      }
      throw new Error("绑定已存在");
    }

    const hasExistingActive = await hasActiveBindingAtLevel(prisma, orgId, siteId ?? null);
    const isPrimary = !hasExistingActive;

    let binding: RepresentativeOrganization & { organization: { canonicalName: string } | null };
    try {
      binding = await prisma.representativeOrganization.create({
        data: {
          representativeId: repId,
          organizationId: orgId,
          organizationSiteId: siteId,
          isPrimary,
          requestedOrganizationName: requestedOrgName,
          requestedOrganizationNormalizedName,
          organizationReviewTaskId: null,
          status,
          source: isSales ? "REP_REQUEST" : "MANUAL",
          requestedByUserId: userId,
        },
        include: { organization: { select: { canonicalName: true } } },
      });
    } catch (e: unknown) {
      const isPrismaUnique = typeof e === "object" && e !== null && "code" in e && (e as { code: string }).code === "P2002";
      if (isPrismaUnique) {
        throw new Error("绑定已存在");
      }
      throw e;
    }

    const orgDisplayName = binding.organization?.canonicalName || requestedOrgName || orgId;
    notifyBindingReviewers(binding.id, repId, orgDisplayName, warningCodes).catch(() => {});

    return { binding, warnings: warningCodes, isNewOrg: false };
  }

  throw new Error("无法解析单位信息");
}

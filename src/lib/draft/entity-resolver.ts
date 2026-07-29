/**
 * Entity resolution for draft fields.
 * Matches LLM-extracted text values against existing DB records
 * before writing IDs into the draft.
 */

import { prisma } from "@/lib/prisma";
import { resolveOrganization } from "@/lib/organization-resolver";
import { getCustomerOrganizationName } from "@/lib/customer-organization";

export interface EntityMatch {
  id: string;
  name: string;
  extra?: Record<string, string | null>;
  confidence: number;
}

export interface EntityResolution {
  status: "exact" | "candidate" | "unmatched";
  match?: EntityMatch;
  candidates?: EntityMatch[];
  rawText: string;
}

/**
 * Resolve an organization name against master data.
 * Wraps the existing resolveOrganization() pipeline.
 */
export async function resolveOrgEntity(rawText: string): Promise<EntityResolution> {
  if (!rawText.trim()) return { status: "unmatched", rawText };

  const result = await resolveOrganization(rawText);

  if (result.status === "exact" && result.organizationId) {
    return {
      status: "exact",
      match: {
        id: result.organizationId,
        name: result.canonicalName || rawText,
        extra: { address: result.address },
        confidence: 1.0,
      },
      rawText,
    };
  }

  if (result.status === "candidate" && result.candidates.length > 0) {
    return {
      status: "candidate",
      candidates: result.candidates.map((c) => ({
        id: c.organizationId,
        name: c.canonicalName,
        extra: { address: c.address },
        confidence: c.confidence,
      })),
      rawText,
    };
  }

  return { status: "unmatched", rawText };
}

/**
 * Resolve a customer name against existing customers.
 * Uses name contains search. orgHint narrows results when available.
 */
export async function resolveCustomerEntity(
  rawText: string,
  orgHint?: string,
): Promise<EntityResolution> {
  if (!rawText.trim()) return { status: "unmatched", rawText };

  const trimmed = rawText.trim();

  // Search by name — exact first, then contains（Profile-only：直接查 CrmCustomerProfile）
  const profiles = await prisma.crmCustomerProfile.findMany({
    where: {
      deleted: false,
      archived: false,
      mergedIntoProfileId: null,
      name: { contains: trimmed },
    },
    select: {
      id: true,
      name: true,
      organization: true,
      organizationId: true,
      org: { select: { canonicalName: true } },
    },
    take: 10,
    orderBy: { name: "asc" },
  });

  if (profiles.length === 0) return { status: "unmatched", rawText };

  const resolved = profiles.map((p) => {
    return {
      id: p.id,
      name: p.name ?? null,
      organization: getCustomerOrganizationName({
        organization: p.organization ?? null,
        org: p.org,
      }),
      organizationId: p.organizationId ?? null,
    };
  });

  // Check for exact name match
  const exactMatches = resolved.filter((c) => c.name === trimmed);

  if (exactMatches.length === 1) {
    const c = exactMatches[0];
    return {
      status: "exact",
      match: {
        id: c.id,
        name: c.name ?? "未命名客户",
        extra: { organization: c.organization, organizationId: c.organizationId },
        confidence: 1.0,
      },
      rawText,
    };
  }

  // If orgHint is available, try to narrow down
  if (orgHint && exactMatches.length > 1) {
    const orgFiltered = exactMatches.filter(
      (c) => c.organization && c.organization.includes(orgHint),
    );
    if (orgFiltered.length === 1) {
      const c = orgFiltered[0];
      return {
        status: "exact",
        match: {
          id: c.id,
          name: c.name ?? "未命名客户",
          extra: { organization: c.organization, organizationId: c.organizationId },
          confidence: 0.9,
        },
        rawText,
      };
    }
  }

  // Multiple matches or only fuzzy matches → candidates
  const candidateList = (exactMatches.length > 0 ? exactMatches : resolved).slice(0, 5);
  return {
    status: "candidate",
    candidates: candidateList.map((c) => ({
      id: c.id,
      name: c.name ?? "未命名客户",
      extra: { organization: c.organization, organizationId: c.organizationId },
      confidence: exactMatches.some((e) => e.id === c.id) ? 0.8 : 0.6,
    })),
    rawText,
  };
}

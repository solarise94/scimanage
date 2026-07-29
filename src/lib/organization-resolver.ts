import { prisma } from "@/lib/prisma";
import { normalizeOrgName } from "@/lib/organization-normalize";

export interface ResolveResult {
  status: "exact" | "candidate" | "unmatched";
  organizationId: string | null;
  organizationSiteId: string | null;
  canonicalName: string | null;
  siteName: string | null;
  address: string | null;
  candidates: Array<{
    organizationId: string;
    organizationSiteId: string | null;
    canonicalName: string;
    siteName: string | null;
    address: string | null;
    confidence: number;
    source: "db";
  }>;
  source: "db" | "none";
  rawInput: string;
  normalizedInput: string;
  reviewRequired: boolean;
  bestSuggestion: {
    organizationId: string | null;
    organizationSiteId: string | null;
    canonicalName: string | null;
    siteName: string | null;
    address: string | null;
    confidence: number | null;
    source: "db" | "none";
  } | null;
}

/**
 * Resolve a raw organization input to structured master data.
 *
 * Resolution order:
 * 1. Exact match on canonicalName / normalizedName
 * 2. Exact match on alias (normalizedAlias)
 * 3. Fuzzy match on canonicalName / alias (contains)
 * 4. If no local match, return unmatched and let humans handle review or manual build
 */
export async function resolveOrganization(rawInput: string): Promise<ResolveResult> {
  const normalized = normalizeOrgName(rawInput);
  if (!normalized) {
    return finalize(rawInput, normalized, baseEmpty());
  }

  const result = await resolveInternal(rawInput, normalized);
  return finalize(rawInput, normalized, result);
}

/** Compute reviewRequired and bestSuggestion from base result */
function finalize(rawInput: string, normalizedInput: string, base: BaseResult): ResolveResult {
  const reviewRequired = base.status !== "exact";
  let bestSuggestion: ResolveResult["bestSuggestion"] = null;

  if (base.status === "exact") {
    bestSuggestion = {
      organizationId: base.organizationId,
      organizationSiteId: base.organizationSiteId,
      canonicalName: base.canonicalName,
      siteName: base.siteName,
      address: base.address,
      confidence: 1.0,
      source: base.source,
    };
  } else if (base.candidates.length > 0) {
    const c = base.candidates[0];
    bestSuggestion = {
      organizationId: c.organizationId,
      organizationSiteId: c.organizationSiteId,
      canonicalName: c.canonicalName,
      siteName: c.siteName,
      address: c.address,
      confidence: c.confidence,
      source: c.source,
    };
  }

  return { ...base, rawInput, normalizedInput, reviewRequired, bestSuggestion };
}

type BaseResult = Omit<ResolveResult, "rawInput" | "normalizedInput" | "reviewRequired" | "bestSuggestion">;

function baseEmpty(): BaseResult {
  return {
    status: "unmatched",
    organizationId: null,
    organizationSiteId: null,
    canonicalName: null,
    siteName: null,
    address: null,
    candidates: [],
    source: "none",
  };
}

async function resolveInternal(rawInput: string, normalized: string): Promise<BaseResult> {

  // --- Step 1: Exact match on Organization.canonicalName / normalizedName ---
  const exactOrg = await prisma.organization.findFirst({
    where: {
      deleted: false,
      archived: false,
      OR: [
        { normalizedName: normalized },
        { canonicalName: rawInput.trim() },
      ],
    },
    include: { sites: { where: { archived: false } } },
  });

  if (exactOrg) {
    const site = extractSite(rawInput, exactOrg.sites);
    return {
      status: "exact",
      organizationId: exactOrg.id,
      organizationSiteId: site?.id || null,
      canonicalName: exactOrg.canonicalName,
      siteName: site?.siteName || null,
      address: site?.address || exactOrg.address,
      candidates: [],
      source: "db",
    };
  }

  // --- Step 2: Exact match on alias ---
  const exactAlias = await prisma.organizationAlias.findFirst({
    where: {
      normalizedAlias: normalized,
      approved: true,
      organization: { deleted: false, archived: false },
    },
    include: {
      organization: {
        include: { sites: { where: { archived: false } } },
      },
    },
  });

  if (exactAlias) {
    const org = exactAlias.organization;
    const site = extractSite(rawInput, org.sites);
    return {
      status: "exact",
      organizationId: org.id,
      organizationSiteId: site?.id || null,
      canonicalName: org.canonicalName,
      siteName: site?.siteName || null,
      address: site?.address || org.address,
      candidates: [],
      source: "db",
    };
  }

  // --- Step 3: Fuzzy match (contains) on canonicalName / alias ---
  const fuzzyOrgs = await prisma.organization.findMany({
    where: {
      deleted: false,
      archived: false,
      OR: [
        { normalizedName: { contains: normalized } },
        { canonicalName: { contains: rawInput.trim() } },
        { aliases: { some: { normalizedAlias: { contains: normalized }, approved: true } } },
      ],
    },
    include: { sites: { where: { archived: false } } },
    take: 5,
  });

  if (fuzzyOrgs.length > 0) {
    const candidates = fuzzyOrgs.map((org) => {
      const site = extractSite(rawInput, org.sites);
      return {
        organizationId: org.id,
        organizationSiteId: site?.id || null,
        canonicalName: org.canonicalName,
        siteName: site?.siteName || null,
        address: site?.address || org.address,
        confidence: 0.7,
        source: "db" as const,
      };
    });

    // Fuzzy matches always require user confirmation — never auto-promote to exact
    return {
      status: "candidate",
      organizationId: null,
      organizationSiteId: null,
      canonicalName: null,
      siteName: null,
      address: null,
      candidates,
      source: "db",
    };
  }

  // --- Step 4: No local match ---
  return baseEmpty();
}

type SiteRecord = { id: string; siteName: string; normalizedSiteName: string; address: string | null };

function extractSite(rawInput: string, sites: SiteRecord[]): SiteRecord | null {
  if (sites.length === 0) return null;
  const normalized = normalizeOrgName(rawInput);
  // Check if input contains a site name
  for (const site of sites) {
    if (normalized.includes(site.normalizedSiteName) || rawInput.includes(site.siteName)) {
      return site;
    }
  }
  return null;
}

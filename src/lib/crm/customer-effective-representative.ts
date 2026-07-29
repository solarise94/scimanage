import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  resolveSystemRepresentative,
  REPRESENTATIVE_KIND,
} from "@/lib/crm/system-representative";
import { resolveRepIdsByUserIds } from "@/lib/crm/representative-scope";

type DbLike = typeof prisma | Prisma.TransactionClient;

const SALES_USER_ROLES = ["REPRESENTATIVE", "REGIONAL_MANAGER"];

export type EffectiveRepresentativeSource =
  | "EXPLICIT_ASSIGNMENT"
  | "SITE_BINDING"
  | "ORG_BINDING"
  | "SYSTEM_FALLBACK"
  | "NONE";

export type EffectiveProfileRepresentative = {
  profileId: string;
  representativeId: string | null;
  representativeName: string | null;
  ownerUserId: string | null;
  source: EffectiveRepresentativeSource;
  anchorAt: Date | null;
};

type BindingInfo = {
  representativeId: string;
  isPrimary: boolean;
  reviewedAt: Date | null;
  createdAt: Date;
};

type ProfileBindingRow = {
  id: string;
  createdAt: Date;
  organizationId: string | null;
  organizationSiteId: string | null;
};

type ProfileExplicitRow = {
  id: string;
  ownerUserId: string | null;
  createdAt: Date;
};

function noneProfileResult(profileId: string): EffectiveProfileRepresentative {
  return {
    profileId,
    representativeId: null,
    representativeName: null,
    ownerUserId: null,
    source: "NONE",
    anchorAt: null,
  };
}

/**
 * Explicit assignment: profile.ownerUserId → HUMAN sales rep (email bridge), else
 * active MANAGING tag (isPrimary first) with the same mapping. Overrides binding-derived
 * SITE/ORG when present — KPI 记到显式负责人。
 */
async function resolveExplicitAssignmentsForProfiles(
  profileRows: ProfileExplicitRow[],
  db: DbLike,
): Promise<Map<string, EffectiveProfileRepresentative>> {
  const result = new Map<string, EffectiveProfileRepresentative>();
  if (profileRows.length === 0) return result;

  const ownerUserIds = [...new Set(
    profileRows
      .map((p) => p.ownerUserId)
      .filter((id): id is string => id !== null),
  )];
  const userToRep = await resolveRepIdsByUserIds(ownerUserIds, db);
  const ownerRepIds = [...new Set(userToRep.values())];
  const ownerReps = ownerRepIds.length > 0
    ? await db.representative.findMany({
        where: {
          id: { in: ownerRepIds },
          archived: false,
          kind: REPRESENTATIVE_KIND.HUMAN,
        },
        select: { id: true, name: true },
      })
    : [];
  const ownerRepById = new Map(ownerReps.map((r) => [r.id, r]));

  const needsTagLookup: ProfileExplicitRow[] = [];
  for (const profile of profileRows) {
    const repId = profile.ownerUserId ? userToRep.get(profile.ownerUserId) : undefined;
    if (repId) {
      const rep = ownerRepById.get(repId);
      if (rep) {
        result.set(profile.id, {
          profileId: profile.id,
          representativeId: rep.id,
          representativeName: rep.name,
          ownerUserId: profile.ownerUserId,
          source: "EXPLICIT_ASSIGNMENT",
          anchorAt: profile.createdAt,
        });
        continue;
      }
    }
    needsTagLookup.push(profile);
  }

  if (needsTagLookup.length === 0) return result;

  const managingTags = await db.customerRepTag.findMany({
    where: {
      profileId: { in: needsTagLookup.map((p) => p.id) },
      tagType: "MANAGING",
      isActive: true,
    },
    select: {
      profileId: true,
      representativeId: true,
      isPrimary: true,
      startedAt: true,
    },
    orderBy: [{ isPrimary: "desc" }, { startedAt: "asc" }],
  });

  const tagByProfileId = new Map<string, (typeof managingTags)[number]>();
  for (const tag of managingTags) {
    if (!tagByProfileId.has(tag.profileId)) {
      tagByProfileId.set(tag.profileId, tag);
    }
  }

  const tagRepIds = [...new Set(managingTags.map((t) => t.representativeId))];
  const tagReps = tagRepIds.length > 0
    ? await db.representative.findMany({
        where: {
          id: { in: tagRepIds },
          archived: false,
          kind: REPRESENTATIVE_KIND.HUMAN,
        },
        select: { id: true, name: true, email: true },
      })
    : [];
  const tagRepById = new Map(tagReps.map((r) => [r.id, r]));

  const tagRepEmails = tagReps
    .map((r) => r.email)
    .filter((e): e is string => !!e);
  const tagRepUsers = tagRepEmails.length > 0
    ? await db.user.findMany({
        where: {
          email: { in: tagRepEmails },
          role: { in: SALES_USER_ROLES },
        },
        select: { id: true, email: true },
      })
    : [];
  const ownerUserIdByRepEmail = new Map(tagRepUsers.map((u) => [u.email, u.id]));

  for (const profile of needsTagLookup) {
    const tag = tagByProfileId.get(profile.id);
    if (!tag) continue;
    const rep = tagRepById.get(tag.representativeId);
    if (!rep?.email) continue;
    const ownerUserId = ownerUserIdByRepEmail.get(rep.email);
    if (!ownerUserId) continue;
    result.set(profile.id, {
      profileId: profile.id,
      representativeId: rep.id,
      representativeName: rep.name,
      ownerUserId,
      source: "EXPLICIT_ASSIGNMENT",
      anchorAt: tag.startedAt ?? profile.createdAt,
    });
  }

  return result;
}

/**
 * Core binding resolution for profile rows (SITE → ORG → SYSTEM_FALLBACK → NONE).
 * EXPLICIT_ASSIGNMENT is applied afterward and overrides SITE/ORG when present.
 */
async function resolveBindingsForProfileRows(
  profileRows: ProfileBindingRow[],
  db: DbLike,
): Promise<Map<string, EffectiveProfileRepresentative>> {
  const result = new Map<string, EffectiveProfileRepresentative>();
  for (const profile of profileRows) {
    result.set(profile.id, noneProfileResult(profile.id));
  }
  if (profileRows.length === 0) return result;

  const siteIds = [...new Set(
    profileRows
      .map((p) => p.organizationSiteId)
      .filter((id): id is string => !!id),
  )];

  const siteBindings = siteIds.length > 0
    ? await db.representativeOrganization.findMany({
        where: {
          organizationSiteId: { in: siteIds },
          status: "ACTIVE",
        },
        select: {
          organizationSiteId: true,
          representativeId: true,
          isPrimary: true,
          reviewedAt: true,
          createdAt: true,
        },
        orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
      })
    : [];

  const siteBindingMap = new Map<string, BindingInfo>();
  for (const binding of siteBindings) {
    if (!siteBindingMap.has(binding.organizationSiteId!)) {
      siteBindingMap.set(binding.organizationSiteId!, binding);
    }
  }

  const profilesNeedingOrgBinding = profileRows.filter((p) => {
    if (!p.organizationId) return false;
    if (p.organizationSiteId && siteBindingMap.has(p.organizationSiteId)) return false;
    return true;
  });

  const orgIds = [...new Set(
    profilesNeedingOrgBinding
      .map((p) => p.organizationId)
      .filter((id): id is string => !!id),
  )];

  const orgBindings = orgIds.length > 0
    ? await db.representativeOrganization.findMany({
        where: {
          organizationId: { in: orgIds },
          organizationSiteId: null,
          status: "ACTIVE",
        },
        select: {
          organizationId: true,
          representativeId: true,
          isPrimary: true,
          reviewedAt: true,
          createdAt: true,
        },
        orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
      })
    : [];

  const orgBindingMap = new Map<string, BindingInfo>();
  for (const binding of orgBindings) {
    if (!orgBindingMap.has(binding.organizationId!)) {
      orgBindingMap.set(binding.organizationId!, binding);
    }
  }

  const bindingRepIds = new Set<string>();
  for (const binding of siteBindings) bindingRepIds.add(binding.representativeId);
  for (const binding of orgBindings) bindingRepIds.add(binding.representativeId);

  const bindingReps = bindingRepIds.size > 0
    ? await db.representative.findMany({
        where: {
          id: { in: [...bindingRepIds] },
          archived: false,
          kind: REPRESENTATIVE_KIND.HUMAN,
        },
        select: { id: true, name: true, email: true },
      })
    : [];

  const bindingRepEmails = bindingReps
    .map((r) => r.email)
    .filter((e): e is string => !!e);

  const bindingRepUsers = bindingRepEmails.length > 0
    ? await db.user.findMany({
        where: {
          email: { in: bindingRepEmails },
          role: { in: SALES_USER_ROLES },
        },
        select: { id: true, email: true },
      })
    : [];

  const userIdByRepEmail = new Map(bindingRepUsers.map((u) => [u.email, u.id]));
  const repById = new Map(bindingReps.map((r) => [r.id, r]));

  for (const profile of profileRows) {
    let binding: BindingInfo | undefined;
    let source: EffectiveRepresentativeSource = "NONE";

    if (profile.organizationSiteId) {
      binding = siteBindingMap.get(profile.organizationSiteId);
      if (binding) source = "SITE_BINDING";
    }

    if (!binding && profile.organizationId) {
      binding = orgBindingMap.get(profile.organizationId);
      if (binding) source = "ORG_BINDING";
    }

    if (!binding) continue;

    const rep = repById.get(binding.representativeId);
    if (!rep || !rep.email) continue;

    const ownerUserId = userIdByRepEmail.get(rep.email);
    if (!ownerUserId) continue;

    const bindingAnchor = binding.reviewedAt ?? binding.createdAt;
    const profileCreatedAt = profile.createdAt ?? new Date(0);
    const anchorAt = bindingAnchor > profileCreatedAt ? bindingAnchor : profileCreatedAt;

    result.set(profile.id, {
      profileId: profile.id,
      representativeId: rep.id,
      representativeName: rep.name,
      ownerUserId,
      source,
      anchorAt,
    });
  }

  const stillNoneProfiles = profileRows.filter(
    (p) => result.get(p.id)?.source === "NONE",
  );
  if (stillNoneProfiles.length > 0) {
    const systemRep = await resolveSystemRepresentative(db);
    if (systemRep) {
      for (const profile of stillNoneProfiles) {
        result.set(profile.id, {
          profileId: profile.id,
          representativeId: systemRep.representativeId,
          representativeName: systemRep.representativeName,
          ownerUserId: systemRep.ownerUserId,
          source: "SYSTEM_FALLBACK",
          anchorAt: profile.createdAt ?? null,
        });
      }
    }
  }

  return result;
}

/**
 * Resolve the effective representative for a batch of CRM profiles.
 *
 * Resolution priority:
 * 1. EXPLICIT_ASSIGNMENT — profile.ownerUserId → HUMAN sales rep; else active MANAGING tag
 *    (isPrimary first), same email-bridge mapping. Overrides SITE/ORG for KPI attribution.
 * 2. SITE_BINDING — profile.organizationSiteId + ACTIVE HUMAN binding
 * 3. ORG_BINDING — profile.organizationId (no site hit) + ACTIVE org-level binding
 * 4. SYSTEM_FALLBACK — global 本部 representative
 * 5. NONE — no explicit owner/tag and no binding / usable 本部
 *
 * Supports Profile-only rows (sourceCustomerId may be null).
 * Performs a fixed number of queries regardless of batch size.
 */
export async function resolveEffectiveRepresentativesForProfiles(
  profileIds: string[],
  db: DbLike = prisma,
): Promise<Map<string, EffectiveProfileRepresentative>> {
  const uniqueIds = [...new Set(profileIds.filter(Boolean))];
  const result = new Map<string, EffectiveProfileRepresentative>();

  if (uniqueIds.length === 0) return result;

  for (const profileId of uniqueIds) {
    result.set(profileId, noneProfileResult(profileId));
  }

  const profiles = await db.crmCustomerProfile.findMany({
    where: {
      id: { in: uniqueIds },
      archived: false,
      deleted: false,
    },
    select: {
      id: true,
      ownerUserId: true,
      createdAt: true,
      organizationId: true,
      organizationSiteId: true,
    },
  });

  const bindingResolved = await resolveBindingsForProfileRows(profiles, db);
  const explicitResolved = await resolveExplicitAssignmentsForProfiles(profiles, db);

  for (const profile of profiles) {
    const explicit = explicitResolved.get(profile.id);
    if (explicit) {
      result.set(profile.id, explicit);
    } else {
      result.set(profile.id, bindingResolved.get(profile.id) ?? noneProfileResult(profile.id));
    }
  }

  return result;
}

export type EffectiveOrgRepresentative = {
  representativeId: string | null;
  representativeName: string | null;
  ownerUserId: string | null;
  source: EffectiveRepresentativeSource;
};

/**
 * Resolve the effective representative directly from an organization/site pair,
 * WITHOUT requiring a Customer/Profile row to already exist.
 *
 * Phase D / W6.9：Profile-only 创建路径（createCrmCustomerProfile）在 Profile 尚不存在时
 * 就需要解析 owner。直接复用 SITE_BINDING > ORG_BINDING > SYSTEM_FALLBACK > NONE。
 */
export async function resolveEffectiveRepresentativeForOrg(
  organizationId: string | null | undefined,
  organizationSiteId: string | null | undefined,
  db: DbLike = prisma,
): Promise<EffectiveOrgRepresentative> {
  const none: EffectiveOrgRepresentative = {
    representativeId: null,
    representativeName: null,
    ownerUserId: null,
    source: "NONE",
  };

  if (organizationSiteId) {
    const siteBinding = await db.representativeOrganization.findFirst({
      where: { organizationSiteId, status: "ACTIVE" },
      select: { representativeId: true },
      orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
    });
    if (siteBinding) {
      const resolved = await resolveOwnerForRepresentativeId(siteBinding.representativeId, db);
      if (resolved) return { ...resolved, source: "SITE_BINDING" };
    }
  }

  if (organizationId) {
    const orgBinding = await db.representativeOrganization.findFirst({
      where: { organizationId, organizationSiteId: null, status: "ACTIVE" },
      select: { representativeId: true },
      orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
    });
    if (orgBinding) {
      const resolved = await resolveOwnerForRepresentativeId(orgBinding.representativeId, db);
      if (resolved) return { ...resolved, source: "ORG_BINDING" };
    }
  }

  const systemRep = await resolveSystemRepresentative(db);
  if (systemRep) {
    return {
      representativeId: systemRep.representativeId,
      representativeName: systemRep.representativeName,
      ownerUserId: systemRep.ownerUserId,
      source: "SYSTEM_FALLBACK",
    };
  }

  return none;
}

async function resolveOwnerForRepresentativeId(
  representativeId: string,
  db: DbLike,
): Promise<{ representativeId: string; representativeName: string; ownerUserId: string } | null> {
  const rep = await db.representative.findUnique({
    where: { id: representativeId },
    select: { id: true, name: true, email: true, archived: true, kind: true },
  });
  if (!rep || rep.archived || rep.kind !== REPRESENTATIVE_KIND.HUMAN || !rep.email) return null;

  const user = await db.user.findFirst({
    where: { email: rep.email, role: { in: SALES_USER_ROLES } },
    select: { id: true },
  });
  if (!user) return null;

  return { representativeId: rep.id, representativeName: rep.name, ownerUserId: user.id };
}

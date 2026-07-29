/**
 * 代表绩效统计 scope 封装
 *
 * 所有代表绩效统计（主表、详情、周报）的归属来源必须是
 * `resolveEffectiveRepresentativesForProfiles`（EXPLICIT → SITE → ORG → SYSTEM），
 * 禁止直接使用 Customer 旧业务字段或绕过 resolver 读裸 ownerUserId。
 *
 * Scope 只认 `profileIds`（含 Profile-only）。
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  resolveEffectiveRepresentativesForProfiles,
  type EffectiveProfileRepresentative,
} from "@/lib/crm/customer-effective-representative";
import { buildCrmProfileCustomerView } from "@/lib/customers/customer-business-fields";
import type { CrmProfileCustomerView } from "@/lib/customers/customer-business-fields";

export type RepresentativePerformanceScope = {
  representativeId: string;
  /** Linked sales user id (null when email bridge is broken). */
  ownerUserId: string | null;
  /** Non-archived CRM profile ids effectively owned by this representative. */
  profileIds: string[];
  /** Map profileId → customerView. */
  profileById: Map<string, { profileId: string; customerView: CrmProfileCustomerView }>;
  /** Effective representative info per profileId（含 Profile-only）。 */
  effectiveByProfileId: Map<string, EffectiveProfileRepresentative>;
};

/** Scope 构建只需解析 customerView 的轻量字段，避免全库完整 include。 */
const scopeProfileSelect = {
  id: true,
  archived: true,
  name: true,
  customerCode: true,
  nameDisambiguator: true,
  principal: true,
  labOrGroup: true,
  phone: true,
  wechat: true,
  email: true,
  miniProgramId: true,
  address: true,
  addressNote: true,
  receiverPhone: true,
  receiverAddress: true,
  organization: true,
  organizationId: true,
  organizationSiteId: true,
  organizationRawInput: true,
  personCategory: true,
  jobTitle: true,
  graduationDate: true,
  stage: true,
  importance: true,
  summary: true,
  org: { select: { id: true, canonicalName: true } },
  orgSite: { select: { id: true, siteName: true, siteType: true } },
  ownerUser: { select: { id: true, name: true } },
} satisfies Prisma.CrmCustomerProfileSelect;

/**
 * 单代表 scope 候选并集（允许超集，禁止假阴性）：
 * 1) ownerUserId = linked sales user
 * 2) active MANAGING tag → 该 representativeId
 * 3) ACTIVE 机构/站点绑定 → 同 org/site 的 ASSIGNED profiles
 *
 * 最终归属仍由 resolveEffectiveRepresentativesForProfiles 复核。
 * 不得只按 ownerUserId 收窄（会漏 SITE/ORG_BINDING）。
 */
export async function collectCandidateProfileIdsForRepresentative(
  representativeId: string,
  linkedUserId: string | null,
): Promise<string[]> {
  const ids = new Set<string>();

  const baseProfileWhere = {
    archived: false,
    deleted: false,
    assignmentStatus: "ASSIGNED" as const,
  };

  const [ownerRows, tagRows, bindings] = await Promise.all([
    linkedUserId
      ? prisma.crmCustomerProfile.findMany({
          where: { ...baseProfileWhere, ownerUserId: linkedUserId },
          select: { id: true },
        })
      : Promise.resolve([] as Array<{ id: string }>),
    prisma.customerRepTag.findMany({
      where: {
        representativeId,
        tagType: "MANAGING",
        isActive: true,
      },
      select: { profileId: true },
    }),
    prisma.representativeOrganization.findMany({
      where: { representativeId, status: "ACTIVE" },
      select: { organizationId: true, organizationSiteId: true },
    }),
  ]);

  for (const row of ownerRows) ids.add(row.id);
  for (const row of tagRows) {
    if (row.profileId) ids.add(row.profileId);
  }

  if (bindings.length > 0) {
    const siteIds = [
      ...new Set(
        bindings
          .map((b) => b.organizationSiteId)
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    const orgIds = [
      ...new Set(
        bindings
          .map((b) => b.organizationId)
          .filter((id): id is string => Boolean(id)),
      ),
    ];

    const orgOr: Prisma.CrmCustomerProfileWhereInput[] = [];
    if (siteIds.length > 0) {
      orgOr.push({ organizationSiteId: { in: siteIds } });
    }
    if (orgIds.length > 0) {
      // org-level binding applies when site is null on binding; profiles may still have site
      // resolver 会按 SITE then ORG 复核，这里取 org 下全部 ASSIGNED 作为超集候选
      orgOr.push({ organizationId: { in: orgIds } });
    }

    if (orgOr.length > 0) {
      const orgProfiles = await prisma.crmCustomerProfile.findMany({
        where: {
          ...baseProfileWhere,
          OR: orgOr,
        },
        select: { id: true },
      });
      for (const row of orgProfiles) ids.add(row.id);
    }
  }

  // tag 命中的 profile 可能已 RECALLED/archived：只保留活动 ASSIGNED
  if (ids.size === 0) return [];
  const active = await prisma.crmCustomerProfile.findMany({
    where: {
      id: { in: [...ids] },
      ...baseProfileWhere,
    },
    select: { id: true },
  });
  return active.map((p) => p.id);
}

/**
 * Build the performance scope for a single representative.
 * 候选并集收窄后做 effective 解析，再回填本代表名下的轻量 Profile 行。
 */
export async function buildRepresentativePerformanceScope(
  representativeId: string,
): Promise<RepresentativePerformanceScope> {
  const rep = await prisma.representative.findUnique({
    where: { id: representativeId },
    select: { email: true },
  });

  const linkedUser = rep?.email
    ? await prisma.user.findFirst({
        where: { email: rep.email },
        select: { id: true },
      })
    : null;

  const candidateIds = await collectCandidateProfileIdsForRepresentative(
    representativeId,
    linkedUser?.id ?? null,
  );

  const profileEffectiveMap = await resolveEffectiveRepresentativesForProfiles(candidateIds);

  const ownedProfileIds = candidateIds.filter(
    (id) => profileEffectiveMap.get(id)?.representativeId === representativeId,
  );

  const ownedProfiles =
    ownedProfileIds.length > 0
      ? await prisma.crmCustomerProfile.findMany({
          where: { id: { in: ownedProfileIds } },
          select: scopeProfileSelect,
        })
      : [];

  const scope: RepresentativePerformanceScope = {
    representativeId,
    ownerUserId: linkedUser?.id ?? null,
    profileIds: [],
    profileById: new Map(),
    effectiveByProfileId: new Map(),
  };

  for (const profile of ownedProfiles) {
    const effective = profileEffectiveMap.get(profile.id);
    if (!effective) continue;
    scope.profileIds.push(profile.id);
    scope.effectiveByProfileId.set(profile.id, effective);
    scope.profileById.set(profile.id, {
      profileId: profile.id,
      // buildCrmProfileCustomerView 只依赖业务字段；scope select 已覆盖
      customerView: buildCrmProfileCustomerView(profile as never),
    });
  }

  return scope;
}

export type PerformanceScopeGroup = {
  representativeId: string;
  ownerUserId: string | null;
  profileIds: string[];
  profileById: Map<string, { profileId: string; customerView: CrmProfileCustomerView }>;
  effectiveByProfileId: Map<string, EffectiveProfileRepresentative>;
};

export async function groupProfileIdsByEffectiveOwnerForRepresentatives(
  representatives: Array<{ representativeId: string; linkedUserId: string | null }>,
): Promise<Map<string, string[]>> {
  const groups = new Map(representatives.map((rep) => [rep.representativeId, [] as string[]]));
  if (representatives.length === 0) return groups;

  const candidateSets = await Promise.all(
    representatives.map(async (rep) => ({
      representativeId: rep.representativeId,
      profileIds: await collectCandidateProfileIdsForRepresentative(
        rep.representativeId,
        rep.linkedUserId,
      ),
    })),
  );
  const candidateIds = [...new Set(candidateSets.flatMap((item) => item.profileIds))];
  const effectiveByProfileId = await resolveEffectiveRepresentativesForProfiles(candidateIds);
  const allowedRepresentativeIds = new Set(representatives.map((rep) => rep.representativeId));

  for (const profileId of candidateIds) {
    const representativeId = effectiveByProfileId.get(profileId)?.representativeId;
    if (!representativeId || !allowedRepresentativeIds.has(representativeId)) continue;
    groups.get(representativeId)?.push(profileId);
  }
  return groups;
}

export async function groupPerformanceScopesByEffectiveOwner(): Promise<
  Map<string, PerformanceScopeGroup>
> {
  const candidateIds = (
    await prisma.crmCustomerProfile.findMany({
      where: { archived: false, deleted: false, assignmentStatus: "ASSIGNED" },
      select: { id: true },
    })
  ).map((p) => p.id);

  const profileEffectiveMap = await resolveEffectiveRepresentativesForProfiles(candidateIds);

  const ownedByRep = new Map<string, string[]>();
  for (const profileId of candidateIds) {
    const effective = profileEffectiveMap.get(profileId);
    if (!effective?.representativeId) continue;
    const list = ownedByRep.get(effective.representativeId) ?? [];
    list.push(profileId);
    ownedByRep.set(effective.representativeId, list);
  }

  const allOwnedIds = [...ownedByRep.values()].flat();
  const ownedProfiles =
    allOwnedIds.length > 0
      ? await prisma.crmCustomerProfile.findMany({
          where: { id: { in: allOwnedIds } },
          select: scopeProfileSelect,
        })
      : [];
  const profileRowById = new Map(ownedProfiles.map((p) => [p.id, p]));

  const groups = new Map<string, PerformanceScopeGroup>();

  const ensureGroup = (
    representativeId: string,
    ownerUserId: string | null,
  ): PerformanceScopeGroup => {
    const existing = groups.get(representativeId);
    if (existing) return existing;
    const created: PerformanceScopeGroup = {
      representativeId,
      ownerUserId,
      profileIds: [],
      profileById: new Map(),
      effectiveByProfileId: new Map(),
    };
    groups.set(representativeId, created);
    return created;
  };

  for (const [representativeId, profileIds] of ownedByRep) {
    for (const profileId of profileIds) {
      const effective = profileEffectiveMap.get(profileId);
      if (!effective) continue;
      const profile = profileRowById.get(profileId);
      if (!profile) continue;
      const group = ensureGroup(representativeId, effective.ownerUserId);
      group.profileIds.push(profileId);
      group.effectiveByProfileId.set(profileId, effective);
      group.profileById.set(profileId, {
        profileId,
        customerView: buildCrmProfileCustomerView(profile as never),
      });
    }
  }

  return groups;
}

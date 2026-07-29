import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  resolveEffectiveRepresentativeForOrg,
  resolveEffectiveRepresentativesForProfiles,
} from "@/lib/crm/customer-effective-representative";
import { resolveRepresentativeForOwnerUserId } from "@/lib/crm/customer-owner-representative";

type DbLike = typeof prisma | Prisma.TransactionClient;

/** 冻结：deleted / archived / merged / RECALLED / RECALL_CANDIDATE 一律不同步代表缓存。 */
const FROZEN_ASSIGNMENT_STATUSES = ["RECALLED", "RECALL_CANDIDATE"];

export const PROFILE_SYNC_ASSIGNABLE_WHERE = {
  deleted: false,
  archived: false,
  mergedIntoProfileId: null,
  assignmentStatus: { notIn: FROZEN_ASSIGNMENT_STATUSES },
};

/** Org 批量仅处理活动 UNASSIGNED（已 ASSIGNED 的显式负责人不在此函数覆盖范围内）。 */
export const PROFILE_ORG_BATCH_SYNC_WHERE = {
  deleted: false,
  archived: false,
  mergedIntoProfileId: null,
  assignmentStatus: "UNASSIGNED" as const,
};

export type SyncProfileRepresentativeResult = {
  representativeId: string | null;
  representativeName: string | null;
  skipped: boolean;
  reason?: "PROFILE_NOT_ASSIGNABLE" | "PROFILE_NOT_FOUND";
};

const SKIPPED_NOT_ASSIGNABLE: SyncProfileRepresentativeResult = {
  representativeId: null,
  representativeName: null,
  skipped: true,
  reason: "PROFILE_NOT_ASSIGNABLE",
};

/** Order/Project 写入时经 Profile relation 再次复核门禁（防读后竞态 recall）。 */
function activeAssignableOrderProjectWhere(profileId: string) {
  return {
    profileId,
    deleted: false,
    archived: false,
    profile: { ...PROFILE_SYNC_ASSIGNABLE_WHERE },
  };
}

function isAssignableStatus(status: string | null | undefined): boolean {
  return status !== "RECALLED" && status !== "RECALL_CANDIDATE";
}

function isActiveAssignableProfile(p: {
  deleted: boolean;
  archived: boolean;
  mergedIntoProfileId: string | null;
  assignmentStatus: string;
}): boolean {
  return (
    !p.deleted
    && !p.archived
    && p.mergedIntoProfileId == null
    && isAssignableStatus(p.assignmentStatus)
  );
}

function isBindingDerivedSource(source: string | null | undefined): boolean {
  return source === "SITE_BINDING" || source === "ORG_BINDING";
}

/**
 * 同步 Order/Project 代表缓存（只认 profileId）。
 *
 * 业务语义：
 * - 冻结 Profile → skipped + null（禁止把解析代表交给调用方）
 * - ASSIGNED → `resolveEffectiveRepresentativesForProfiles`（显式 owner / EXPLICIT 优先）；不改 owner
 * - UNASSIGNED → 仅机构/站点绑定解析；只有 SITE/ORG_BINDING 才写 owner 并升 ASSIGNED
 * - 只更新未删未归档且仍挂在可分配 Profile 上的 Order/Project
 */
export async function syncProfileRepresentativeLinks(
  profileId: string,
  db: DbLike = prisma,
  options?: { preserveOwnerUserId?: boolean },
): Promise<SyncProfileRepresentativeResult> {
  const profile = await db.crmCustomerProfile.findUnique({
    where: { id: profileId },
    select: {
      organizationId: true,
      organizationSiteId: true,
      deleted: true,
      archived: true,
      mergedIntoProfileId: true,
      assignmentStatus: true,
    },
  });
  if (!profile) {
    throw new Error(`syncProfileRepresentativeLinks: profile ${profileId} not found`);
  }
  if (!isActiveAssignableProfile(profile)) {
    return SKIPPED_NOT_ASSIGNABLE;
  }

  const rowWhere = activeAssignableOrderProjectWhere(profileId);

  // ASSIGNED：全量 effective（显式 owner 优先），避免机构绑定与 owner 分裂
  if (profile.assignmentStatus === "ASSIGNED") {
    const effMap = await resolveEffectiveRepresentativesForProfiles([profileId], db);
    const effective = effMap.get(profileId);
    const representativeId = effective?.representativeId ?? null;
    const representativeName = effective?.representativeName ?? null;

    await Promise.all([
      db.project.updateMany({
        where: rowWhere,
        data: { representativeId, representative: representativeName },
      }),
      db.order.updateMany({
        where: rowWhere,
        data: { representativeId },
      }),
    ]);

    // ASSIGNED 永不因机构 sync 改写 owner（preserveOwnerUserId 仅保留兼容参数）
    void options?.preserveOwnerUserId;

    return { representativeId, representativeName, skipped: false };
  }

  // UNASSIGNED：只按机构/站点绑定；SYSTEM_FALLBACK / NONE 不升 ASSIGNED、不写 owner
  const effective = await resolveEffectiveRepresentativeForOrg(
    profile.organizationId,
    profile.organizationSiteId,
    db,
  );
  const hasHumanBinding = isBindingDerivedSource(effective.source);

  await Promise.all([
    db.project.updateMany({
      where: rowWhere,
      data: {
        representativeId: effective.representativeId,
        representative: effective.representativeName,
      },
    }),
    db.order.updateMany({
      where: rowWhere,
      data: { representativeId: effective.representativeId },
    }),
  ]);

  if (hasHumanBinding && effective.ownerUserId && !options?.preserveOwnerUserId) {
    await db.crmCustomerProfile.updateMany({
      where: {
        id: profileId,
        ...PROFILE_ORG_BATCH_SYNC_WHERE,
      },
      data: { ownerUserId: effective.ownerUserId },
    });
  }

  if (hasHumanBinding) {
    await db.crmCustomerProfile.updateMany({
      where: {
        id: profileId,
        ...PROFILE_ORG_BATCH_SYNC_WHERE,
      },
      data: { assignmentStatus: "ASSIGNED", assignedAt: new Date() },
    });
  }

  return {
    representativeId: effective.representativeId,
    representativeName: effective.representativeName,
    skipped: false,
  };
}

/**
 * 显式负责人变更：只同步 Order/Project 代表字段，不覆盖 profile.ownerUserId。
 * 冻结 Profile 返回 skipped + null（不把解析代表交给调用方）。
 */
export async function syncProfileRepresentativeLinksFromOwner(
  profileId: string,
  ownerUserId: string | null | undefined,
  db: DbLike = prisma,
): Promise<SyncProfileRepresentativeResult> {
  const profile = await db.crmCustomerProfile.findUnique({
    where: { id: profileId },
    select: {
      deleted: true,
      archived: true,
      mergedIntoProfileId: true,
      assignmentStatus: true,
    },
  });
  if (!profile) {
    throw new Error(`syncProfileRepresentativeLinksFromOwner: profile ${profileId} not found`);
  }
  if (!isActiveAssignableProfile(profile)) {
    return SKIPPED_NOT_ASSIGNABLE;
  }

  const { representativeId, representativeName } = await resolveRepresentativeForOwnerUserId(ownerUserId, db);
  const projectRepData = {
    representativeId,
    representative: representativeName,
  };
  const orderRepData = { representativeId };
  const rowWhere = activeAssignableOrderProjectWhere(profileId);

  await Promise.all([
    db.project.updateMany({ where: rowWhere, data: projectRepData }),
    db.order.updateMany({ where: rowWhere, data: orderRepData }),
  ]);

  return { representativeId, representativeName, skipped: false };
}

/**
 * 客户池收回：owner 改挂本部，不按机构绑定回写，不把 RECALLED 改回 ASSIGNED。
 * Order/Project 代表字段只按 profileId 清空（限未删未归档行）。
 */
export async function clearProfileAssignmentOnRecall(
  profileId: string,
  db: DbLike = prisma,
): Promise<void> {
  const profile = await db.crmCustomerProfile.findUnique({
    where: { id: profileId },
    select: { id: true },
  });
  if (!profile) {
    throw new Error(`clearProfileAssignmentOnRecall: profile ${profileId} not found`);
  }

  const { resolveSystemRepresentative } = await import("@/lib/crm/system-representative");
  const systemRep = await resolveSystemRepresentative(db);
  if (!systemRep) {
    throw new Error("clearProfileAssignmentOnRecall: 本部系统代表未 seed，无法完成收回");
  }

  await db.crmCustomerProfile.update({
    where: { id: profileId },
    data: { ownerUserId: systemRep.ownerUserId },
  });

  const projectRepData = { representativeId: null as string | null, representative: null as string | null };
  const orderRepData = { representativeId: null as string | null };

  await Promise.all([
    db.project.updateMany({
      where: { profileId, deleted: false, archived: false },
      data: projectRepData,
    }),
    db.order.updateMany({
      where: { profileId, deleted: false, archived: false },
      data: orderRepData,
    }),
  ]);
}

/**
 * 机构绑定变更后：仅同步该机构（可选站点）下 **活动 UNASSIGNED** Profile。
 *
 * 语义（勿误解为「机构下全部 Profile」）：
 * - UNASSIGNED + SITE/ORG_BINDING → 可升 ASSIGNED，并写 Order/Project / owner
 * - SYSTEM_FALLBACK / NONE / 非 binding-derived → 本函数不写成「人工机构分配」
 * - 已 ASSIGNED 的显式负责人 → **不在本函数处理**
 * - RECALLED / RECALL_CANDIDATE / deleted / archived / merged → 完全冻结
 *
 * 一次 `resolveEffectiveRepresentativesForProfiles` 后只对 binding-derived 组批量更新。
 */
export async function syncEffectiveRepresentativeLinksForOrganization(
  params: {
    organizationId: string;
    organizationSiteId?: string | null;
    db?: DbLike;
  },
): Promise<number> {
  const { organizationId, organizationSiteId, db: dbArg } = params;
  const db = dbArg ?? prisma;

  const affectedProfiles = await db.crmCustomerProfile.findMany({
    where: {
      organizationId,
      ...(organizationSiteId ? { organizationSiteId } : {}),
      ...PROFILE_ORG_BATCH_SYNC_WHERE,
    },
    select: { id: true },
  });

  if (affectedProfiles.length === 0) return 0;

  const profileIds = affectedProfiles.map((p) => p.id);
  const effectiveMap = await resolveEffectiveRepresentativesForProfiles(profileIds, db);

  type Group = {
    profileIds: string[];
    ownerUserId: string | null;
    representativeName: string | null;
  };
  const repGroups = new Map<string | null, Group>();

  for (const profileId of profileIds) {
    const effective = effectiveMap.get(profileId);
    // 只处理真正机构/站点绑定派生的组，避免 stale EXPLICIT / SYSTEM_FALLBACK 被当成分配
    if (!isBindingDerivedSource(effective?.source)) continue;

    const repId = effective?.representativeId ?? null;
    const entry = repGroups.get(repId) ?? {
      profileIds: [],
      ownerUserId: effective?.ownerUserId ?? null,
      representativeName: effective?.representativeName ?? null,
    };
    if (effective?.ownerUserId) entry.ownerUserId = effective.ownerUserId;
    if (effective?.representativeName) entry.representativeName = effective.representativeName;
    entry.profileIds.push(profileId);
    repGroups.set(repId, entry);
  }

  let syncedProfiles = 0;
  for (const [repId, group] of repGroups) {
    syncedProfiles += group.profileIds.length;
    const assignableProfileFilter = {
      id: { in: group.profileIds },
      ...PROFILE_ORG_BATCH_SYNC_WHERE,
    };
    const orderProjectWhere = {
      profileId: { in: group.profileIds },
      deleted: false,
      archived: false,
      profile: { ...PROFILE_ORG_BATCH_SYNC_WHERE },
    };

    await Promise.all([
      db.project.updateMany({
        where: orderProjectWhere,
        data: { representativeId: repId, representative: group.representativeName },
      }),
      db.order.updateMany({
        where: orderProjectWhere,
        data: { representativeId: repId },
      }),
    ]);

    if (group.ownerUserId) {
      await db.crmCustomerProfile.updateMany({
        where: assignableProfileFilter,
        data: { ownerUserId: group.ownerUserId },
      });
    }
    await db.crmCustomerProfile.updateMany({
      where: assignableProfileFilter,
      data: { assignmentStatus: "ASSIGNED", assignedAt: new Date() },
    });
  }

  return syncedProfiles;
}

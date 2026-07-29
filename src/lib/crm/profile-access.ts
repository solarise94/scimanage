/**
 * CRM 部门访问解析（部门隔离设计 §6.6）。
 *
 * 三种访问级别：
 *   - FULL：本部门 CLAIMED（或 ADMIN），可读完整 DTO，可参与 CRM owner scope。
 *   - POOL：本部门公海（poolEntryReason != null）或跨部门共享公海
 *     （隐藏 POOL + ACTIVE 入站 CrmProfilePoolShare），只读脱敏 PoolProfileDto。
 *   - NONE：调用方统一转 404，不暴露共享身份是否存在。
 *
 * 集合查询拆分为：
 *   - getClaimedCrmVisibleProfileIds：本部门 CLAIMED，可进入完整详情与 owner scope。
 *   - getPoolCrmVisibleProfileIds：只用于公海列表/受限详情，
 *     绝不能并入 Order/Project/Finance/Contract/costing scope。
 *
 * 纯领域逻辑：不 import Next；所有函数接受可选 DbLike（默认 prisma 单例）。
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { BusinessActor } from "@/lib/application/actor";
import { NotFoundError, StaleStateError } from "@/lib/application/errors";
import { isDepartment, type Department } from "@/lib/department";
import {
  getAllowedOwnerIds,
  resolveRepIdsByUserIds,
} from "@/lib/crm/representative-scope";
import { resolveEffectiveRepresentativesForProfiles } from "@/lib/crm/customer-effective-representative";
import { getCustomerOrganizationName } from "@/lib/customer-organization";
import { toPublicProfile } from "@/lib/crm/public-dto";

type DbLike = typeof prisma | Prisma.TransactionClient;

export type CrmProfileAccessLevel = "FULL" | "POOL" | "NONE";

/** 具备 CRM 模块权限的角色（POOL 视图门槛；ADMIN 在 resolver 中先行短路为 FULL）。 */
const CRM_CAPABLE_ROLES = ["USER", "REPRESENTATIVE", "REGIONAL_MANAGER"] as const;

const SQLITE_PARAM_LIMIT = 900;

function chunkIds(ids: string[], limit: number): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += limit) chunks.push(ids.slice(i, i + limit));
  return chunks;
}

function isCrmCapableRole(role: string): boolean {
  return (CRM_CAPABLE_ROLES as readonly string[]).includes(role);
}

/**
 * 解析 actor 部门：优先 actor.department（JWT/调用方上下文），缺失时回源数据库。
 * 解析失败（用户不存在 / 非法部门值）返回 null —— fail-closed，调用方按 NONE/空集处理。
 */
export async function resolveActorDepartment(
  actor: Pick<BusinessActor, "userId"> & { department?: string | null },
  db: DbLike = prisma,
): Promise<Department | null> {
  if (isDepartment(actor.department)) return actor.department;
  const user = await db.user.findUnique({
    where: { id: actor.userId },
    select: { department: true },
  });
  if (!user || !isDepartment(user.department)) return null;
  return user.department;
}

/**
 * 单 profile 访问级别解析（§6.6 规则）：
 *   - ADMIN → FULL。
 *   - 本部门 state = CLAIMED → 按现有角色范围 FULL 或 NONE
 *     （USER 本部门已认领可见；Representative/RM 仍受 effective representative 范围限制）。
 *   - state = RECALL_CANDIDATE → 仅当前 owner（ADMIN 已短路）FULL，其他 NONE。
 *   - state = POOL 且 poolEntryReason != null（本部门公海）→ 具备 CRM 权限的本部门用户 POOL。
 *   - state = POOL 且 poolEntryReason = null 且存在 ACTIVE 入站共享授权 → POOL。
 *   - 其他 → NONE（含 profile 不存在/已删除、缺 state 行、无 CRM 权限角色）。
 */
export async function resolveCrmProfileAccess(
  input: { profileId: string; actor: BusinessActor },
  db: DbLike = prisma,
): Promise<CrmProfileAccessLevel> {
  const { profileId, actor } = input;

  const profile = await db.crmCustomerProfile.findUnique({
    where: { id: profileId },
    select: { id: true, deleted: true },
  });
  if (!profile || profile.deleted) return "NONE";

  if (actor.role === "ADMIN") return "FULL";

  const department = await resolveActorDepartment(actor, db);
  if (!department) return "NONE";

  const state = await db.crmProfileDepartmentState.findUnique({
    where: { profileId_department: { profileId, department } },
    select: { claimStatus: true, ownerUserId: true, poolEntryReason: true },
  });
  if (!state) return "NONE";

  if (state.claimStatus === "CLAIMED") {
    if (actor.role === "USER") return "FULL";
    if (actor.role === "REPRESENTATIVE" || actor.role === "REGIONAL_MANAGER") {
      const allowedOwners = await getAllowedOwnerIds(actor.userId, actor.role, db);
      if (allowedOwners.length === 0) return "NONE";
      const eff = (await resolveEffectiveRepresentativesForProfiles([profileId], db)).get(profileId);
      return eff?.ownerUserId && allowedOwners.includes(eff.ownerUserId) ? "FULL" : "NONE";
    }
    return "NONE";
  }

  if (state.claimStatus === "RECALL_CANDIDATE") {
    return state.ownerUserId === actor.userId ? "FULL" : "NONE";
  }

  // state.claimStatus === "POOL"
  if (!isCrmCapableRole(actor.role)) return "NONE";
  if (state.poolEntryReason != null) return "POOL";
  const inboundShare = await db.crmProfilePoolShare.findFirst({
    where: { profileId, targetDepartment: department, status: "ACTIVE" },
    select: { id: true },
  });
  return inboundShare ? "POOL" : "NONE";
}

// ─────────────────────────────────────────────────────────────────────────────
// DTO（§6.6 最小披露）
// ─────────────────────────────────────────────────────────────────────────────

export type PoolKind = "OWN_POOL" | "SHARED_POOL";

export type PoolDtoContext = {
  poolKind: PoolKind;
  poolEnteredAt: Date | null;
};

/**
 * 公海受限视图（§6.6 最小披露）。封闭接口：只允许以下字段，
 * 绝不包含 phone/wechat/email/详细地址、授权来源部门、另一部门 owner/state、
 * 互动数、订单数或成交金额。
 */
export interface PoolProfileDto {
  profileId: string;
  name: string | null;
  /** 机构展示名（canonicalName·siteName 或文本快照）。 */
  organization: string | null;
  /** 研究方向或标签（课题组 / 人员类别）。 */
  labOrGroup: string | null;
  personCategory: string | null;
  /** 进入公海时间：本部门公海取 releasedAt；跨部门共享公海取 ACTIVE 授权 min(sharedAt)。 */
  poolEnteredAt: Date | null;
  poolKind: PoolKind;
  /** 去重提示：客户编码后 6 位，便于录入人核对是否同一客户。 */
  dedupHint: string | null;
}

type PoolDtoProfileShape = {
  id: string;
  name?: string | null;
  customerCode?: string | null;
  organization?: string | null;
  labOrGroup?: string | null;
  personCategory?: string | null;
  org?: { canonicalName: string } | null;
  orgSite?: { siteName: string } | null;
};

/**
 * 按访问级别构造 DTO：
 *   - FULL → 完整 DTO，沿用现有客户详情序列化（toPublicProfile 直通）。
 *   - POOL → PoolProfileDto 最小披露 + 脱敏。
 *   - NONE → null，由调用方统一转 404。
 */
export function buildCrmProfileDto<T extends Record<string, unknown>>(
  profile: T,
  accessLevel: CrmProfileAccessLevel,
  context?: PoolDtoContext,
): T | PoolProfileDto | null {
  if (accessLevel === "NONE") return null;
  if (accessLevel === "FULL") {
    return toPublicProfile(profile);
  }
  const shape = profile as unknown as PoolDtoProfileShape;
  return {
    profileId: shape.id,
    name: shape.name ?? null,
    organization: getCustomerOrganizationName({
      organization: shape.organization ?? null,
      org: shape.org ?? null,
      orgSite: shape.orgSite ?? null,
    }),
    labOrGroup: shape.labOrGroup ?? null,
    personCategory: shape.personCategory ?? null,
    poolEnteredAt: context?.poolEnteredAt ?? null,
    poolKind: context?.poolKind ?? "SHARED_POOL",
    dedupHint: shape.customerCode ? shape.customerCode.slice(-6) : null,
  };
}

/**
 * 加载 POOL DTO 上下文：本部门公海取 state.releasedAt；跨部门共享公海取
 * ACTIVE 入站授权的 min(sharedAt)（未来多来源部门时保证排序稳定）。
 * 非 POOL 可见（隐藏 POOL 无授权 / 非 POOL 状态）返回 null。
 */
export async function loadPoolDtoContext(
  profileId: string,
  department: Department,
  db: DbLike = prisma,
): Promise<PoolDtoContext | null> {
  const state = await db.crmProfileDepartmentState.findUnique({
    where: { profileId_department: { profileId, department } },
    select: { claimStatus: true, poolEntryReason: true, releasedAt: true },
  });
  if (!state || state.claimStatus !== "POOL") return null;
  if (state.poolEntryReason != null) {
    return { poolKind: "OWN_POOL", poolEnteredAt: state.releasedAt };
  }
  const shares = await db.crmProfilePoolShare.findMany({
    where: { profileId, targetDepartment: department, status: "ACTIVE" },
    select: { sharedAt: true },
  });
  if (shares.length === 0) return null;
  const minSharedAt = shares.reduce(
    (min, s) => (s.sharedAt < min ? s.sharedAt : min),
    shares[0]!.sharedAt,
  );
  return { poolKind: "SHARED_POOL", poolEnteredAt: minSharedAt };
}

// ─────────────────────────────────────────────────────────────────────────────
// 集合查询（§6.6）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 本部门 CLAIMED 可见集合。
 *   - ADMIN → null（全量，沿用现有调用方 null=不限制 约定）。
 *   - USER → 本部门 CLAIMED 全部。
 *   - Representative/RM → 本部门 CLAIMED 且通过 effective representative 复核
 *     （候选：state owner / active MANAGING tag / 机构或站点绑定；
 *      终闸：effective resolver owner ∈ allowedOwners）。
 * Pool profileId 绝不包含在本集合内。
 */
export async function getClaimedCrmVisibleProfileIds(
  actor: BusinessActor,
  db: DbLike = prisma,
): Promise<string[] | null> {
  if (actor.role === "ADMIN") return null;

  const department = await resolveActorDepartment(actor, db);
  if (!department) return [];

  const activeProfile = { archived: false, deleted: false } as const;

  if (actor.role === "USER") {
    const states = await db.crmProfileDepartmentState.findMany({
      where: { department, claimStatus: "CLAIMED", profile: activeProfile },
      select: { profileId: true },
    });
    return states.map((s) => s.profileId);
  }

  if (actor.role !== "REPRESENTATIVE" && actor.role !== "REGIONAL_MANAGER") {
    return [];
  }

  const allowedOwners = await getAllowedOwnerIds(actor.userId, actor.role, db);
  if (allowedOwners.length === 0) return [];

  const claimedScope = { departmentStates: { some: { department, claimStatus: "CLAIMED" } } } as const;

  const candidateIds = new Set<string>();

  const ownedStates = await db.crmProfileDepartmentState.findMany({
    where: {
      department,
      claimStatus: "CLAIMED",
      ownerUserId: { in: allowedOwners },
      profile: activeProfile,
    },
    select: { profileId: true },
  });
  for (const s of ownedStates) candidateIds.add(s.profileId);

  const userToRep = await resolveRepIdsByUserIds(allowedOwners, db);
  if (userToRep.size > 0) {
    const repIds = [...userToRep.values()];

    const tags = await db.customerRepTag.findMany({
      where: {
        representativeId: { in: repIds },
        tagType: "MANAGING",
        isActive: true,
        profile: { ...activeProfile, ...claimedScope },
      },
      select: { profileId: true },
    });
    for (const t of tags) candidateIds.add(t.profileId);

    const bindings = await db.representativeOrganization.findMany({
      where: { representativeId: { in: repIds }, status: "ACTIVE" },
      select: { organizationId: true, organizationSiteId: true },
    });
    const orgIds = [...new Set(bindings.map((b) => b.organizationId).filter(Boolean))] as string[];
    const siteIds = [...new Set(bindings.map((b) => b.organizationSiteId).filter(Boolean))] as string[];

    if (orgIds.length > 0 || siteIds.length > 0) {
      const bindingProfiles = await db.crmCustomerProfile.findMany({
        where: {
          ...activeProfile,
          ...claimedScope,
          OR: [
            ...(siteIds.length > 0 ? [{ organizationSiteId: { in: siteIds } }] : []),
            ...(orgIds.length > 0 ? [{ organizationId: { in: orgIds } }] : []),
          ],
        },
        select: { id: true },
      });
      for (const p of bindingProfiles) candidateIds.add(p.id);
    }
  }

  // 终闸与旧语义一致：effective resolver owner 必须在 allowedOwners 内；
  // stale owner 行或残留 MANAGING tag 本身不授权。
  const idSet = new Set<string>();
  for (const chunk of chunkIds([...candidateIds], SQLITE_PARAM_LIMIT)) {
    const effMap = await resolveEffectiveRepresentativesForProfiles(chunk, db);
    for (const profileId of chunk) {
      const eff = effMap.get(profileId);
      if (eff?.ownerUserId && allowedOwners.includes(eff.ownerUserId)) {
        idSet.add(profileId);
      }
    }
  }

  return [...idSet];
}

/**
 * 公海可见集合（本部门公海 + 跨部门共享公海）。
 * 仅用于公海列表/受限详情；绝不能并入 Order/Project/Finance scope。
 */
export async function getPoolCrmVisibleProfileIds(
  actor: BusinessActor,
  db: DbLike = prisma,
): Promise<string[]> {
  if (actor.role !== "ADMIN" && !isCrmCapableRole(actor.role)) return [];

  const department = await resolveActorDepartment(actor, db);
  if (!department) return [];

  const states = await db.crmProfileDepartmentState.findMany({
    where: {
      department,
      claimStatus: "POOL",
      profile: { archived: false, deleted: false },
      OR: [
        { poolEntryReason: { not: null } },
        {
          profile: {
            poolShares: { some: { targetDepartment: department, status: "ACTIVE" } },
          },
        },
      ],
    },
    select: { profileId: true },
  });
  return states.map((s) => s.profileId);
}

// ─────────────────────────────────────────────────────────────────────────────
// 共享 Profile 乐观并发校验（§6.6：updatedAt 冲突返回 409）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 共享 profile 更新的乐观锁检查：调用方写入前携带读取时的 updatedAt，
 * 与当前库值不一致即抛 StaleStateError（409），避免最后写入静默覆盖。
 */
export async function assertSharedProfileFreshness(
  input: { profileId: string; expectedUpdatedAt: Date | string },
  db: DbLike = prisma,
): Promise<void> {
  const row = await db.crmCustomerProfile.findUnique({
    where: { id: input.profileId },
    select: { updatedAt: true },
  });
  if (!row) throw new NotFoundError("Profile not found");
  const expected = new Date(input.expectedUpdatedAt).getTime();
  if (Number.isNaN(expected) || row.updatedAt.getTime() !== expected) {
    throw new StaleStateError("客户资料已被其他操作更新，请刷新后重试");
  }
}

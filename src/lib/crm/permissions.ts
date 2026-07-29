import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  getManagedRepresentativeIds,
  getRepresentativeIdByUserEmail,
  getAllowedOwnerIds,
} from "@/lib/crm/representative-scope";
import { resolveEffectiveRepresentativesForProfiles } from "@/lib/crm/customer-effective-representative";
import { getClaimedCrmVisibleProfileIds } from "@/lib/crm/profile-access";

type DbLike = typeof prisma | Prisma.TransactionClient;

export {
  getRegionalManagerUserIds,
  getManagedRepresentativeIds,
  getRepresentativeIdByUserEmail,
} from "@/lib/crm/representative-scope";

export function isRepresentativeRole(role: string) {
  return role === "REPRESENTATIVE";
}

export function isRegionalManagerRole(role: string) {
  return role === "REGIONAL_MANAGER";
}

export async function canManageRepresentativeBindings(
  userId: string,
  role: string,
  representativeId: string,
  userEmail?: string | null,
): Promise<boolean> {
  if (role === "ADMIN") return true;

  if (role === "REGIONAL_MANAGER") {
    const managedIds = await getManagedRepresentativeIds(userId);
    return managedIds.includes(representativeId);
  }

  if (role === "REPRESENTATIVE") {
    const ownRepresentativeId = await getRepresentativeIdByUserEmail(userEmail);
    return ownRepresentativeId === representativeId;
  }

  return false;
}

// 可见性口径单一真相源：
// Profile 可见集合 = getEffectiveCrmVisibleProfileIds（部门隔离 Phase 4 起委托
// getClaimedCrmVisibleProfileIds：本部门 CLAIMED + 既有角色范围；Pool profileId 绝不并入）。
// RM / user↔rep bridge 真相源在 representative-scope.ts。
// 依赖方向：permissions → profile-access → effective-representative → representative-scope（无环）。

/**
 * Resolve the set of profileIds visible to a user（本部门 CLAIMED 集合）。
 * Returns null for ADMIN (meaning all profiles are visible).
 *
 * 部门隔离 Phase 4（设计 §6.6）：不再以 "USER 返回 null = 全量完整可见" 表达权限。
 * USER 返回本部门 CLAIMED profileId 集合（回填后存量 profile 均为 FIELD_SALES
 * CLAIMED，FIELD_SALES 可见范围不缩小）；Representative/RM 继续受
 * effective representative 范围限制（终闸在 profile-access.ts 内复核）。
 */
export async function getEffectiveCrmVisibleProfileIds(
  userId: string,
  role: string,
  db: DbLike = prisma,
): Promise<Set<string> | null> {
  const ids = await getClaimedCrmVisibleProfileIds({ userId, role }, db);
  return ids === null ? null : new Set(ids);
}

/**
 * Check if a user can access a CRM profile based on Profile-centric scope.
 * Throws "NOT_FOUND" or "FORBIDDEN" on failure.
 *
 * Sales access is granted only when assignmentStatus === "ASSIGNED" and the
 * effective resolver owner is in the caller's allowed owner set. Stale owner
 * rows or leftover MANAGING tags alone never authorize.
 */
/** CRM 访问控制类型化错误（替代 plain Error("NOT_FOUND"/"FORBIDDEN")） */
export class CrmAccessError extends Error {
  httpStatus: number;
  constructor(message: string, httpStatus: number) {
    super(message);
    this.httpStatus = httpStatus;
    this.name = "CrmAccessError";
  }
}

export class CrmAccessNotFoundError extends CrmAccessError {
  constructor(message = "NOT_FOUND") {
    super(message, 404);
    this.name = "CrmAccessNotFoundError";
  }
}

export class CrmAccessForbiddenError extends CrmAccessError {
  constructor(message = "FORBIDDEN") {
    super(message, 403);
    this.name = "CrmAccessForbiddenError";
  }
}

export async function assertCrmProfileAccess(
  profileId: string,
  userId: string,
  role: string,
) {
  const profile = await prisma.crmCustomerProfile.findUnique({
    where: { id: profileId },
  });
  if (!profile) {
    throw new CrmAccessNotFoundError();
  }
  if (role === "ADMIN" || role === "USER") {
    return profile;
  }

  if (profile.assignmentStatus !== "ASSIGNED") {
    throw new CrmAccessForbiddenError();
  }

  const allowed = await getAllowedOwnerIds(userId, role);
  const eff = (await resolveEffectiveRepresentativesForProfiles([profileId])).get(profileId);
  if (eff?.ownerUserId && allowed.includes(eff.ownerUserId)) {
    return profile;
  }

  throw new CrmAccessForbiddenError();
}

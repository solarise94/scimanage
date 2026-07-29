import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getEffectiveCrmVisibleProfileIds } from "@/lib/crm/permissions";
import { isDepartment } from "@/lib/department";

type DbLike = typeof prisma | Prisma.TransactionClient;

function canAccessOrders(role: string): boolean {
  return role === "ADMIN" || role === "USER" || role === "REPRESENTATIVE" || role === "REGIONAL_MANAGER";
}

export function isOrderAccessBlocked(role: string): boolean {
  return !canAccessOrders(role);
}

/**
 * Build a Prisma where clause for Order scoping.
 * ADMIN → null (all orders)
 * USER  → scoped to project-linked orders, CRM customer orders, and own created orders
 * REP / REGIONAL_MANAGER → project-linked orders + CRM customer orders via effective representative
 *
 * W5.2：只按 profileId 可见，不再并集遗留 Order.customerId。
 *
 * 部门隔离（设计 §6.2）：当 department 提供且 role !== ADMIN 时，
 * 所有分支的 OR 条件外层 AND { departmentSnapshot: department }。
 */
export async function getOrderScopeWhere(
  userId: string,
  role: string,
  db: DbLike = prisma,
  department?: string,
): Promise<Record<string, unknown> | null> {
  if (role === "ADMIN") return null;

  // Fail-closed（设计 §6.1）：非 ADMIN 必须有部门过滤。
  // 未显式传入时从 DB 实时解析；用户不存在或 department 非法时返回 no-match，
  // 不再静默降级为 FIELD_SALES。
  let resolvedDepartment = department;
  if (!resolvedDepartment) {
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { department: true },
    });
    if (!user || !isDepartment(user.department)) {
      return { AND: [{ id: { in: ["__NO_MATCH__"] } }, { departmentSnapshot: "__NO_MATCH__" }] };
    }
    resolvedDepartment = user.department;
  } else if (!isDepartment(resolvedDepartment)) {
    // 显式传入但值非法：同样 fail-closed。
    return { AND: [{ id: { in: ["__NO_MATCH__"] } }, { departmentSnapshot: "__NO_MATCH__" }] };
  }

  const deptWhere = { departmentSnapshot: resolvedDepartment };

  if (role === "USER") {
    // Orders linked to projects the user is a member of
    const projectMemberships = await db.projectMember.findMany({
      where: { userId },
      select: { projectId: true },
    });
    const projectIds = projectMemberships.map((m) => m.projectId);

    const linkedOrderIds = projectIds.length > 0
      ? (await db.orderProjectLink.findMany({
          where: { projectId: { in: projectIds } },
          select: { orderId: true },
          distinct: ["orderId"],
        })).map((l) => l.orderId)
      : [];

    // Orders whose CRM profile is owned by the user
    const crmProfiles = await db.crmCustomerProfile.findMany({
      where: { ownerUserId: userId, assignmentStatus: "ASSIGNED", deleted: false, archived: false },
      select: { id: true },
    });
    const crmProfileIds = crmProfiles.map((p) => p.id);

    const orConditions: Record<string, unknown>[] = [];

    if (linkedOrderIds.length > 0) {
      orConditions.push({ id: { in: linkedOrderIds } });
    }

    if (crmProfileIds.length > 0) {
      orConditions.push({ profileId: { in: crmProfileIds } });
    }

    // Also include orders the user created
    orConditions.push({ createdById: userId });

    if (orConditions.length === 0) {
      return { AND: [{ id: { in: ["__NO_MATCH__"] } }, deptWhere] };
    }

    return { AND: [{ OR: orConditions }, deptWhere] };
  }

  // REPRESENTATIVE / REGIONAL_MANAGER: project-linked orders + CRM customer orders
  if (role === "REPRESENTATIVE" || role === "REGIONAL_MANAGER") {
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });
    if (!user?.email) {
      return { AND: [{ id: { in: ["__NO_MATCH__"] } }, deptWhere] };
    }

    // Collect representative IDs to query
    const repIds: string[] = [];

    // 1. Check if the user has their own Representative record
    const ownRep = await db.representative.findUnique({
      where: { email: user.email, archived: false },
      select: { id: true },
    });
    if (ownRep) repIds.push(ownRep.id);

    // 2. For REGIONAL_MANAGER: also get subordinate representatives
    if (role === "REGIONAL_MANAGER") {
      const manager = await db.crmRegionManager.findUnique({
        where: { userId, archived: false },
        include: {
          reps: {
            include: {
              representative: { select: { id: true, archived: true } },
            },
          },
        },
      });
      if (manager) {
        for (const r of manager.reps) {
          if (!r.representative.archived && !repIds.includes(r.representative.id)) {
            repIds.push(r.representative.id);
          }
        }
      }
    }

    // ── CRM scope: profileId only ──
    const visibleProfileIds = await getEffectiveCrmVisibleProfileIds(userId, role, db);
    const crmProfileIds = visibleProfileIds ? [...visibleProfileIds] : [];

    if (repIds.length === 0 && crmProfileIds.length === 0) {
      return { AND: [{ id: { in: ["__NO_MATCH__"] } }, deptWhere] };
    }

    // ── Project-linked scope ──
    // Find projects linked to all collected representatives (by representativeId)
    const byId = await db.project.findMany({
      where: { representativeId: { in: repIds }, deleted: false },
      select: { id: true },
    });
    const projectIds = new Set(byId.map((p) => p.id));

    // Merge name fallback (uniqueness-gated) for all collected representatives
    const repsWithNames = await db.representative.findMany({
      where: { id: { in: repIds } },
      select: { name: true },
    });
    const seenNames = new Set<string>();
    for (const r of repsWithNames) {
      if (!r.name || seenNames.has(r.name)) continue;
      seenNames.add(r.name);
      const nameCount = await db.representative.count({
        where: { name: r.name, archived: false },
      });
      if (nameCount === 1) {
        const byName = await db.project.findMany({
          where: { representativeId: null, representative: r.name, deleted: false },
          select: { id: true },
        });
        for (const p of byName) projectIds.add(p.id);
      }
    }

    let linkedOrderIds: string[] = [];
    if (projectIds.size > 0) {
      linkedOrderIds = (await db.orderProjectLink.findMany({
        where: { projectId: { in: [...projectIds] } },
        select: { orderId: true },
        distinct: ["orderId"],
      })).map((l) => l.orderId);
    }

    // ── Combine project-linked + CRM profile scope ──
    const orConditions: Record<string, unknown>[] = [];

    if (linkedOrderIds.length > 0) {
      orConditions.push({ id: { in: linkedOrderIds } });
    }

    if (crmProfileIds.length > 0) {
      orConditions.push({ profileId: { in: crmProfileIds } });
    }

    if (orConditions.length === 0) {
      return { AND: [{ id: { in: ["__NO_MATCH__"] } }, deptWhere] };
    }

    return { AND: [{ OR: orConditions }, deptWhere] };
  }

  // Unknown future role — blocked
  return { AND: [{ id: { in: ["__NO_MATCH__"] } }, deptWhere] };
}

/**
 * 有效订单范围（用于金额/回款聚合口径）：
 * CONFIRMED + DELIVERED（活跃确认态）∪ CLOSED 且 accrualReversalOfId 非空（计提冲回影子订单，负向金额需进聚合）。
 * 普通关闭的 CLOSED 订单不计入（已终态，无应收）。
 */
export function getEffectiveOrderWhere(scopeWhere: Record<string, unknown> | null): Record<string, unknown> {
  const effectiveFilter = {
    OR: [
      { status: { in: ["CONFIRMED", "DELIVERED"] } },
      { status: "CLOSED", accrualReversalOfId: { not: null } },
    ],
  };
  if (!scopeWhere) return effectiveFilter;
  return { AND: [scopeWhere, effectiveFilter] };
}

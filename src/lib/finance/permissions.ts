import { prisma } from "@/lib/prisma";
import { getOrderScopeWhere } from "@/lib/orders/permissions";
import { getEffectiveCrmVisibleProfileIds } from "@/lib/crm/permissions";
import { isDepartment } from "@/lib/department";

const FINANCE_READ_ROLES = new Set(["ADMIN", "USER", "REGIONAL_MANAGER"]);
const FINANCE_WRITE_ROLES = new Set(["ADMIN", "USER"]);
const FINANCE_ADVANCE_READ_ROLES = new Set(["ADMIN", "USER", "REPRESENTATIVE", "REGIONAL_MANAGER"]);

export function canReadFinance(role: string): boolean {
  return FINANCE_READ_ROLES.has(role);
}

/** Receipt / invoice write paths — matches POST /api/finance/receipts (ADMIN/USER only). */
export function canWriteFinance(role: string): boolean {
  return FINANCE_WRITE_ROLES.has(role);
}

export function canReadFinanceAdvance(role: string): boolean {
  return FINANCE_ADVANCE_READ_ROLES.has(role);
}

export function isFinanceBlocked(role: string): boolean {
  // Default finance read is whitelist-based. Route-specific carve-outs
  // (for example advances or order receivables) should opt in explicitly.
  return !canReadFinance(role);
}

async function getSalesFinanceContext(
  userId: string,
  role: string,
): Promise<{ representativeIds: string[]; representativeUserIds: string[] }> {
  if (role !== "REPRESENTATIVE" && role !== "REGIONAL_MANAGER") {
    return { representativeIds: [], representativeUserIds: [] };
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true },
  });
  if (!user?.email) {
    return { representativeIds: [], representativeUserIds: [userId] };
  }

  const representativeIds: string[] = [];
  const ownRepresentative = await prisma.representative.findUnique({
    where: { email: user.email },
    select: { id: true, archived: true },
  });
  if (ownRepresentative && !ownRepresentative.archived) {
    representativeIds.push(ownRepresentative.id);
  }

  if (role === "REGIONAL_MANAGER") {
    const manager = await prisma.crmRegionManager.findUnique({
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
      for (const link of manager.reps) {
        if (!link.representative.archived && !representativeIds.includes(link.representative.id)) {
          representativeIds.push(link.representative.id);
        }
      }
    }
  }

  const representativeEmails = representativeIds.length > 0
    ? await prisma.representative.findMany({
        where: { id: { in: representativeIds } },
        select: { email: true },
      })
    : [];

  const representativeUsers = representativeEmails.length > 0
    ? await prisma.user.findMany({
        where: {
          email: { in: representativeEmails.map((rep) => rep.email) },
          role: { in: ["REPRESENTATIVE", "REGIONAL_MANAGER"] },
        },
        select: { id: true },
      })
    : [];

  const representativeUserIds = Array.from(new Set([userId, ...representativeUsers.map((userRecord) => userRecord.id)]));
  return { representativeIds, representativeUserIds };
}

/**
 * 解析非 ADMIN 用户的部门。Fail-closed（设计 §6.1）：
 * 显式传入时仅接受合法部门值；未传入时从 DB 实时解析。
 * 用户不存在或 department 非法时返回 null，调用点据此返回 no-match scope，
 * 不再静默降级为 FIELD_SALES。
 */
async function resolveFinanceDepartment(
  userId: string,
  department?: string,
): Promise<string | null> {
  if (department) {
    return isDepartment(department) ? department : null;
  }
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { department: true },
  });
  if (!user) return null;
  return isDepartment(user.department) ? user.department : null;
}

const NO_MATCH_SCOPE: { id: { in: string[] } } = { id: { in: ["__NO_MATCH__"] } };

/**
 * W5.2 P1：财务客户可见范围以 CrmCustomerProfile.id（profileId）为主键。
 * 含 Profile-only（sourceCustomerId=null）；不再从 Customer.id 反推。
 *
 * 经项目/订单旁路推导的 profile 必须带部门过滤（fail-closed），避免跨部门成员关系泄露。
 */
export async function getFinanceProfileScopeWhere(
  userId: string,
  role: string,
  department?: string,
): Promise<{ id: { in: string[] } } | null> {
  if (role === "ADMIN") return null;

  const resolvedDepartment = await resolveFinanceDepartment(userId, department);
  // Fail-closed（设计 §6.1）：部门无法权威解析时返回 no-match，不静默降级为 FIELD_SALES。
  if (!resolvedDepartment) return { id: { in: ["__NO_MATCH__"] } };

  if (role === "USER") {
    const [crmProfiles, projectMemberships] = await Promise.all([
      prisma.crmCustomerProfile.findMany({
        where: { ownerUserId: userId, assignmentStatus: "ASSIGNED", deleted: false, archived: false },
        select: { id: true },
      }),
      prisma.projectMember.findMany({
        where: {
          userId,
          project: { departmentSnapshot: resolvedDepartment, deleted: false },
        },
        select: { project: { select: { profileId: true } } },
      }),
    ]);

    const profileIds = new Set<string>();
    for (const p of crmProfiles) profileIds.add(p.id);
    for (const m of projectMemberships) {
      if (m.project.profileId) profileIds.add(m.project.profileId);
    }

    if (profileIds.size === 0) return { id: { in: ["__NO_MATCH__"] } };
    return { id: { in: Array.from(profileIds) } };
  }

  if (role === "REPRESENTATIVE" || role === "REGIONAL_MANAGER") {
    const profileIds = new Set<string>();

    const visibleProfileIds = await getEffectiveCrmVisibleProfileIds(userId, role);
    if (visibleProfileIds) {
      for (const pid of visibleProfileIds) profileIds.add(pid);
    }

    const projectScope = await getFinanceProjectScopeWhere(userId, role, resolvedDepartment);
    if (projectScope) {
      const projects = await prisma.project.findMany({
        where: { id: projectScope.id, deleted: false },
        select: { profileId: true },
      });
      for (const project of projects) {
        if (project.profileId) profileIds.add(project.profileId);
      }
    }

    const orderScope = await getOrderScopeWhere(userId, role, prisma, resolvedDepartment);
    if (orderScope) {
      const orders = await prisma.order.findMany({
        where: { AND: [orderScope, { deleted: false }] },
        select: { profileId: true },
      });
      for (const order of orders) {
        if (order.profileId) profileIds.add(order.profileId);
      }
    }

    if (profileIds.size === 0) return { id: { in: ["__NO_MATCH__"] } };
    return { id: { in: Array.from(profileIds) } };
  }

  return { id: { in: ["__NO_MATCH__"] } };
}

export async function getFinanceProjectScopeWhere(
  userId: string,
  role: string,
  department?: string,
): Promise<{ id: { in: string[] } } | null> {
  if (role === "ADMIN") return null;

  // Fail-closed（设计 §6.1 / §6.3）：非 ADMIN 必须有部门过滤。
  // 未显式传入时从 DB 实时解析；用户不存在或 department 非法时返回 no-match，
  // 不再静默降级为 FIELD_SALES。
  const resolvedDepartment = await resolveFinanceDepartment(userId, department);
  if (!resolvedDepartment) return { ...NO_MATCH_SCOPE };
  const deptFilter = { departmentSnapshot: resolvedDepartment };

  if (role === "USER") {
    const memberships = await prisma.projectMember.findMany({
      where: { userId, project: deptFilter },
      select: { projectId: true },
    });
    const ids = memberships.map((membership) => membership.projectId);
    if (ids.length === 0) return { id: { in: ["__NO_MATCH__"] } };
    return { id: { in: ids } };
  }

  if (role === "REPRESENTATIVE" || role === "REGIONAL_MANAGER") {
    const projectIds = new Set<string>();
    const [memberships, salesContext] = await Promise.all([
      prisma.projectMember.findMany({
        where: { userId, project: deptFilter },
        select: { projectId: true },
      }),
      getSalesFinanceContext(userId, role),
    ]);

    for (const membership of memberships) {
      projectIds.add(membership.projectId);
    }

    if (salesContext.representativeIds.length > 0) {
      const byRepresentativeId = await prisma.project.findMany({
        where: {
          representativeId: { in: salesContext.representativeIds },
          deleted: false,
          ...deptFilter,
        },
        select: { id: true },
      });
      for (const project of byRepresentativeId) {
        projectIds.add(project.id);
      }

      const representatives = await prisma.representative.findMany({
        where: { id: { in: salesContext.representativeIds } },
        select: { name: true },
      });
      const seenNames = new Set<string>();
      for (const representative of representatives) {
        if (!representative.name || seenNames.has(representative.name)) continue;
        seenNames.add(representative.name);
        const nameCount = await prisma.representative.count({
          where: { name: representative.name, archived: false },
        });
        if (nameCount !== 1) continue;

        const byRepresentativeName = await prisma.project.findMany({
          where: {
            representativeId: null,
            representative: representative.name,
            deleted: false,
            ...deptFilter,
          },
          select: { id: true },
        });
        for (const project of byRepresentativeName) {
          projectIds.add(project.id);
        }
      }
    }

    if (projectIds.size === 0) return { id: { in: ["__NO_MATCH__"] } };
    return { id: { in: Array.from(projectIds) } };
  }

  return { id: { in: ["__NO_MATCH__"] } };
}

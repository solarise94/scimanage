import type { Prisma } from "@prisma/client";
import type { CustomerAddressOrgHint } from "@/lib/customers/customer-address-org-hints";

/**
 * 统一客户删除守卫（设计文档 §八 Phase G4 / §9.4）——Profile-only 版。
 *
 * 历史上「删客户」有两套守卫：
 *  - `/api/admin/data-governance/batch-delete`（三无孤儿，9 项 _count 检查）
 *  - `/api/customer-org-bindings/batch-delete`（脏数据清理，14 项含 advances）
 *  - `/api/customers/[id]/route` DELETE（通用删除，少检 crmProfile/repTags/relations/advances/mergedIntoId/archived）
 *
 * G4 把删除写路径收口到一处，守卫必须是三套旧守卫的**并集**（strict superset）——
 * 任一旧守卫会拒的情况，这里必须也拒。设计停止条件明确：删除不可逆，宁严勿松。
 *
 * W7.3 Profile-only：治理主体 = CrmCustomerProfile，全部关联检查走 Profile relation
 * （profileOrders/profileProjects/profileFinance* 等），不再经 Customer 锚点。
 *
 * 与旧守卫的差异（均为更严，不会漏放）：
 *  - 订单/回款一律计**全部**（含软删），而非旧 `deleted:false` 子集——取两套口径的并集即最严。
 *  - 同时检查 `advances`（仅 customer-org-bindings 守卫有）。
 */
export const PROFILE_DELETE_GUARD_INCLUDE = {
  profileOrders: { select: { id: true } }, // 全部订单（含软删）——取最严口径
  profileProjects: { select: { id: true } },
  profileExternalOrders: { select: { id: true } },
  profileFinanceCosts: { select: { id: true } },
  profileFinanceReceipts: { select: { id: true } },
  profileFinanceAdvances: { select: { id: true } },
  profileRepTags: { select: { id: true } },
  relationsFromProfile: { select: { id: true } },
  relationsToProfile: { select: { id: true } },
  _count: {
    select: {
      interactions: true,
      followUpTasks: true,
      addresses: true,
      visitCheckins: true,
      applications: true,
    },
  },
} satisfies Prisma.CrmCustomerProfileInclude;

export type ProfileWithDeleteGuard = Prisma.CrmCustomerProfileGetPayload<{
  include: typeof PROFILE_DELETE_GUARD_INCLUDE;
}>;

export interface DeleteGuardResult {
  deletable: boolean;
  reason: string | null;
}

/**
 * 评估单个客户档案是否可被软删除。三套旧守卫的并集；任一不满足即不可删。
 * 返回 `{ deletable, reason }`，reason 为首个命中的拒绝理由（用于审计/前端展示）。
 */
export function evaluateProfileDeletable(p: ProfileWithDeleteGuard | null): DeleteGuardResult {
  if (!p) return { deletable: false, reason: "客户不存在" };
  if (p.deleted) return { deletable: false, reason: "客户已删除" };
  if (p.archived) return { deletable: false, reason: "客户已归档" };
  if (p.mergedIntoProfileId !== null) return { deletable: false, reason: "客户已被合并" };
  if (p.organizationId !== null) return { deletable: false, reason: "客户已绑定机构" };
  if (p.organization !== null || p.organizationRawInput !== null) {
    return { deletable: false, reason: "客户仍保留机构文本信息" };
  }
  if (p.profileOrders.length > 0) return { deletable: false, reason: "客户存在订单记录" };
  if (p.profileProjects.length > 0) return { deletable: false, reason: "客户关联了项目" };
  if (p.profileExternalOrders.length > 0) return { deletable: false, reason: "客户存在外部订单" };
  if (p.profileFinanceCosts.length > 0) return { deletable: false, reason: "客户存在财务成本记录" };
  if (p.profileFinanceReceipts.length > 0) return { deletable: false, reason: "客户存在回款记录" };
  if (p.profileFinanceAdvances.length > 0) return { deletable: false, reason: "客户存在预付款记录" };
  if (hasCrmActivity(p)) return { deletable: false, reason: "客户档案存在 CRM 互动/任务/地址/拜访/申请记录" };
  if (p.profileRepTags.length > 0) return { deletable: false, reason: "客户存在代表标签" };
  if (p.relationsFromProfile.length > 0 || p.relationsToProfile.length > 0) {
    return { deletable: false, reason: "客户存在关系关联" };
  }
  return { deletable: true, reason: null };
}

export function evaluateProfileDeletableWithAddressHints(
  p: ProfileWithDeleteGuard | null,
  addressOrgHints: CustomerAddressOrgHint[] = [],
): DeleteGuardResult {
  const guard = evaluateProfileDeletable(p);
  if (!guard.deletable) return guard;
  if (addressOrgHints.length > 0) {
    return { deletable: false, reason: "客户通讯地址包含机构线索" };
  }
  return guard;
}

function hasCrmActivity(p: ProfileWithDeleteGuard, options: { includeApplications: boolean } = { includeApplications: true }): boolean {
  const count = p._count;
  return (
    count.interactions > 0 ||
    count.followUpTasks > 0 ||
    count.addresses > 0 ||
    count.visitCheckins > 0 ||
    (options.includeApplications && count.applications > 0)
  );
}

/**
 * 「无来源客户」清理口径：允许存在系统自动生成的代表标签 / 客户申请壳信息，
 * 但仍阻断任何真实业务、财务、关系和 CRM 行为记录。
 */
export function evaluateNoSourceProfileDeletable(p: ProfileWithDeleteGuard | null): DeleteGuardResult {
  if (!p) return { deletable: false, reason: "客户不存在" };
  if (p.deleted) return { deletable: false, reason: "客户已删除" };
  if (p.archived) return { deletable: false, reason: "客户已归档" };
  if (p.mergedIntoProfileId !== null) return { deletable: false, reason: "客户已被合并" };
  if (p.organizationId !== null) return { deletable: false, reason: "客户已绑定机构" };
  if (p.organization !== null || p.organizationRawInput !== null) {
    return { deletable: false, reason: "客户仍保留机构文本信息" };
  }
  if (p.profileOrders.length > 0) return { deletable: false, reason: "客户存在订单记录" };
  if (p.profileProjects.length > 0) return { deletable: false, reason: "客户关联了项目" };
  if (p.profileExternalOrders.length > 0) return { deletable: false, reason: "客户存在外部订单" };
  if (p.profileFinanceCosts.length > 0) return { deletable: false, reason: "客户存在财务成本记录" };
  if (p.profileFinanceReceipts.length > 0) return { deletable: false, reason: "客户存在回款记录" };
  if (p.profileFinanceAdvances.length > 0) return { deletable: false, reason: "客户存在预付款记录" };
  if (hasCrmActivity(p, { includeApplications: false })) {
    return { deletable: false, reason: "客户档案存在 CRM 互动/任务/地址/拜访记录" };
  }
  if (p.relationsFromProfile.length > 0 || p.relationsToProfile.length > 0) {
    return { deletable: false, reason: "客户存在关系关联" };
  }
  return { deletable: true, reason: null };
}

export function evaluateNoSourceProfileDeletableWithAddressHints(
  p: ProfileWithDeleteGuard | null,
  addressOrgHints: CustomerAddressOrgHint[] = [],
): DeleteGuardResult {
  const guard = evaluateNoSourceProfileDeletable(p);
  if (!guard.deletable) return guard;
  if (addressOrgHints.length > 0) {
    return { deletable: false, reason: "客户通讯地址包含机构线索" };
  }
  return guard;
}

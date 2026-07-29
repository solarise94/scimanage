/**
 * Shared Prisma include objects for CRM queries.
 *
 * Keeps interaction / follow-up task operator includes DRY across
 * profile detail, interactions list, and follow-up task list routes.
 */

import type { Prisma } from "@prisma/client";

/** Include operator (createdByUser) for CrmInteraction queries */
export const interactionOperatorInclude = {
  createdByUser: { select: { id: true, name: true } },
};

/** Include operators (ownerUser + createdByUser) for CrmFollowUpTask queries */
export const followUpTaskOperatorInclude = {
  ownerUser: { select: { id: true, name: true } },
  createdByUser: { select: { id: true, name: true } },
};

/**
 * 共享 base：profiles 列表与 customer-pool 都用。
 * Phase E contract：Customer 锚点已删除，业务字段全部从 Profile 本体读取。
 * Profile 本体补 org / orgSite 关系（供 adapter 解析 Profile 侧 canonicalName）。
 */
export const profileInclude = {
  // Profile 本体业务字段解析需要的机构关系（新增）
  org: { select: { id: true, canonicalName: true } },
  orgSite: { select: { id: true, siteName: true, siteType: true } },
  ownerUser: { select: { id: true, name: true } },
  _count: {
    select: {
      interactions: true,
      followUpTasks: true,
      visitCheckins: true,
      addresses: true,
    },
  },
} satisfies Prisma.CrmCustomerProfileInclude;

/**
 * customer-pool 扩展：在 base 基础上加 assignedByUser / recalledByUser
 * （CrmCustomerProfileItem 的必填成员，见 types.ts:15/18）。
 */
export const customerPoolProfileInclude = {
  ...profileInclude,
  assignedByUser: { select: { id: true, name: true } },
  recalledByUser: { select: { id: true, name: true } },
} satisfies Prisma.CrmCustomerProfileInclude;

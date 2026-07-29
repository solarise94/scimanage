/**
 * Operational project 查询 helper（设计文档 §8.6 横切查询防污染）。
 *
 * GOVERNANCE_BUCKET 过滤不能依赖每个页面开发者记得手写。所有正常项目聚合
 * （列表、统计、CRM、财务、成本、开票、Agent 候选）必须经此 helper，
 * 默认排除 systemType = GOVERNANCE_BUCKET。
 *
 * 与 scope（actor scope / department scope）使用 AND-composition：
 *
 * ```ts
 * getOperationalProjectWhere(scopeWhere, filters)
 *   === { AND: [scopeWhere, { systemType: "NORMAL" }, filters] }
 * ```
 *
 * 只有"历史治理"专用 service 可以查询 GOVERNANCE_BUCKET。
 */
import type { Prisma } from "@prisma/client";
import { GOVERNANCE_PROJECT_SYSTEM_TYPE } from "@/lib/products/constants";

/**
 * 统一构造 operational project WHERE：排除治理桶。
 *
 * @param scopeWhere actor/department scope（来自 resolveProjectListWhere 等）
 * @param filters 业务筛选（status/search/dateRange 等）
 * @param includeGovernance 显式查询治理桶时传 true（仅治理专用 service）
 */
export function getOperationalProjectWhere(
  scopeWhere: Prisma.ProjectWhereInput,
  filters: Prisma.ProjectWhereInput = {},
  opts: { includeGovernance?: boolean } = {},
): Prisma.ProjectWhereInput {
  if (opts.includeGovernance) {
    return { AND: [scopeWhere, filters] };
  }
  return {
    AND: [
      scopeWhere,
      { systemType: GOVERNANCE_PROJECT_SYSTEM_TYPE.NORMAL },
      filters,
    ],
  };
}

/**
 * 返回"仅普通项目"的 systemType 过过滤器，便于直接拼到已有 where。
 * 用于不方便重构为 AND-composition 的旧代码点。
 */
export function normalProjectSystemTypeFilter(): Prisma.ProjectWhereInput {
  return { systemType: GOVERNANCE_PROJECT_SYSTEM_TYPE.NORMAL };
}

/**
 * 返回"仅治理桶"的 systemType 过过滤器（仅治理专用 service 用）。
 */
export function governanceBucketSystemTypeFilter(): Prisma.ProjectWhereInput {
  return { systemType: GOVERNANCE_PROJECT_SYSTEM_TYPE.GOVERNANCE_BUCKET };
}

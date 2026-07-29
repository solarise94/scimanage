/**
 * 部门 Scope 查询条件构建器（设计文档 §六）。
 *
 * 所有非 ADMIN 的部门隔离查询必须 AND 部门条件。
 * ADMIN 返回 null 表示全量。
 */

import type { Department } from "@/lib/department";

/**
 * 构建部门过滤条件。
 * ADMIN 返回 null（全量），非 ADMIN 返回 { departmentSnapshot: department }。
 */
export function departmentScopeWhere(
  role: string,
  department: Department | string,
): { departmentSnapshot: string } | null {
  if (role === "ADMIN") return null;
  return { departmentSnapshot: department };
}

/**
 * 将部门条件与现有 scope 合并（AND 组合）。
 * 遵循项目规范：禁止覆盖 where 对象，必须用 AND 组合。
 */
export function withDepartmentScope<T extends Record<string, unknown>>(
  existingWhere: T,
  role: string,
  department: Department | string,
): T | (T & { AND: Array<Record<string, unknown>> }) {
  const deptWhere = departmentScopeWhere(role, department);
  if (!deptWhere) return existingWhere;

  // 如果 existingWhere 已经有 AND，追加部门条件
  if ("AND" in existingWhere && Array.isArray(existingWhere.AND)) {
    return {
      ...existingWhere,
      AND: [...(existingWhere.AND as Array<Record<string, unknown>>), deptWhere],
    };
  }

  // 否则创建 AND 组合
  return {
    AND: [existingWhere, deptWhere],
  } as T & { AND: Array<Record<string, unknown>> };
}

/**
 * 断言资源部门与操作者部门一致（跨资源不变量校验，设计 §7.3）。
 * 用于事务内校验 Order↔Project、Invoice↔Order、Receipt↔Invoice 等同部门约束。
 */
export function assertDepartmentConsistency(
  resourceADepartment: string,
  resourceBDepartment: string,
  labelA: string,
  labelB: string,
): void {
  if (resourceADepartment !== resourceBDepartment) {
    throw new Error(
      `跨部门关联被拒绝：${labelA}（${resourceADepartment}）与 ${labelB}（${resourceBDepartment}）不属于同一部门`,
    );
  }
}

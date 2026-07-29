import { ValidationError } from "@/lib/application/errors";

export const DEPARTMENTS = ["FIELD_SALES", "ONLINE_OPS"] as const;
export type Department = (typeof DEPARTMENTS)[number];

export const DEPARTMENT_LABELS: Record<Department, string> = {
  FIELD_SALES: "地推销售部",
  ONLINE_OPS: "网络运营部",
};

/**
 * 部门隔离 fail-closed 兜底哨兵（设计 §6.1）。
 *
 * 历史 DEFAULT_DEPARTMENT = "FIELD_SALES" 被多处用作「部门无法权威解析时的兜底」，
 * 这违反 fail-closed：用户不存在或 department 字段异常时应返回 no-match（读路径）
 * 或拒绝写入（写路径），不能静默把用户归入 FIELD_SALES 从而看到/写出错误部门的数据。
 *
 * 现仅保留给 schema 默认值 / 显式迁移回填（合法用途）使用；运行时部门解析一律走
 * resolveActorDepartmentOrNull + 调用点 fail-closed 处理。
 */
export const DEFAULT_DEPARTMENT: Department = "FIELD_SALES";

export function isDepartment(value: unknown): value is Department {
  return typeof value === "string" && (DEPARTMENTS as readonly string[]).includes(value);
}

/**
 * 从数据库获取用户当前部门（敏感操作必须查 DB，不信任 JWT 缓存）。
 *
 * Fail-closed（设计 §6.1）：用户不存在或 department 字段非法时返回 null，
 * 由调用点决定读路径返回 no-match / 写路径抛 typed error。不再静默降级为
 * DEFAULT_DEPARTMENT。
 */
export async function resolveActorDepartmentOrNull(
  userId: string,
): Promise<Department | null> {
  const { prisma } = await import("@/lib/prisma");
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { department: true },
  });
  if (!user) return null;
  return isDepartment(user.department) ? user.department : null;
}

/**
 * 从数据库获取用户当前部门（敏感操作必须查 DB，不信任 JWT 缓存）。
 *
 * Fail-closed（设计 §6.1）：用户不存在或 department 字段非法时抛 ValidationError，
 * 适用于写路径（创建落 snapshot）。读路径请用 resolveActorDepartmentOrNull 并自行
 * 映射为 no-match scope。
 */
export async function getActorDepartment(userId: string): Promise<Department> {
  const dept = await resolveActorDepartmentOrNull(userId);
  if (!dept) {
    throw new ValidationError(
      `无法权威解析用户 ${userId} 的部门（用户不存在或 department 字段非法）`,
    );
  }
  return dept;
}

/**
 * 解析根记录写入部门（设计 §7.2）。
 *
 * - 非 ADMIN：取数据库中的 actor.department，忽略 requestedDepartment。
 * - ADMIN：取经校验的 requestedDepartment；未提供时取自身部门。
 */
export async function resolveRootWriteDepartment(opts: {
  actorUserId: string;
  actorRole: string;
  requestedDepartment?: string | null;
}): Promise<Department> {
  const actorDept = await getActorDepartment(opts.actorUserId);

  if (opts.actorRole !== "ADMIN") {
    return actorDept;
  }

  // ADMIN 可指定部门
  if (opts.requestedDepartment) {
    if (!isDepartment(opts.requestedDepartment)) {
      throw new ValidationError(`非法部门值: ${opts.requestedDepartment}`);
    }
    return opts.requestedDepartment;
  }

  return actorDept;
}

/**
 * 断言两个部门一致，不一致时抛出业务错误。
 */
export function assertSameDepartment(
  expected: Department | string,
  actual: Department | string,
  resourceLabel: string,
): void {
  if (expected !== actual) {
    throw new ValidationError(
      `跨部门操作被拒绝：${resourceLabel} 属于 ${DEPARTMENT_LABELS[actual as Department] ?? actual}，` +
        `当前操作部门为 ${DEPARTMENT_LABELS[expected as Department] ?? expected}`,
    );
  }
}

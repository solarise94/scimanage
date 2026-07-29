import { isInternalStaff } from "@/lib/role-guards";

/**
 * 技术支持默认与展示名解析（轻量：Project.techSupport 仍是人名字符串）。
 *
 * 规则：
 * - 仅内部员工（ADMIN | USER）在「字段为空」时回填当前操作者姓名；
 * - 请求/表单已有非空值时绝不覆盖（智能填充、手改优先）；
 * - 非内部员工不自动填。
 */

export type TechSupportActor = {
  role?: string | null;
  name?: string | null;
  email?: string | null;
};

/** 从 session/user 推导可写入 techSupport 的展示名。 */
export function actorDisplayName(actor: TechSupportActor): string {
  const name = actor.name?.trim();
  if (name) return name;
  const email = actor.email?.trim();
  if (email) {
    const local = email.split("@")[0]?.trim();
    if (local) return local;
  }
  return "未命名用户";
}

/**
 * 解析最终应写入的 techSupport。
 * @returns 非空字符串，或 null（表示保持空 / 非内部且无输入）
 */
export function resolveTechSupportDefault(
  input: string | null | undefined,
  actor: TechSupportActor,
): string | null {
  const existing = typeof input === "string" ? input.trim() : "";
  if (existing) return existing;
  if (!isInternalStaff(actor.role)) return null;
  return actorDisplayName(actor);
}

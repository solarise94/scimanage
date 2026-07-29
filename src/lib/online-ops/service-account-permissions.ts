/**
 * 客服账号权限（设计文档 §4.6 / §10）。
 *
 * CustomerServiceAccount 第一期只允许 ONLINE_OPS 部门。
 * 权限矩阵：
 * - ADMIN：可管理全部客服号（含查看、创建、停用、改 owner）。
 * - ONLINE_OPS USER：可管理 ownerUserId=自己 的客服号（查看自己的、改 owner 仅限转给自己名下时受限于自身；停用自己名下）。
 *   列表查询：USER 看自己名下；ADMIN 看全部。
 * - 其他部门非 ADMIN：403（assertPortalAccess + 部门校验）。
 *
 * 写权限由 service 层在事务内对每条记录判定，避免 IDOR。
 */

import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/application/errors";
import { isDepartment } from "@/lib/department";

export type ServiceAccountActor = {
  userId: string;
  role: string;
  department: string;
};

/**
 * 列表查询的 owner 过滤。
 * - ADMIN：null（全部）。
 * - ONLINE_OPS USER：自身 userId。
 * - 其他：调用方应已在 assertPortalAccessForServiceAccounts 拦截。
 */
export function serviceAccountListOwnerFilter(
  actor: ServiceAccountActor,
): string | null {
  if (actor.role === "ADMIN") return null;
  return actor.userId;
}

/**
 * 门户 + 部门准入：客服账号管理只对 ONLINE_OPS Portal 的 ONLINE_OPS 部门用户或 ADMIN 开放。
 * @throws ForbiddenError
 */
export function assertCanManageServiceAccounts(actor: ServiceAccountActor): void {
  if (actor.role === "ADMIN") return;
  if (actor.department !== "ONLINE_OPS") {
    throw new ForbiddenError(
      "客服账号管理仅对网络运营部门开放",
    );
  }
}

/**
 * 校验客服号归属部门（第一期固定 ONLINE_OPS）。
 */
export function assertServiceAccountDepartment(department: string): void {
  if (!isDepartment(department) || department !== "ONLINE_OPS") {
    throw new ValidationError(
      `客服账号第一期仅允许 ONLINE_OPS 部门（收到: ${department}）`,
    );
  }
}

/**
 * 校验操作者可写指定客服号（非 ADMIN 只能写自己名下）。
 * @throws NotFoundError（不存在/越权合并为 404，防存在性泄露）
 */
export function assertCanWriteServiceAccount(
  actor: ServiceAccountActor,
  ownerUserId: string,
): void {
  if (actor.role === "ADMIN") return;
  if (ownerUserId !== actor.userId) {
    // 与 CRM profile 越权一致：合并为 NotFound，避免泄露存在性。
    throw new NotFoundError("客服账号不存在或无权操作");
  }
}

/**
 * 校验目标 owner 部门为 ONLINE_OPS（创建/改 owner 时）。
 */
export function assertOwnerDepartmentOnlineOps(ownerDepartment: string): void {
  if (ownerDepartment !== "ONLINE_OPS") {
    throw new ValidationError(
      "客服号负责人必须属于网络运营部门",
    );
  }
}

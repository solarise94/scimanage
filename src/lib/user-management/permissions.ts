/**
 * Server-only permission helpers for user management.
 *
 * - `requireCurrentAdmin` extracts the inline DB ADMIN check already present
 *   in GET /api/users and PUT /api/users/[id] into a shared helper.
 * - `assertTargetIsEditable` guards against editing sales / region-manager
 *   accounts through the user management API.
 */

import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isAdminEditableRole, isSalesManagedRole } from "./roles";

export type AdminActor = { id: string; role: string };

type AdminCheckResult =
  | { ok: true; actor: AdminActor }
  | { ok: false; status: 401 | 403; error: string };

/**
 * Verify the current session's user is an ADMIN by reading the database.
 * Never trusts the JWT role alone.
 *
 * Returns a discriminated union so callers can produce the right status code
 * without a throw/catch dance.
 */
export async function requireCurrentAdmin(): Promise<AdminCheckResult> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return { ok: false, status: 401, error: "Unauthorized" };
  }

  const actor = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { id: true, role: true },
  });

  if (!actor || actor.role !== "ADMIN") {
    return { ok: false, status: 403, error: "Forbidden" };
  }

  return { ok: true, actor };
}

/**
 * Resolve the permission error (403 vs 409) for a target user that is a
 * sales account or has a CrmRegionManager record.
 *
 * Returns `null` if the target is an editable internal user (ADMIN/USER with
 * no CrmRegionManager association).
 */
export async function checkTargetEditable(targetUserId: string): Promise<{
  editable: boolean;
  status?: 403 | 404 | 409;
  error?: string;
}> {
  const target = await prisma.user.findUnique({
    where: { id: targetUserId },
    select: { id: true, role: true },
  });

  if (!target) {
    return { editable: false, status: 404, error: "用户不存在" };
  }

  // Sales roles are managed by their own subsystems.
  if (isSalesManagedRole(target.role)) {
    if (target.role === "REPRESENTATIVE") {
      return {
        editable: false,
        status: 403,
        error: "代表账号请在「代表管理」中维护",
      };
    }
    return {
      editable: false,
      status: 403,
      error: "地区经理账号请在「地区经理配置」中维护",
    };
  }

  // Positive allow-list: only known internal roles are editable here.
  // Unknown historical roles must be governed before reuse.
  if (!isAdminEditableRole(target.role)) {
    return {
      editable: false,
      status: 409,
      error: `该账号角色（${target.role}）不在用户管理范围内，请先治理数据`,
    };
  }

  // Even if the role field is historically wrong (e.g. USER), a CrmRegionManager
  // record means this account is managed by the region-manager lifecycle.
  const rmRecord = await prisma.crmRegionManager.findFirst({
    where: { userId: targetUserId },
    select: { id: true, archived: true },
  });
  if (rmRecord) {
    return {
      editable: false,
      status: 403,
      error: "该账号关联地区经理记录，请在「地区经理配置」中维护",
    };
  }

  return { editable: true };
}

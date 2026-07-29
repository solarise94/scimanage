import { prisma } from "@/lib/prisma";
import { getEffectiveCrmVisibleProfileIds } from "@/lib/crm/permissions";

export type AssertResult = { ok: true } | { ok: false; status: 404 | 403; message: string };

/**
 * W6.9.4：客户主数据读门禁只认 profileId。
 * 与 /api/customers/list 同源：getEffectiveCrmVisibleProfileIds。
 */
export async function assertProfileReadable(
  profileId: string,
  userId: string,
  role: string,
): Promise<AssertResult> {
  const profile = await prisma.crmCustomerProfile.findUnique({
    where: { id: profileId },
    select: { id: true, deleted: true, archived: true },
  });

  if (!profile || profile.deleted) {
    return { ok: false, status: 404, message: "客户不存在" };
  }

  if (role === "ADMIN" || role === "USER") {
    return { ok: true };
  }

  const visible = await getEffectiveCrmVisibleProfileIds(userId, role);
  if (visible === null || visible.has(profileId)) {
    return { ok: true };
  }

  return { ok: false, status: 403, message: "无权查看该客户" };
}

/**
 * W6.9.4：写门禁只认 profileId；销售仅可编辑自己 ASSIGNED 的档案。
 */
export async function assertProfileEditable(
  profileId: string,
  userId: string,
  role: string,
): Promise<AssertResult> {
  const profile = await prisma.crmCustomerProfile.findUnique({
    where: { id: profileId },
    select: {
      id: true,
      deleted: true,
      ownerUserId: true,
      assignmentStatus: true,
    },
  });

  if (!profile || profile.deleted) {
    return { ok: false, status: 404, message: "客户不存在" };
  }

  if (role === "ADMIN" || role === "USER") {
    return { ok: true };
  }

  if (role === "REPRESENTATIVE") {
    if (profile.ownerUserId !== userId || profile.assignmentStatus !== "ASSIGNED") {
      return { ok: false, status: 403, message: "只能编辑自己负责的客户" };
    }
    return { ok: true };
  }

  if (role === "REGIONAL_MANAGER") {
    return { ok: false, status: 403, message: "地区经理暂不支持编辑客户主数据" };
  }

  return { ok: false, status: 403, message: "Forbidden" };
}

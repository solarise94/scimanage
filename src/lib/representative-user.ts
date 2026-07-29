import { prisma } from "@/lib/prisma";
import { hashPassword } from "@/lib/password";
import { resolveRepresentativeForOwnerUserId } from "@/lib/crm/customer-owner-representative";

/** Roles that are allowed to receive customer assignments (销售/地区经理). */
const SALES_ROLES = new Set(["REPRESENTATIVE", "REGIONAL_MANAGER"]);

type SalesUserDb = {
  user: {
    findUnique: typeof prisma.user.findUnique;
    create: typeof prisma.user.create;
    update: typeof prisma.user.update;
  };
};

/**
 * Ensure a User record exists for a Representative.
 * The linked User may be REPRESENTATIVE or REGIONAL_MANAGER — both are valid
 * sales roles that can own CRM profiles.
 *
 * - User doesn't exist → create with role REPRESENTATIVE
 * - User exists with REPRESENTATIVE or REGIONAL_MANAGER → allow, sync name
 * - User exists with ADMIN or USER → reject
 *
 * Pass a transaction client as `db` when called inside a write transaction.
 */
export async function ensureSalesUserForRepresentative(
  rep: {
    email: string;
    name: string;
  },
  db: SalesUserDb = prisma,
): Promise<{ userId: string; created: boolean }> {
  const email = rep.email.trim().toLowerCase();
  const name = rep.name.trim();

  let user = await db.user.findUnique({ where: { email } });

  if (user) {
    if (!SALES_ROLES.has(user.role)) {
      throw new Error("该邮箱不是销售/地区经理账号，不能作为客户负责人。请联系管理员处理。");
    }
    if (user.name !== name) {
      user = await db.user.update({ where: { id: user.id }, data: { name } });
    }
    return { userId: user.id, created: false };
  }

  user = await db.user.create({
    data: {
      email,
      name,
      password: await hashPassword(crypto.randomUUID()),
      role: "REPRESENTATIVE",
    },
  });

  return { userId: user.id, created: true };
}

export async function assertRepresentativeBackedSalesUser(
  userId: string,
): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, role: true },
  });

  if (!user || !SALES_ROLES.has(user.role)) {
    throw new Error("负责人必须是销售/地区经理账号");
  }

  const resolved = await resolveRepresentativeForOwnerUserId(userId);
  if (!resolved.representativeId) {
    throw new Error("负责人必须绑定有效代表后才能用于 CRM 负责人与统计");
  }
}

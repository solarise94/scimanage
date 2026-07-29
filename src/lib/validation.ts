import { prisma } from "./prisma";
import { validatePassword, type PasswordValidationResult } from "./password";

/** Minimal DB surface shared by PrismaClient and interactive transaction clients. */
type EmailConflictDb = {
  user: {
    findUnique: typeof prisma.user.findUnique;
  };
  representative: {
    findFirst: typeof prisma.representative.findFirst;
    findUnique: typeof prisma.representative.findUnique;
  };
};

export function validateUserInput({
  name,
  email,
}: {
  name?: string;
  email?: string;
}): { valid: true } | { valid: false; error: string; status: number } {
  if (name !== undefined) {
    const trimmed = name.trim();
    if (!trimmed) {
      return { valid: false, error: "昵称不能为空", status: 400 };
    }
    if (trimmed.length > 100) {
      return { valid: false, error: "昵称过长", status: 400 };
    }
  }

  if (email !== undefined) {
    const trimmed = email.trim().toLowerCase();
    if (!trimmed) {
      return { valid: false, error: "邮箱不能为空", status: 400 };
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(trimmed)) {
      return { valid: false, error: "邮箱格式不正确", status: 400 };
    }
  }

  return { valid: true };
}

/**
 * Check email conflict against the User table only.
 * Preserved for existing callers that only need User-table uniqueness.
 */
export async function checkEmailConflict(
  email: string,
  excludeId?: string,
  db: EmailConflictDb = prisma,
): Promise<{ conflict: true; error: string; status: number } | { conflict: false }> {
  const existing = await db.user.findUnique({
    where: { email: email.trim().toLowerCase() },
  });
  if (existing && existing.id !== excludeId) {
    return { conflict: true, error: "该邮箱已被使用", status: 409 };
  }
  return { conflict: false };
}

/**
 * Check email conflict across both User and Representative tables.
 *
 * Used by user management create/edit flows where a Representative's email
 * must not be claimed by an internal user account (and vice versa).
 *
 * Pass a transaction client as `db` for the authoritative in-transaction re-check;
 * the default prisma client is only a fast pre-check.
 */
export async function checkInternalAccountEmailConflict(
  email: string,
  excludeUserId?: string,
  db: EmailConflictDb = prisma,
): Promise<{ conflict: true; error: string; status: number } | { conflict: false }> {
  const normalized = email.trim().toLowerCase();

  const [userConflict, repConflict] = await Promise.all([
    db.user.findUnique({ where: { email: normalized }, select: { id: true } }),
    db.representative.findFirst({ where: { email: normalized }, select: { id: true } }),
  ]);

  if (userConflict && userConflict.id !== excludeUserId) {
    return { conflict: true, error: "该邮箱已被使用", status: 409 };
  }

  if (repConflict) {
    return {
      conflict: true,
      error: "该邮箱已被代表账号使用，请从代表管理维护",
      status: 409,
    };
  }

  return { conflict: false };
}

/**
 * Representative-side email claim check (Representative + User).
 *
 * - Existing Representative (other id) → conflict
 * - Existing User with non-sales role → conflict
 * - Existing sales User: allowed when `allowExistingSalesUser` (create/bridge);
 *   rejected when false (email change must not land on any User row)
 */
export async function checkRepresentativeEmailClaimConflict(
  email: string,
  options?: {
    excludeRepId?: string;
    allowExistingSalesUser?: boolean;
  },
  db: EmailConflictDb = prisma,
): Promise<{ conflict: true; error: string; status: number } | { conflict: false }> {
  const normalized = email.trim().toLowerCase();
  const excludeRepId = options?.excludeRepId;
  const allowExistingSalesUser = options?.allowExistingSalesUser ?? true;

  const [existingRep, existingUser] = await Promise.all([
    db.representative.findUnique({
      where: { email: normalized },
      select: { id: true },
    }),
    db.user.findUnique({
      where: { email: normalized },
      select: { id: true, role: true },
    }),
  ]);

  if (existingRep && existingRep.id !== excludeRepId) {
    return {
      conflict: true,
      error: excludeRepId ? "该邮箱已被其他代表使用" : "该邮箱已是代表",
      status: 409,
    };
  }

  if (existingUser) {
    const isSales =
      existingUser.role === "REPRESENTATIVE" ||
      existingUser.role === "REGIONAL_MANAGER";
    if (!allowExistingSalesUser || !isSales) {
      return {
        conflict: true,
        error: allowExistingSalesUser
          ? "该邮箱已被其他类型用户使用，请联系管理员"
          : "该邮箱已被其他用户使用，请联系管理员",
        status: 409,
      };
    }
  }

  return { conflict: false };
}

/**
 * Validate password using the shared policy.
 * Re-exported here so callers can import alongside user input validation.
 */
export function validateUserPassword(
  password: string,
  email?: string
): PasswordValidationResult {
  return validatePassword(password, email);
}

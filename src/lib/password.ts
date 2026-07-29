/**
 * Unified password policy and bcrypt hash helper.
 *
 * All password-writing entry points must use `hashPassword` / `validatePassword`
 * instead of inlining `bcrypt.hash(..., N)` with a literal cost.
 *
 * Cost is fixed at 12, consistent with `prisma/seed.ts`.
 */

import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";

export const BCRYPT_COST = 12;

/** Min/max password length after trim. */
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;

export interface PasswordValidationError {
  valid: false;
  error: string;
}

export interface PasswordValidationSuccess {
  valid: true;
}

export type PasswordValidationResult =
  | PasswordValidationSuccess
  | PasswordValidationError;

/**
 * Validate a password against the shared policy.
 *
 * Rules:
 * - 10-128 characters after trim
 * - No mandatory character-class requirements (allow long passphrases)
 * - Must not equal the user's email
 *
 * Callers that hash the password MUST hash `password.trim()` (or the trimmed
 * value used for validation), so setup and profile-change paths stay consistent.
 *
 * @param password raw password input
 * @param email optional email for the "password == email" check (already trimmed+lowercased)
 */
export function validatePassword(
  password: string,
  email?: string,
): PasswordValidationResult {
  if (typeof password !== "string") {
    return { valid: false, error: "密码不能为空" };
  }

  const trimmed = password.trim();

  if (trimmed.length < PASSWORD_MIN_LENGTH) {
    return {
      valid: false,
      error: `密码至少 ${PASSWORD_MIN_LENGTH} 个字符`,
    };
  }

  if (trimmed.length > PASSWORD_MAX_LENGTH) {
    return {
      valid: false,
      error: `密码不能超过 ${PASSWORD_MAX_LENGTH} 个字符`,
    };
  }

  if (email && trimmed === email) {
    return { valid: false, error: "密码不能与邮箱相同" };
  }

  return { valid: true };
}

/** Hash a password using the shared bcrypt cost. */
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_COST);
}

/** Verify a plaintext password against a hash. */
export async function verifyPassword(
  password: string,
  hash: string,
): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

/**
 * Generate a random placeholder password hash for newly created users.
 *
 * The placeholder is never usable for login - the user must set their own
 * password via the invitation flow. We generate 32 bytes of crypto-random data
 * as a hex string and hash it, then discard the plaintext.
 */
export async function generatePlaceholderPasswordHash(): Promise<string> {
  const random = randomBytes(32);
  return bcrypt.hash(random.toString("hex"), BCRYPT_COST);
}

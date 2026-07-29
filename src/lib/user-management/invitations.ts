/**
 * Internal user invitation: token generation, persistence, and email preparation.
 *
 * IMPORTANT: This module manages `UserInvitation` records for internal user
 * account setup and password reset. It is a completely separate authentication
 * system from the Representative Magic Link (`Representative.token`). The two
 * must never share token generation, consumption, or validation logic.
 */

import crypto from "node:crypto";
import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { hashPassword, generatePlaceholderPasswordHash } from "@/lib/password";
import { validatePassword } from "@/lib/password";
import { getAppUrl } from "@/lib/app-url";

export const INVITATION_EXPIRY_HOURS = 48;

export type InvitationPurpose = "ACCOUNT_SETUP" | "PASSWORD_RESET";

/** Result of creating an invitation - includes the plaintext token for email use. */
export interface CreatedInvitation {
  invitationId: string;
  /** Plaintext token - only available here, never persisted. Used to build the email link. */
  token: string;
  expiresAt: Date;
}

/** Verified invitation data returned to the setup-account page. */
export interface VerifiedInvitation {
  invitationId: string;
  userId: string;
  email: string;
  purpose: InvitationPurpose;
  expiresAt: Date;
}

/**
 * Generate a cryptographically secure random token (32 bytes, base64url encoded).
 * The database only stores SHA-256(token) - the plaintext is returned once
 * for the email link and never persisted.
 */
export function generateInvitationToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/** Hash a token for storage using SHA-256. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Compute the expiry date for a new invitation. */
export function computeExpiry(): Date {
  return new Date(Date.now() + INVITATION_EXPIRY_HOURS * 60 * 60 * 1000);
}

/** Prisma interactive transaction client (narrowed for invitation helpers). */
type TxClient = Parameters<Parameters<typeof prisma["$transaction"]>[0]>[0];

/**
 * Revoke all unused, unrevoked invitations for a user (any purpose).
 * Must be called when the user's email changes so links sent to the old
 * address cannot reset the new mailbox's password.
 */
export async function revokeAllPendingInvitationsInTransaction(
  tx: TxClient,
  userId: string,
): Promise<number> {
  const result = await tx.userInvitation.updateMany({
    where: {
      userId,
      usedAt: null,
      revokedAt: null,
    },
    data: { revokedAt: new Date() },
  });
  return result.count;
}

/**
 * Create a new invitation, revoking any existing unexpired/unconsumed ones
 * for the same user + purpose. Must be called inside a transaction.
 */
export async function createInvitationInTransaction(
  tx: TxClient,
  userId: string,
  purpose: InvitationPurpose,
  createdById: string,
): Promise<CreatedInvitation> {
  // Revoke existing unexpired, unused invitations for the same user + purpose
  await tx.userInvitation.updateMany({
    where: {
      userId,
      purpose,
      usedAt: null,
      revokedAt: null,
    },
    data: { revokedAt: new Date() },
  });

  const token = generateInvitationToken();
  const tokenHash = hashToken(token);
  const expiresAt = computeExpiry();

  const invitation = await tx.userInvitation.create({
    data: {
      userId,
      purpose,
      tokenHash,
      expiresAt,
      createdById,
    },
  });

  return { invitationId: invitation.id, token, expiresAt };
}

/**
 * Build the setup-account URL for an invitation token.
 */
export function buildInvitationUrl(token: string): string {
  return getAppUrl("/setup-account", { token });
}

/**
 * Verify a token without consuming it. Used by the verify endpoint to show
 * the user their email and the invitation purpose before they set a password.
 *
 * Returns a masked email (first 2 chars + ***@domain).
 */
export async function verifyInvitationToken(
  token: string,
): Promise<{ valid: true; data: VerifiedInvitation } | { valid: false }> {
  const tokenHash = hashToken(token);

  const invitation = await prisma.userInvitation.findUnique({
    where: { tokenHash },
    include: {
      user: { select: { id: true, email: true } },
    },
  });

  if (!invitation) return { valid: false };
  if (invitation.usedAt) return { valid: false };
  if (invitation.revokedAt) return { valid: false };
  if (invitation.expiresAt < new Date()) return { valid: false };

  return {
    valid: true,
    data: {
      invitationId: invitation.id,
      userId: invitation.userId,
      email: invitation.user.email,
      purpose: invitation.purpose as InvitationPurpose,
      expiresAt: invitation.expiresAt,
    },
  };
}

/**
 * Mask an email address for display (e.g. "zh***@example.com").
 */
export function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return email;
  const visible = local.slice(0, 2);
  return `${visible}${"*".repeat(Math.max(1, local.length - 2))}@${domain}`;
}

/**
 * Complete an invitation: set the user's password and mark the invitation as used.
 * Must be in a transaction. On success returns true; on conflict returns false.
 */
export async function completeInvitation(
  token: string,
  password: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const tokenHash = hashToken(token);

  return prisma.$transaction(async (tx) => {
    // Find and lock the invitation record
    const invitation = await tx.userInvitation.findUnique({
      where: { tokenHash },
      include: { user: { select: { id: true, email: true } } },
    });

    if (!invitation || invitation.usedAt || invitation.revokedAt || invitation.expiresAt < new Date()) {
      return { ok: false, error: "链接无效或已过期" };
    }

    // Validate password (policy uses trim); hash the trimmed value for
    // consistency with /api/me password changes.
    const trimmedPassword = password.trim();
    const pwValidation = validatePassword(trimmedPassword, invitation.user.email);
    if (!pwValidation.valid) {
      return { ok: false, error: pwValidation.error };
    }

    // Hash and set password
    const hashedPassword = await hashPassword(trimmedPassword);

    await tx.user.update({
      where: { id: invitation.userId },
      data: {
        password: hashedPassword,
        ...(invitation.purpose === "ACCOUNT_SETUP"
          ? { passwordInitialized: true }
          : {}),
      },
    });

    // Mark invitation as used
    await tx.userInvitation.update({
      where: { id: invitation.id },
      data: { usedAt: new Date() },
    });

    // Revoke other unused invitations of the same purpose for this user
    await tx.userInvitation.updateMany({
      where: {
        userId: invitation.userId,
        purpose: invitation.purpose,
        usedAt: null,
        revokedAt: null,
        id: { not: invitation.id },
      },
      data: { revokedAt: new Date() },
    });

    // Write audit log (anonymous - no session)
    await tx.activityLog.create({
      data: {
        type:
          invitation.purpose === "ACCOUNT_SETUP"
            ? "USER_INVITATION_COMPLETED"
            : "USER_PASSWORD_RESET_COMPLETED",
        content:
          invitation.purpose === "ACCOUNT_SETUP"
            ? "用户完成账号设置"
            : "用户完成密码重置",
        userId: null,
        metadata: JSON.stringify({
          targetUserId: invitation.userId,
          invitationId: invitation.id,
          purpose: invitation.purpose,
        }),
      },
    });

    return { ok: true };
  });
}

/**
 * Prepare email content for an invitation.
 */
export function buildInvitationEmail(
  purpose: InvitationPurpose,
  token: string,
  expiresAt: Date,
  adminName?: string,
): { subject: string; text: string; html: string } {
  const url = buildInvitationUrl(token);
  const expiryText = expiresAt.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
  const isAdminSetup = purpose === "ACCOUNT_SETUP";

  const subject = isAdminSetup
    ? "【SciManage】设置您的账号密码"
    : "【SciManage】重置您的账号密码";

  const action = isAdminSetup ? "设置账号密码" : "重置密码";
  const adminNote = adminName ? `\n管理员 ${adminName} 已为您创建账号，请通过以下链接${action}。\n` : "";

  const text = `您好，

${adminNote || `您正在${action}。`}
请点击以下链接${action}（链接有效期为 48 小时，截止至 ${expiryText}）：

${url}

如果您没有发起此操作，请忽略此邮件。

---
SciManage 科研项目管理平台`;

  const html = `
    <div style="font-family: sans-serif; max-width: 500px; margin: 0 auto;">
      <h2 style="color: #2563eb;">SciManage ${action}</h2>
      <p>您好，</p>
      ${adminName ? `<p>管理员 <strong>${adminName}</strong> 已为您创建账号，请通过以下链接${action}。</p>` : `<p>您正在${action}。</p>`}
      <p>请点击下方按钮${action}：</p>
      <p style="margin: 24px 0;">
        <a href="${url}" style="display: inline-block; background: #2563eb; color: #fff; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600;">${action}</a>
      </p>
      <p style="word-break: break-all; color: #64748b; font-size: 13px;">如果按钮无法点击，请复制以下链接：<br/>${url}</p>
      <p style="color: #64748b; font-size: 12px;">链接有效期为 48 小时，截止至 ${expiryText}。</p>
      <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 24px 0;" />
      <p style="color: #64748b; font-size: 12px;">如果您没有发起此操作，请忽略此邮件。</p>
      <p style="color: #64748b; font-size: 12px;">SciManage 科研项目管理平台</p>
    </div>
  `;

  return { subject, text, html };
}

export { generatePlaceholderPasswordHash };

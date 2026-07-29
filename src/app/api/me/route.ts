import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  validateUserInput,
  checkInternalAccountEmailConflict,
  validateUserPassword,
} from "@/lib/validation";
import { hashPassword, verifyPassword } from "@/lib/password";
import { isSalesManagedRole } from "@/lib/user-management/roles";
import {
  createInvitationInTransaction,
  revokeAllPendingInvitationsInTransaction,
  buildInvitationEmail,
} from "@/lib/user-management/invitations";
import type { InvitationDeliveryStatus } from "@/lib/user-management/types";
import { resolveInvitationDeliveryStatus } from "@/lib/user-management/types";
import { sendMail } from "@/lib/mail";

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      emailOnReminder: true,
      emailOnStatusChange: true,
      emailOnTicketReply: true,
      emailOnComment: true,
    },
  });

  if (!user) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ user });
}

export async function PUT(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const userId = session.user.id;

  try {
    const body = await req.json();
    const {
      name,
      email,
      currentPassword,
      newPassword,
      emailOnReminder,
      emailOnStatusChange,
      emailOnTicketReply,
      emailOnComment,
    } = body;

    if (name !== undefined && typeof name !== "string") {
      return NextResponse.json({ error: "姓名必须是字符串" }, { status: 400 });
    }
    if (email !== undefined && typeof email !== "string") {
      return NextResponse.json({ error: "邮箱必须是字符串" }, { status: 400 });
    }

    const existing = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        password: true,
        passwordInitialized: true,
      },
    });
    if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

    // Validation
    const validation = validateUserInput({ name, email });
    if (!validation.valid) {
      return NextResponse.json({ error: validation.error }, { status: validation.status });
    }

    const data: Record<string, unknown> = {};
    let requestedEmailChange: string | undefined;

    // Update basic info (sales-role / conflict gates are re-checked in-tx)
    if (name !== undefined) data.name = name.trim();
    if (email !== undefined) {
      const nextEmail = email.trim().toLowerCase();
      if (nextEmail !== existing.email) {
        // Fast pre-check; authoritative sales-role + conflict checks are in-tx
        if (isSalesManagedRole(existing.role)) {
          return NextResponse.json(
            { error: "代表/地区经理邮箱请在「代表管理」中维护" },
            { status: 403 },
          );
        }

        const conflict = await checkInternalAccountEmailConflict(nextEmail, userId);
        if (conflict.conflict) {
          return NextResponse.json({ error: conflict.error }, { status: conflict.status });
        }

        data.email = nextEmail;
        requestedEmailChange = nextEmail;
      }
    }

    // Update notification preferences
    if (emailOnReminder !== undefined) data.emailOnReminder = Boolean(emailOnReminder);
    if (emailOnStatusChange !== undefined) data.emailOnStatusChange = Boolean(emailOnStatusChange);
    if (emailOnTicketReply !== undefined) data.emailOnTicketReply = Boolean(emailOnTicketReply);
    if (emailOnComment !== undefined) data.emailOnComment = Boolean(emailOnComment);

    // Update password
    if (newPassword && typeof newPassword === "string" && newPassword.trim()) {
      if (!currentPassword || typeof currentPassword !== "string") {
        return NextResponse.json({ error: "请提供当前密码" }, { status: 400 });
      }
      const isValid = await verifyPassword(currentPassword, existing.password);
      if (!isValid) {
        return NextResponse.json({ error: "当前密码不正确" }, { status: 400 });
      }
      const pwValidation = validateUserPassword(newPassword, existing.email);
      if (!pwValidation.valid) {
        return NextResponse.json({ error: pwValidation.error }, { status: 400 });
      }
      data.password = await hashPassword(newPassword.trim());
    }

    if (Object.keys(data).length === 0) {
      return NextResponse.json({
        user: {
          id: existing.id,
          name: existing.name,
          email: existing.email,
        },
      });
    }

    const { updated, reissuedInvitation, appliedEmail } = await prisma.$transaction(
      async (tx) => {
        const current = await tx.user.findUnique({
          where: { id: userId },
          select: {
            id: true,
            email: true,
            role: true,
            passwordInitialized: true,
          },
        });
        if (!current) {
          throw new HttpError(404, "Not found");
        }

        const writeData: Record<string, unknown> = { ...data };
        let emailChanged = false;
        let normalizedEmail: string | undefined;

        if (requestedEmailChange !== undefined) {
          // Re-evaluate against the locked row (role may have changed since pre-check)
          if (isSalesManagedRole(current.role)) {
            throw new HttpError(403, "代表/地区经理邮箱请在「代表管理」中维护");
          }

          if (requestedEmailChange !== current.email) {
            const conflict = await checkInternalAccountEmailConflict(
              requestedEmailChange,
              userId,
              tx,
            );
            if (conflict.conflict) {
              throw new HttpError(conflict.status, conflict.error);
            }
            writeData.email = requestedEmailChange;
            normalizedEmail = requestedEmailChange;
            emailChanged = true;
          } else {
            // Concurrent update already applied the same email — drop no-op
            delete writeData.email;
          }
        }

        if (Object.keys(writeData).length === 0) {
          return {
            updated: await tx.user.findUniqueOrThrow({ where: { id: userId } }),
            reissuedInvitation: null,
            appliedEmail: undefined as string | undefined,
          };
        }

        const updatedUser = await tx.user.update({
          where: { id: userId },
          data: writeData,
        });

        let reissued = null;
        if (emailChanged && normalizedEmail) {
          await revokeAllPendingInvitationsInTransaction(tx, userId);

          // Pending activation: re-issue ACCOUNT_SETUP to the new email
          if (!current.passwordInitialized) {
            reissued = await createInvitationInTransaction(
              tx,
              userId,
              "ACCOUNT_SETUP",
              userId,
            );
          }
        }

        return {
          updated: updatedUser,
          reissuedInvitation: reissued,
          appliedEmail: normalizedEmail,
        };
      },
    );

    if (reissuedInvitation && appliedEmail) {
      let deliveryStatus: InvitationDeliveryStatus = "FAILED";
      try {
        const emailContent = buildInvitationEmail(
          "ACCOUNT_SETUP",
          reissuedInvitation.token,
          reissuedInvitation.expiresAt,
        );
        const mailResult = await sendMail({
          to: appliedEmail,
          subject: emailContent.subject,
          text: emailContent.text,
          html: emailContent.html,
        });
        deliveryStatus = resolveInvitationDeliveryStatus(mailResult.transport, false);
      } catch (emailError) {
        console.error("[PUT /api/me] Reissue email failed:", emailError);
        deliveryStatus = "FAILED";
      }

      try {
        await prisma.activityLog.create({
          data: {
            type: "USER_INVITATION_SENT",
            content: `邮箱变更后向 ${updated.name}（${updated.email}）重新签发账号设置邀请`,
            userId,
            metadata: JSON.stringify({
              targetUserId: userId,
              purpose: "ACCOUNT_SETUP",
              deliveryStatus,
              reason: "EMAIL_CHANGED",
              invitationId: reissuedInvitation.invitationId,
            }),
          },
        });
      } catch (auditError) {
        console.error("[PUT /api/me] Delivery audit write failed:", auditError);
      }
    }

    return NextResponse.json({
      user: {
        id: updated.id,
        name: updated.name,
        email: updated.email,
        role: updated.role,
        emailOnReminder: updated.emailOnReminder,
        emailOnStatusChange: updated.emailOnStatusChange,
        emailOnTicketReply: updated.emailOnTicketReply,
        emailOnComment: updated.emailOnComment,
      },
    });
  } catch (error) {
    if (error instanceof HttpError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error(error);
    return NextResponse.json({ error: "Failed to update profile" }, { status: 500 });
  }
}

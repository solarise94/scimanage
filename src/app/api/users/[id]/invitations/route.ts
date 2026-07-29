import { NextRequest, NextResponse } from "next/server";
import { requireCurrentAdmin, checkTargetEditable } from "@/lib/user-management/permissions";
import {
  createInvitationInTransaction,
  buildInvitationEmail,
  type InvitationPurpose,
} from "@/lib/user-management/invitations";
import type { InvitationDeliveryStatus } from "@/lib/user-management/types";
import { resolveInvitationDeliveryStatus } from "@/lib/user-management/types";
import { sendMail } from "@/lib/mail";
import { prisma } from "@/lib/prisma";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const adminCheck = await requireCurrentAdmin();
  if (!adminCheck.ok) {
    return NextResponse.json({ error: adminCheck.error }, { status: adminCheck.status });
  }
  const actor = adminCheck.actor;

  const { id } = await params;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求格式错误" }, { status: 400 });
  }

  const { purpose } = body;
  if (purpose !== "ACCOUNT_SETUP" && purpose !== "PASSWORD_RESET") {
    return NextResponse.json(
      { error: "purpose 必须是 ACCOUNT_SETUP 或 PASSWORD_RESET" },
      { status: 400 },
    );
  }

  // Check target is editable (not sales / region-manager / unknown role)
  const targetCheck = await checkTargetEditable(id);
  if (!targetCheck.editable) {
    return NextResponse.json(
      { error: targetCheck.error },
      { status: targetCheck.status },
    );
  }

  const targetUser = await prisma.user.findUnique({
    where: { id },
    select: { id: true, name: true, email: true, passwordInitialized: true, role: true },
  });
  if (!targetUser) {
    return NextResponse.json({ error: "用户不存在" }, { status: 404 });
  }

  // Validate purpose against user state
  if (purpose === "ACCOUNT_SETUP" && targetUser.passwordInitialized) {
    return NextResponse.json(
      { error: "该用户已激活，请使用密码重置" },
      { status: 400 },
    );
  }
  if (purpose === "PASSWORD_RESET" && !targetUser.passwordInitialized) {
    return NextResponse.json(
      { error: "该用户尚未激活，请使用重发邀请" },
      { status: 400 },
    );
  }

  // Get actor's name for email
  const actorUser = await prisma.user.findUnique({
    where: { id: actor.id },
    select: { name: true },
  });

  try {
    // Persist invitation only; delivery audit is written after sendMail resolves
    const invitation = await prisma.$transaction(async (tx) => {
      return createInvitationInTransaction(
        tx,
        id,
        purpose as InvitationPurpose,
        actor.id,
      );
    });

    let deliveryStatus: InvitationDeliveryStatus = "FAILED";
    try {
      const emailContent = buildInvitationEmail(
        purpose as InvitationPurpose,
        invitation.token,
        invitation.expiresAt,
        actorUser?.name,
      );
      const mailResult = await sendMail({
        to: targetUser.email,
        subject: emailContent.subject,
        text: emailContent.text,
        html: emailContent.html,
      });
      deliveryStatus = resolveInvitationDeliveryStatus(mailResult.transport, false);
    } catch (emailError) {
      console.error("[POST /api/users/[id]/invitations] Email send failed:", emailError);
      deliveryStatus = "FAILED";
    }

    try {
      await prisma.activityLog.create({
        data: {
          type:
            purpose === "ACCOUNT_SETUP"
              ? "USER_INVITATION_SENT"
              : "USER_PASSWORD_RESET_SENT",
          content:
            purpose === "ACCOUNT_SETUP"
              ? `重发账号设置邀请给 ${targetUser.name}（${targetUser.email}）`
              : `发送密码重置链接给 ${targetUser.name}（${targetUser.email}）`,
          userId: actor.id,
          metadata: JSON.stringify({
            targetUserId: id,
            purpose,
            deliveryStatus,
            invitationId: invitation.invitationId,
          }),
        },
      });
    } catch (auditError) {
      console.error(
        "[POST /api/users/[id]/invitations] Delivery audit write failed:",
        auditError,
      );
    }

    return NextResponse.json(
      {
        deliveryStatus,
        expiresAt: invitation.expiresAt,
      },
      { status: 201 },
    );
  } catch (error) {
    console.error("[POST /api/users/[id]/invitations]", error);
    return NextResponse.json({ error: "发送邀请失败" }, { status: 500 });
  }
}

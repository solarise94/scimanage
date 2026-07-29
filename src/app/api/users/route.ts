import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { requireCurrentAdmin } from "@/lib/user-management/permissions";
import { isAdminCreatableRole } from "@/lib/user-management/roles";
import {
  DEFAULT_DEPARTMENT,
  isDepartment,
  type Department,
} from "@/lib/department";
import {
  createInvitationInTransaction,
  buildInvitationEmail,
} from "@/lib/user-management/invitations";
import type { InvitationDeliveryStatus } from "@/lib/user-management/types";
import { resolveInvitationDeliveryStatus } from "@/lib/user-management/types";
import { generatePlaceholderPasswordHash } from "@/lib/password";
import { validateUserInput, checkInternalAccountEmailConflict } from "@/lib/validation";
import { sendMail } from "@/lib/mail";
import { prisma } from "@/lib/prisma";

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const search = searchParams.get("search");

  // When searching (for collaborator picker), allow any authenticated user.
  if (search) {
    const session = await getServerSession(authOptions);
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const users = await prisma.user.findMany({
      where: {
        OR: [
          { name: { contains: search } },
          { email: { contains: search } },
        ],
      },
      select: { id: true, email: true, name: true, role: true },
      orderBy: { name: "asc" },
      take: 20,
    });
    return NextResponse.json({ users });
  }

  // Full listing: ADMIN only (real-time DB check, not JWT)
  const adminCheck = await requireCurrentAdmin();
  if (!adminCheck.ok) {
    return NextResponse.json({ error: adminCheck.error }, { status: adminCheck.status });
  }

  const users = await prisma.user.findMany({
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      department: true,
      passwordInitialized: true,
      createdAt: true,
      invitationsReceived: {
        where: {
          purpose: "ACCOUNT_SETUP",
          usedAt: null,
        },
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { id: true, expiresAt: true, revokedAt: true, createdAt: true },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  // Map Prisma relation name to the frontend contract field `invitations`
  return NextResponse.json({
    users: users.map(({ invitationsReceived, ...user }) => ({
      ...user,
      invitations: invitationsReceived,
    })),
  });
}

export async function POST(req: NextRequest) {
  // Real-time DB ADMIN check (bypasses role cache)
  const adminCheck = await requireCurrentAdmin();
  if (!adminCheck.ok) {
    return NextResponse.json({ error: adminCheck.error }, { status: adminCheck.status });
  }
  const actor = adminCheck.actor;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求格式错误" }, { status: 400 });
  }

  const { name, email, role, department } = body;

  // Validate types
  if (typeof name !== "string" || typeof email !== "string") {
    return NextResponse.json({ error: "姓名和邮箱为必填项" }, { status: 400 });
  }

  if (!isAdminCreatableRole(role)) {
    return NextResponse.json(
      { error: "角色必须是 USER 或 ADMIN" },
      { status: 400 },
    );
  }

  // 部门校验：ADMIN 可显式指定；非法值 400；缺省 FIELD_SALES（设计 §3 / §4.1 / §1.3）
  let resolvedDepartment: Department = DEFAULT_DEPARTMENT;
  if (department !== undefined && department !== null) {
    if (!isDepartment(department)) {
      return NextResponse.json(
        { error: `部门必须是合法值，收到: ${String(department)}` },
        { status: 400 },
      );
    }
    resolvedDepartment = department;
  }

  // Validate name/email format
  const validation = validateUserInput({ name, email });
  if (!validation.valid) {
    return NextResponse.json({ error: validation.error }, { status: validation.status });
  }

  const trimmedName = name.trim();
  const normalizedEmail = email.trim().toLowerCase();

  // Cross-table email conflict check (User + Representative)
  const conflict = await checkInternalAccountEmailConflict(normalizedEmail);
  if (conflict.conflict) {
    return NextResponse.json({ error: conflict.error }, { status: conflict.status });
  }

  // Get actor's name for email
  const actorUser = await prisma.user.findUnique({
    where: { id: actor.id },
    select: { name: true },
  });

  try {
    // Create user + invitation + audit in a transaction
    const placeholderPassword = await generatePlaceholderPasswordHash();

    const { user, invitation } = await prisma.$transaction(async (tx) => {
      // Authoritative cross-table re-check inside the write transaction
      const inTxConflict = await checkInternalAccountEmailConflict(
        normalizedEmail,
        undefined,
        tx,
      );
      if (inTxConflict.conflict) {
        throw new HttpError(inTxConflict.status, inTxConflict.error);
      }

      const created = await tx.user.create({
        data: {
          name: trimmedName,
          email: normalizedEmail,
          password: placeholderPassword,
          role: role as string,
          department: resolvedDepartment,
          passwordInitialized: false,
        },
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          department: true,
          passwordInitialized: true,
          createdAt: true,
        },
      });

      // Create invitation
      const inv = await createInvitationInTransaction(
        tx,
        created.id,
        "ACCOUNT_SETUP",
        actor.id,
      );

      // Write audit log
      await tx.activityLog.create({
        data: {
          type: "USER_CREATED",
          content: `管理员 ${actorUser?.name ?? actor.id} 创建用户 ${trimmedName}（${normalizedEmail}），角色 ${role}`,
          userId: actor.id,
          metadata: JSON.stringify({
            targetUserId: created.id,
            name: trimmedName,
            email: normalizedEmail,
            role,
            department: resolvedDepartment,
          }),
        },
      });

      return { user: created, invitation: inv };
    });

    // Send invitation email after commit; audit records final delivery status
    let deliveryStatus: InvitationDeliveryStatus = "FAILED";
    try {
      const emailContent = buildInvitationEmail(
        "ACCOUNT_SETUP",
        invitation.token,
        invitation.expiresAt,
        actorUser?.name,
      );
      const mailResult = await sendMail({
        to: normalizedEmail,
        subject: emailContent.subject,
        text: emailContent.text,
        html: emailContent.html,
      });
      deliveryStatus = resolveInvitationDeliveryStatus(mailResult.transport, false);
    } catch (emailError) {
      console.error("[POST /api/users] Email send failed:", emailError);
      deliveryStatus = "FAILED";
    }

    try {
      await prisma.activityLog.create({
        data: {
          type: "USER_INVITATION_SENT",
          content: `向 ${trimmedName}（${normalizedEmail}）发送账号设置邀请`,
          userId: actor.id,
          metadata: JSON.stringify({
            targetUserId: user.id,
            purpose: "ACCOUNT_SETUP",
            deliveryStatus,
            invitationId: invitation.invitationId,
          }),
        },
      });
    } catch (auditError) {
      console.error("[POST /api/users] Delivery audit write failed:", auditError);
    }

    return NextResponse.json(
      {
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          department: user.department,
          passwordInitialized: user.passwordInitialized,
          createdAt: user.createdAt,
        },
        invitation: {
          deliveryStatus,
          expiresAt: invitation.expiresAt,
        },
      },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof HttpError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    // P2002 = unique constraint violation (email or tokenHash)
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "P2002"
    ) {
      return NextResponse.json(
        { error: "该邮箱已被使用" },
        { status: 409 },
      );
    }
    console.error("[POST /api/users]", error);
    return NextResponse.json({ error: "创建用户失败" }, { status: 500 });
  }
}

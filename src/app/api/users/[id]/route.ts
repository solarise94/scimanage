import { NextRequest, NextResponse } from "next/server";
import { requireCurrentAdmin, checkTargetEditable } from "@/lib/user-management/permissions";
import { isAdminEditableRole } from "@/lib/user-management/roles";
import { invalidateUserRole } from "@/lib/user-management/role-cache";
import { changeUserDepartment } from "@/lib/user-management/change-department";
import { isDepartment } from "@/lib/department";
import {
  ApplicationError,
  ConflictError as AppConflictError,
  ForbiddenError as AppForbiddenError,
  ValidationError as AppValidationError,
} from "@/lib/application/errors";
import {
  createInvitationInTransaction,
  revokeAllPendingInvitationsInTransaction,
  buildInvitationEmail,
  type CreatedInvitation,
} from "@/lib/user-management/invitations";
import type { InvitationDeliveryStatus } from "@/lib/user-management/types";
import { resolveInvitationDeliveryStatus } from "@/lib/user-management/types";
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

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // Real-time DB ADMIN check (bypasses role cache)
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

  const { name, email, role, department, password } = body;

  // Explicitly reject password field - password is managed via invitation flow
  if (password !== undefined) {
    return NextResponse.json(
      { error: "密码请通过密码重置链接修改，不支持在编辑接口中设置" },
      { status: 400 },
    );
  }

  // Runtime type checks (mirror POST /api/users)
  if (name !== undefined && typeof name !== "string") {
    return NextResponse.json({ error: "姓名必须是字符串" }, { status: 400 });
  }
  if (email !== undefined && typeof email !== "string") {
    return NextResponse.json({ error: "邮箱必须是字符串" }, { status: 400 });
  }
  if (role !== undefined && typeof role !== "string") {
    return NextResponse.json({ error: "角色必须是字符串" }, { status: 400 });
  }

  // 部门校验（设计 §3）：仅 ADMIN 可改（本 route 已强制 ADMIN），非法值 400。
  // 实际变更走 changeUserDepartment（含 §5.2 前置检查、审计与缓存失效），不在此处裸写。
  if (department !== undefined && department !== null) {
    if (!isDepartment(department)) {
      return NextResponse.json(
        { error: `部门必须是合法值，收到: ${String(department)}` },
        { status: 400 },
      );
    }
  }

  // Validate role if provided
  if (role !== undefined && !isAdminEditableRole(role)) {
    return NextResponse.json(
      { error: "角色必须是 USER 或 ADMIN" },
      { status: 400 },
    );
  }

  // Validate name/email format
  const validation = validateUserInput({ name, email });
  if (!validation.valid) {
    return NextResponse.json({ error: validation.error }, { status: validation.status });
  }

  // Email conflict check across User + Representative
  if (email !== undefined) {
    const conflict = await checkInternalAccountEmailConflict(email, id);
    if (conflict.conflict) {
      return NextResponse.json({ error: conflict.error }, { status: conflict.status });
    }
  }

  // Check target exists and is editable (not sales / region-manager / unknown role)
  const targetCheck = await checkTargetEditable(id);
  if (!targetCheck.editable) {
    return NextResponse.json(
      { error: targetCheck.error },
      { status: targetCheck.status },
    );
  }

  const actorUser = await prisma.user.findUnique({
    where: { id: actor.id },
    select: { name: true },
  });

  try {
    // All role/email-sensitive reads and writes happen inside one transaction.
    const { updated, changes, reissuedInvitation } = await prisma.$transaction(async (tx) => {
      const existing = await tx.user.findUnique({
        where: { id },
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          department: true,
          passwordInitialized: true,
        },
      });
      if (!existing) {
        throw new HttpError(404, "用户不存在");
      }

      // Re-check editability against the locked row's current role
      if (!isAdminEditableRole(existing.role)) {
        throw new HttpError(409, `该账号角色（${existing.role}）不在用户管理范围内，请先治理数据`);
      }

      const changes: { field: string; from: unknown; to: unknown }[] = [];
      const data: Record<string, unknown> = {};
      let emailChanged = false;
      let normalizedEmail: string | undefined;

      if (name !== undefined) {
        const trimmedName = name.trim();
        if (trimmedName !== existing.name) {
          data.name = trimmedName;
          changes.push({ field: "name", from: existing.name, to: trimmedName });
        }
      }

      if (email !== undefined) {
        normalizedEmail = email.trim().toLowerCase();
        if (normalizedEmail !== existing.email) {
          // Authoritative cross-table re-check inside the write transaction
          const inTxConflict = await checkInternalAccountEmailConflict(
            normalizedEmail,
            id,
            tx,
          );
          if (inTxConflict.conflict) {
            throw new HttpError(inTxConflict.status, inTxConflict.error);
          }
          data.email = normalizedEmail;
          changes.push({ field: "email", from: existing.email, to: normalizedEmail });
          emailChanged = true;
        }
      }

      if (role !== undefined && role !== existing.role) {
        const newRole = role;
        const oldRole = existing.role;

        if (!isAdminEditableRole(oldRole) || !isAdminEditableRole(newRole)) {
          throw new HttpError(400, "角色变更仅允许在 USER 和 ADMIN 之间切换");
        }

        // Demotion from ADMIN -> USER
        if (oldRole === "ADMIN" && newRole === "USER") {
          if (existing.id === actor.id) {
            throw new HttpError(409, "不能降低自己的管理员权限，请由另一名管理员操作");
          }

          // Count inside the same transaction as the update
          const adminCount = await tx.user.count({ where: { role: "ADMIN" } });
          if (adminCount <= 1) {
            throw new HttpError(409, "系统必须至少保留一名管理员");
          }
        }

        data.role = newRole;
        changes.push({ field: "role", from: oldRole, to: newRole });
      }

      if (Object.keys(data).length === 0) {
        return {
          updated: {
            id: existing.id,
            name: existing.name,
            email: existing.email,
            role: existing.role,
            department: existing.department,
            createdAt: undefined as Date | undefined,
          },
          changes,
          reissuedInvitation: null as CreatedInvitation | null,
        };
      }

      const result = await tx.user.update({
        where: { id },
        data,
        select: { id: true, name: true, email: true, role: true, department: true, createdAt: true },
      });

      // After demotion, verify at least one ADMIN remains (race-safe on SQLite)
      if (changes.some((c) => c.field === "role" && c.from === "ADMIN" && c.to === "USER")) {
        const remainingAdmins = await tx.user.count({ where: { role: "ADMIN" } });
        if (remainingAdmins < 1) {
          throw new HttpError(409, "系统必须至少保留一名管理员");
        }
      }

      let reissuedInvitation: CreatedInvitation | null = null;

      if (emailChanged) {
        // Invalidate links sent to the old mailbox before they can take over the new one
        await revokeAllPendingInvitationsInTransaction(tx, id);

        // Pending activation: re-issue ACCOUNT_SETUP to the new email
        if (!existing.passwordInitialized) {
          reissuedInvitation = await createInvitationInTransaction(
            tx,
            id,
            "ACCOUNT_SETUP",
            actor.id,
          );
        }
      }

      const roleChanged = changes.some((c) => c.field === "role");
      await tx.activityLog.create({
        data: {
          type: roleChanged ? "USER_ROLE_CHANGED" : "USER_PROFILE_UPDATED",
          content: roleChanged
            ? `用户 ${existing.name} 角色从 ${changes.find((c) => c.field === "role")?.from} 变更为 ${changes.find((c) => c.field === "role")?.to}`
            : `更新用户 ${existing.name} 的资料`,
          userId: actor.id,
          metadata: JSON.stringify({
            targetUserId: id,
            changes,
            invitationsRevoked: emailChanged,
            accountSetupReissued: Boolean(reissuedInvitation),
          }),
        },
      });

      return { updated: result, changes, reissuedInvitation };
    });

    // Invalidate role cache if role changed
    if (changes.some((c) => c.field === "role")) {
      invalidateUserRole(id);
    }

    // 部门变更走专门的 §5.2 服务：前置检查、审计、缓存失效都封装在内部事务。
    // 放在主事务提交之后，避免前置检查 409 时回滚已生效的 name/email/role（保持 PATCH 语义清晰）。
    let finalDepartment = updated.department;
    if (department !== undefined && department !== null) {
      const result = await changeUserDepartment({
        actor: { id: actor.id, role: actor.role },
        targetUserId: id,
        newDepartment: department as string,
      });
      finalDepartment = result.toDepartment;
    }

    let invitationDelivery: {
      deliveryStatus: InvitationDeliveryStatus;
      expiresAt: Date;
    } | null = null;

    // Send reissued ACCOUNT_SETUP after commit; audit records final delivery status
    if (reissuedInvitation) {
      let deliveryStatus: InvitationDeliveryStatus = "FAILED";
      try {
        const emailContent = buildInvitationEmail(
          "ACCOUNT_SETUP",
          reissuedInvitation.token,
          reissuedInvitation.expiresAt,
          actorUser?.name,
        );
        const mailResult = await sendMail({
          to: updated.email,
          subject: emailContent.subject,
          text: emailContent.text,
          html: emailContent.html,
        });
        deliveryStatus = resolveInvitationDeliveryStatus(mailResult.transport, false);
      } catch (emailError) {
        console.error("[PUT /api/users/[id]] Reissue email failed:", emailError);
        deliveryStatus = "FAILED";
      }

      try {
        await prisma.activityLog.create({
          data: {
            type: "USER_INVITATION_SENT",
            content: `邮箱变更后向 ${updated.name}（${updated.email}）重新签发账号设置邀请`,
            userId: actor.id,
            metadata: JSON.stringify({
              targetUserId: id,
              purpose: "ACCOUNT_SETUP",
              deliveryStatus,
              reason: "EMAIL_CHANGED",
              invitationId: reissuedInvitation.invitationId,
            }),
          },
        });
      } catch (auditError) {
        console.error("[PUT /api/users/[id]] Delivery audit write failed:", auditError);
      }

      invitationDelivery = {
        deliveryStatus,
        expiresAt: reissuedInvitation.expiresAt,
      };
    }

    return NextResponse.json({
      user: {
        id: updated.id,
        name: updated.name,
        email: updated.email,
        role: updated.role,
        department: finalDepartment,
        createdAt: updated.createdAt,
      },
      ...(invitationDelivery
        ? {
            invitation: {
              deliveryStatus: invitationDelivery.deliveryStatus,
              expiresAt: invitationDelivery.expiresAt,
            },
          }
        : {}),
    });
  } catch (error) {
    if (error instanceof HttpError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    // 部门变更服务抛出的应用错误（前置检查 409 / 非法部门 400 / 非管理员 403）
    if (error instanceof AppConflictError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof AppValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof AppForbiddenError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    if (error instanceof ApplicationError) {
      return NextResponse.json({ error: error.message }, { status: error.httpStatus });
    }
    // P2002 = unique constraint violation (email)
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "P2002"
    ) {
      return NextResponse.json({ error: "该邮箱已被使用" }, { status: 409 });
    }
    console.error("[PUT /api/users/[id]]", error);
    return NextResponse.json({ error: "更新用户失败" }, { status: 500 });
  }
}

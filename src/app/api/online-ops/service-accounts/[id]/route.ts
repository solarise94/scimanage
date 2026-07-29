import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  assertCanManageServiceAccounts,
  assertCanWriteServiceAccount,
  assertOwnerDepartmentOnlineOps,
  type ServiceAccountActor,
} from "@/lib/online-ops/service-account-permissions";
import { mapError } from "../route";

/**
 * 客服账号单条管理（设计 §4.6 / §10）。
 * PATCH /api/online-ops/service-accounts/[id]
 *   body: { name?, ownerUserId?, status? }
 *   - 改 owner：新 owner 必须属于 ONLINE_OPS；ADMIN 可改任意，USER 只能操作自己名下记录
 *     （把客服号转给其他人需要 ADMIN，因为 USER 改 owner 后 owner 不再是自己 → 失去管理权）。
 *   - 停用/启用：status ACTIVE|DISABLED。
 *
 * 权限：ADMIN 全部；ONLINE_OPS USER 仅自己名下；其他部门非 ADMIN 403。
 */
export const dynamic = "force-dynamic";

function toActor(session: {
  user: { id: string; role: string; department: string };
}): ServiceAccountActor {
  return {
    userId: session.user.id,
    role: session.user.role,
    department: session.user.department,
  };
}

type PatchBody = {
  name?: unknown;
  ownerUserId?: unknown;
  status?: unknown;
};

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || !session.user.role) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const actor = toActor(session);

  try {
    assertCanManageServiceAccounts(actor);
  } catch (err) {
    return mapError(err);
  }

  const { id } = await params;

  const existing = await prisma.customerServiceAccount.findUnique({
    where: { id },
    select: { id: true, ownerUserId: true, wechatId: true },
  });
  if (!existing) {
    return NextResponse.json({ error: "客服账号不存在" }, { status: 404 });
  }

  // 非 ADMIN 只能操作自己名下（越权合并 404）。
  try {
    assertCanWriteServiceAccount(actor, existing.ownerUserId);
  } catch (err) {
    return mapError(err);
  }

  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "请求体必须是 JSON" }, { status: 400 });
  }

  const data: {
    name?: string;
    ownerUserId?: string;
    status?: string;
  } = {};

  if (typeof body.name === "string") {
    const name = body.name.trim();
    if (!name) {
      return NextResponse.json({ error: "name 不能为空" }, { status: 400 });
    }
    data.name = name;
  }

  if (typeof body.status === "string") {
    if (body.status !== "ACTIVE" && body.status !== "DISABLED") {
      return NextResponse.json(
        { error: "status 必须为 ACTIVE 或 DISABLED" },
        { status: 400 },
      );
    }
    data.status = body.status;
  }

  if (typeof body.ownerUserId === "string") {
    const newOwnerUserId = body.ownerUserId.trim();
    if (!newOwnerUserId) {
      return NextResponse.json({ error: "ownerUserId 不能为空" }, { status: 400 });
    }
    if (newOwnerUserId !== existing.ownerUserId) {
      // 改 owner 需要 ADMIN：USER 改完会失去对该号的管理权，必须由 ADMIN 代操作。
      if (actor.role !== "ADMIN") {
        return NextResponse.json(
          { error: "变更客服号负责人需要管理员权限" },
          { status: 403 },
        );
      }
      const owner = await prisma.user.findUnique({
        where: { id: newOwnerUserId },
        select: { id: true, department: true },
      });
      if (!owner) {
        return NextResponse.json({ error: "负责人不存在" }, { status: 400 });
      }
      assertOwnerDepartmentOnlineOps(owner.department);
      data.ownerUserId = newOwnerUserId;
    }
  }

  try {
    const updated = await prisma.customerServiceAccount.update({
      where: { id },
      data,
      include: {
        ownerUser: { select: { id: true, name: true, email: true } },
      },
    });
    return NextResponse.json({
      id: updated.id,
      wechatId: updated.wechatId,
      name: updated.name,
      department: updated.department,
      ownerUserId: updated.ownerUserId,
      ownerName: updated.ownerUser.name ?? null,
      status: updated.status,
      updatedAt: updated.updatedAt.toISOString(),
    });
  } catch (err) {
    return mapError(err);
  }
}

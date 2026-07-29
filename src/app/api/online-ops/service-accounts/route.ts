import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  assertCanManageServiceAccounts,
  assertOwnerDepartmentOnlineOps,
  assertServiceAccountDepartment,
  serviceAccountListOwnerFilter,
  type ServiceAccountActor,
} from "@/lib/online-ops/service-account-permissions";

/**
 * 客服账号管理（设计 §4.6 / §10）。
 * GET  /api/online-ops/service-accounts      列表（ADMIN 全部；ONLINE_OPS USER 自己名下）
 * POST /api/online-ops/service-accounts      创建
 *
 * 权限：ADMIN 全部；ONLINE_OPS USER 管理 ownerUserId=自己 的客服号；其他部门非 ADMIN 403。
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

export async function GET(req: NextRequest) {
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

  const { searchParams } = req.nextUrl;
  const status = searchParams.get("status") || undefined;
  const ownerFilter = serviceAccountListOwnerFilter(actor);

  const where: Record<string, unknown> = {};
  if (ownerFilter) where.ownerUserId = ownerFilter;
  if (status === "ACTIVE" || status === "DISABLED") where.status = status;

  const items = await prisma.customerServiceAccount.findMany({
    where,
    orderBy: { createdAt: "desc" },
    include: {
      ownerUser: { select: { id: true, name: true, email: true } },
    },
  });

  return NextResponse.json({
    items: items.map((a) => ({
      id: a.id,
      wechatId: a.wechatId,
      name: a.name,
      department: a.department,
      ownerUserId: a.ownerUserId,
      ownerName: a.ownerUser.name ?? null,
      ownerEmail: a.ownerUser.email ?? null,
      status: a.status,
      createdAt: a.createdAt.toISOString(),
      updatedAt: a.updatedAt.toISOString(),
    })),
  });
}

type CreateBody = {
  wechatId?: unknown;
  name?: unknown;
  ownerUserId?: unknown;
  department?: unknown;
};

export async function POST(req: NextRequest) {
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

  let body: CreateBody;
  try {
    body = (await req.json()) as CreateBody;
  } catch {
    return NextResponse.json({ error: "请求体必须是 JSON" }, { status: 400 });
  }

  const wechatId =
    typeof body.wechatId === "string" ? body.wechatId.trim() : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const ownerUserId =
    typeof body.ownerUserId === "string" ? body.ownerUserId.trim() : "";
  // 部门：非 ADMIN 强制 ONLINE_OPS；ADMIN 可传但必须合法且为 ONLINE_OPS（第一期）。
  const department =
    actor.role === "ADMIN" && typeof body.department === "string"
      ? body.department
      : "ONLINE_OPS";

  if (!wechatId) {
    return NextResponse.json({ error: "wechatId 为必填" }, { status: 400 });
  }
  if (!name) {
    return NextResponse.json({ error: "name 为必填" }, { status: 400 });
  }
  if (!ownerUserId) {
    return NextResponse.json({ error: "ownerUserId 为必填" }, { status: 400 });
  }

  try {
    assertServiceAccountDepartment(department);
    // 校验 owner 存在且属于 ONLINE_OPS（防越权指派）。
    const owner = await prisma.user.findUnique({
      where: { id: ownerUserId },
      select: { id: true, department: true },
    });
    if (!owner) {
      return NextResponse.json({ error: "负责人不存在" }, { status: 400 });
    }
    assertOwnerDepartmentOnlineOps(owner.department);

    const created = await prisma.customerServiceAccount.create({
      data: {
        wechatId,
        name,
        department,
        ownerUserId,
        status: "ACTIVE",
      },
      include: {
        ownerUser: { select: { id: true, name: true, email: true } },
      },
    });
    return NextResponse.json(
      {
        id: created.id,
        wechatId: created.wechatId,
        name: created.name,
        department: created.department,
        ownerUserId: created.ownerUserId,
        ownerName: created.ownerUser.name ?? null,
        status: created.status,
        createdAt: created.createdAt.toISOString(),
        updatedAt: created.updatedAt.toISOString(),
      },
      { status: 201 },
    );
  } catch (err) {
    if (
      err instanceof Error &&
      err.message.includes("Unique constraint")
    ) {
      return NextResponse.json(
        { error: "wechatId 已存在" },
        { status: 409 },
      );
    }
    return mapError(err);
  }
}

function mapError(err: unknown): NextResponse {
  const e = err as { code?: string; httpStatus?: number; message?: string };
  if (e?.code && typeof e.httpStatus === "number") {
    return NextResponse.json({ error: e.message ?? e.code }, { status: e.httpStatus });
  }
  return NextResponse.json(
    { error: err instanceof Error ? err.message : "Internal error" },
    { status: 500 },
  );
}

export { mapError };

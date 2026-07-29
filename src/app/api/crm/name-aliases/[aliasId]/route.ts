import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertCrmProfileAccess } from "@/lib/crm/permissions";
import {
  normalizeCustomerNameAlias,
  NAME_ALIAS_TYPE,
  parseNameAliasType,
} from "@/lib/customers/customer-name-alias";
import { isAdmin } from "@/lib/role-guards";

/**
 * PATCH /api/crm/name-aliases/[aliasId]
 * 更新称呼（alias/aliasType）或软停用（active=false）。
 * - 手工记录的创建者或 ADMIN 可编辑/停用。
 * - sourceType=CUSTOMER_MERGE 的记录只有 ADMIN 可停用/删除（docs §11.1）。
 * - 不接受把 MERGED_NAME 静默改成 COMMON。
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ aliasId: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { aliasId } = await params;
  const alias = await prisma.crmCustomerNameAlias.findUnique({ where: { id: aliasId } });
  if (!alias) return NextResponse.json({ error: "称呼不存在" }, { status: 404 });

  await assertCrmProfileAccess(alias.profileId, session.user.id, session.user.role);

  const body = await req.json();
  const admin = isAdmin(session.user.role);

  // 系统来源记录只有 ADMIN 可停用/修改
  if (alias.sourceType === "CUSTOMER_MERGE" && !admin) {
    return NextResponse.json({ error: "合并生成的称呼只有管理员可修改" }, { status: 403 });
  }

  // 非创建者非 ADMIN 不能改手工记录
  if (alias.sourceType !== "CUSTOMER_MERGE" && alias.createdById !== session.user.id && !admin) {
    return NextResponse.json({ error: "只能修改自己创建的称呼" }, { status: 403 });
  }

  const updateData: Record<string, unknown> = {};

  if (typeof body.active === "boolean") {
    updateData.active = body.active;
  }

  if (typeof body.alias === "string") {
    const raw = body.alias.trim();
    if (!raw) return NextResponse.json({ error: "称呼不能为空" }, { status: 400 });
    const normalized = normalizeCustomerNameAlias(raw);
    if (!normalized) return NextResponse.json({ error: "称呼归一化后为空" }, { status: 400 });
    // 与正式姓名相同则拒绝
    const profile = await prisma.crmCustomerProfile.findUnique({
      where: { id: alias.profileId },
      select: { name: true },
    });
    if (profile?.name && normalizeCustomerNameAlias(profile.name) === normalized) {
      return NextResponse.json({ error: "称呼与正式姓名相同" }, { status: 400 });
    }
    // normalized 变了要查冲突
    if (normalized !== alias.normalizedAlias) {
      const conflict = await prisma.crmCustomerNameAlias.findFirst({
        where: { profileId: alias.profileId, normalizedAlias: normalized, id: { not: alias.id } },
      });
      if (conflict) {
        return NextResponse.json({
          error: "该归一化称呼已存在",
          code: "ALIAS_CONFLICT",
          existing: { id: conflict.id, alias: conflict.alias, aliasType: conflict.aliasType },
        }, { status: 409 });
      }
    }
    updateData.alias = raw;
    updateData.normalizedAlias = normalized;
  }

  if (typeof body.aliasType === "string") {
    const newType = parseNameAliasType(body.aliasType);
    // 不接受通过普通 PATCH 把 MERGED_NAME 改成 COMMON（docs §11.1 §4）
    if (alias.aliasType === NAME_ALIAS_TYPE.MERGED_NAME && newType !== NAME_ALIAS_TYPE.MERGED_NAME && !admin) {
      return NextResponse.json({ error: "不能把合并姓名降级为常用称呼" }, { status: 400 });
    }
    // MERGED_NAME 只能由合并流程创建，PATCH 不能提升到 MERGED_NAME
    if (newType === NAME_ALIAS_TYPE.MERGED_NAME && alias.aliasType !== NAME_ALIAS_TYPE.MERGED_NAME) {
      return NextResponse.json({ error: "合并姓名只能由客户合并流程自动创建" }, { status: 400 });
    }
    updateData.aliasType = newType;
  }

  if (Object.keys(updateData).length === 0) {
    return NextResponse.json({ alias });
  }

  const updated = await prisma.crmCustomerNameAlias.update({
    where: { id: aliasId },
    data: updateData,
  });

  return NextResponse.json({ alias: updated });
}

/**
 * DELETE /api/crm/name-aliases/[aliasId]
 * 优先软停用（active=false）；硬删除仅 ADMIN。
 */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ aliasId: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { aliasId } = await params;
  const alias = await prisma.crmCustomerNameAlias.findUnique({ where: { id: aliasId } });
  if (!alias) return NextResponse.json({ error: "称呼不存在" }, { status: 404 });

  await assertCrmProfileAccess(alias.profileId, session.user.id, session.user.role);

  const admin = isAdmin(session.user.role);
  const force = req.nextUrl.searchParams.get("force") === "true";

  // 系统来源记录只有 ADMIN 可停用/删除
  if (alias.sourceType === "CUSTOMER_MERGE" && !admin) {
    return NextResponse.json({ error: "合并生成的称呼只有管理员可修改" }, { status: 403 });
  }
  // 非创建者非 ADMIN 不能停用或硬删除手工记录（docs §11.1：创建者或 ADMIN 可编辑/停用）
  if (alias.sourceType !== "CUSTOMER_MERGE" && alias.createdById !== session.user.id && !admin) {
    return NextResponse.json({ error: "只能修改自己创建的称呼" }, { status: 403 });
  }

  if (force && admin) {
    await prisma.crmCustomerNameAlias.delete({ where: { id: aliasId } });
    return NextResponse.json({ deleted: true });
  }

  // 默认软停用
  if (!alias.active) {
    return NextResponse.json({ alias, message: "称呼已停用" });
  }
  const updated = await prisma.crmCustomerNameAlias.update({
    where: { id: aliasId },
    data: { active: false },
  });

  return NextResponse.json({ alias: updated, deactivated: true });
}

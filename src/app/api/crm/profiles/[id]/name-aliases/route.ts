import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertCrmProfileAccess } from "@/lib/crm/permissions";
import {
  normalizeCustomerNameAlias,
  NAME_ALIAS_TYPE,
  parseNameAliasType,
  type NameAliasType,
} from "@/lib/customers/customer-name-alias";

/**
 * GET /api/crm/profiles/[id]/name-aliases
 * 列出 profile 的全部姓名变体（含停用）。
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  await assertCrmProfileAccess(id, session.user.id, session.user.role);

  const aliases = await prisma.crmCustomerNameAlias.findMany({
    where: { profileId: id },
    orderBy: [{ active: "desc" }, { createdAt: "asc" }],
  });

  return NextResponse.json({ aliases });
}

/**
 * POST /api/crm/profiles/[id]/name-aliases
 * 新增称呼变体。MERGED_NAME 只能由合并流程自动创建，API 不接受。
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  await assertCrmProfileAccess(id, session.user.id, session.user.role);

  const body = await req.json();
  const raw = typeof body.alias === "string" ? body.alias.trim() : "";
  const aliasType = parseNameAliasType(body.aliasType);

  if (!raw) {
    return NextResponse.json({ error: "称呼不能为空" }, { status: 400 });
  }
  // MERGED_NAME 只能由合并流程自动创建，不接受普通用户伪造（docs §11.1）
  if (aliasType === NAME_ALIAS_TYPE.MERGED_NAME) {
    return NextResponse.json({ error: "合并姓名只能由客户合并流程自动创建" }, { status: 400 });
  }

  const normalized = normalizeCustomerNameAlias(raw);
  if (!normalized) {
    return NextResponse.json({ error: "称呼归一化后为空" }, { status: 400 });
  }

  // 与正式姓名相同则拒绝
  const profile = await prisma.crmCustomerProfile.findUnique({
    where: { id },
    select: { name: true },
  });
  if (profile?.name && normalizeCustomerNameAlias(profile.name) === normalized) {
    return NextResponse.json({ error: "称呼与正式姓名相同" }, { status: 400 });
  }

  // 冲突检查（docs §11.1）：同 Profile 下同 normalizedAlias
  const existing = await prisma.crmCustomerNameAlias.findFirst({
    where: { profileId: id, normalizedAlias: normalized },
  });
  if (existing) {
    // 新增 COMMON 与现有 MERGED_NAME/FORMER_NAME 冲突：拒绝，不降级、不覆盖
    if (aliasType === NAME_ALIAS_TYPE.COMMON && existing.aliasType !== NAME_ALIAS_TYPE.COMMON) {
      return NextResponse.json({
        error: "该称呼已作为更高可信历史姓名存在",
        code: "ALIAS_CONFLICT_HIGHER_TYPE",
        existing: { id: existing.id, alias: existing.alias, aliasType: existing.aliasType },
      }, { status: 409 });
    }
    // 新增 COMMON 与现有 COMMON 冲突：幂等成功
    if (aliasType === NAME_ALIAS_TYPE.COMMON && existing.aliasType === NAME_ALIAS_TYPE.COMMON) {
      // 如果已停用，恢复
      if (!existing.active) {
        const updated = await prisma.crmCustomerNameAlias.update({
          where: { id: existing.id },
          data: { active: true, alias: raw },
        });
        return NextResponse.json({ alias: updated, reused: true });
      }
      return NextResponse.json({ alias: existing, reused: true });
    }
    // 其他冲突（如新增 FORMER_NAME 命中已有记录）
    return NextResponse.json({
      error: "该称呼已存在",
      code: "ALIAS_CONFLICT",
      existing: { id: existing.id, alias: existing.alias, aliasType: existing.aliasType },
    }, { status: 409 });
  }

  const created = await prisma.crmCustomerNameAlias.create({
    data: {
      profileId: id,
      alias: raw,
      normalizedAlias: normalized,
      aliasType,
      sourceType: "MANUAL",
      createdById: session.user.id,
      active: true,
    },
  });

  return NextResponse.json({ alias: created }, { status: 201 });
}

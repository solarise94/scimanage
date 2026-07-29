import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertCrmProfileAccess } from "@/lib/crm/permissions";
import {
  PREFERENCE_CATEGORY,
} from "@/lib/crm/constants";
import { createManualPreference } from "@/lib/crm/preferences";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id: profileId } = await params;

  try {
    await assertCrmProfileAccess(profileId, session.user.id, session.user.role);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "";
    if (msg === "NOT_FOUND") return NextResponse.json({ error: "Profile not found" }, { status: 404 });
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const preferences = await prisma.crmCustomerPreference.findMany({
    where: { profileId, status: { not: "ARCHIVED" } },
    orderBy: [{ pinned: "desc" }, { updatedAt: "desc" }],
  });

  return NextResponse.json({ preferences });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id: profileId } = await params;

  try {
    await assertCrmProfileAccess(profileId, session.user.id, session.user.role);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "";
    if (msg === "NOT_FOUND") return NextResponse.json({ error: "Profile not found" }, { status: 404 });
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json();
  const { category, label, valueText, valueJson, pinned, note } = body;

  if (!category || !label?.trim()) {
    return NextResponse.json({ error: "category 和 label 为必填" }, { status: 400 });
  }
  if (!PREFERENCE_CATEGORY.includes(category)) {
    return NextResponse.json({ error: `无效的 category: ${category}` }, { status: 400 });
  }

  // 人工偏好 key 用 random 防碰撞（自动洞察 key 由 sourceType+规则生成）
  const key = `manual:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;

  try {
    const preference = await createManualPreference({
      profileId,
      category,
      key,
      label: label.trim(),
      valueText: valueText?.trim() || undefined,
      valueJson: valueJson || undefined,
      pinned: !!pinned,
      note: note?.trim() || undefined,
      actorUserId: session.user.id,
    });
    return NextResponse.json({ preference }, { status: 201 });
  } catch {
    return NextResponse.json({ error: "创建偏好失败" }, { status: 500 });
  }
}

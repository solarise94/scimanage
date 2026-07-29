import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertCrmProfileAccess } from "@/lib/crm/permissions";
import {
  PREFERENCE_REVIEW_STATUS,
  PREFERENCE_STATUS,
} from "@/lib/crm/constants";
import { updatePreference } from "@/lib/crm/preferences";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ preferenceId: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { preferenceId } = await params;

  const existing = await prisma.crmCustomerPreference.findUnique({
    where: { id: preferenceId },
    select: { id: true, profileId: true },
  });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // profile 级权限校验
  try {
    await assertCrmProfileAccess(existing.profileId, session.user.id, session.user.role);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "";
    if (msg === "NOT_FOUND") return NextResponse.json({ error: "Profile not found" }, { status: 404 });
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json();

  // 校验枚举值
  if (body.status !== undefined && !PREFERENCE_STATUS.includes(body.status)) {
    return NextResponse.json({ error: `无效的 status: ${body.status}` }, { status: 400 });
  }
  if (body.reviewStatus !== undefined && !PREFERENCE_REVIEW_STATUS.includes(body.reviewStatus)) {
    return NextResponse.json({ error: `无效的 reviewStatus: ${body.reviewStatus}` }, { status: 400 });
  }

  try {
    const preference = await updatePreference({
      preferenceId,
      actorUserId: session.user.id,
      role: session.user.role,
      label: body.label,
      valueText: body.valueText,
      valueJson: body.valueJson,
      note: body.note,
      pinned: body.pinned,
      status: body.status,
      reviewStatus: body.reviewStatus,
    });
    return NextResponse.json({ preference });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "";
    if (msg === "NOT_FOUND") return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (msg === "FORBIDDEN") return NextResponse.json({ error: "无权编辑此偏好" }, { status: 403 });
    return NextResponse.json({ error: "更新偏好失败" }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ preferenceId: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // 硬删除仅 ADMIN
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "仅管理员可硬删除偏好" }, { status: 403 });
  }

  const { preferenceId } = await params;

  const existing = await prisma.crmCustomerPreference.findUnique({
    where: { id: preferenceId },
    select: { id: true },
  });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await prisma.crmCustomerPreference.delete({ where: { id: preferenceId } });
  return NextResponse.json({ ok: true });
}

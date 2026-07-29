import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertCrmProfileAccess } from "@/lib/crm/permissions";
import {
  COMPLAINT_CATEGORY,
  COMPLAINT_SEVERITY,
} from "@/lib/crm/constants";
import { createComplaint } from "@/lib/crm/complaints";
import { validateComplaintRelatedRefs } from "@/lib/crm/complaint-refs";

export async function GET(
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

  const { searchParams } = new URL(req.url);
  const status = searchParams.get("status");

  const complaints = await prisma.crmComplaint.findMany({
    where: {
      profileId,
      ...(status ? { status } : {}),
    },
    orderBy: [{ status: "asc" }, { updatedAt: "desc" }],
    select: {
      id: true,
      title: true,
      category: true,
      severity: true,
      status: true,
      ownerUserId: true,
      ownerUser: { select: { id: true, name: true } },
      relatedOrderId: true,
      relatedProjectId: true,
      relatedInteractionId: true,
      expectedResolutionAt: true,
      resolvedAt: true,
      closedAt: true,
      createdBy: { select: { id: true, name: true } },
      createdAt: true,
      updatedAt: true,
    },
  });

  return NextResponse.json({ complaints });
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
  const { title, description, category, severity, ownerUserId, sourceType, sourceId,
    relatedOrderId, relatedProjectId, relatedInteractionId, expectedResolutionAt } = body;

  if (!title?.trim()) return NextResponse.json({ error: "title 为必填" }, { status: 400 });
  if (!category || !COMPLAINT_CATEGORY.includes(category)) {
    return NextResponse.json({ error: `无效的 category` }, { status: 400 });
  }
  if (!severity || !COMPLAINT_SEVERITY.includes(severity)) {
    return NextResponse.json({ error: `无效的 severity` }, { status: 400 });
  }

  // 校验关联资源权限与客户归属
  try {
    await validateComplaintRelatedRefs({
      profileId,
      userId: session.user.id,
      role: session.user.role,
      department: session.user.department,
      relatedOrderId: relatedOrderId || null,
      relatedProjectId: relatedProjectId || null,
      relatedInteractionId: relatedInteractionId || null,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "";
    if (msg === "FORBIDDEN") return NextResponse.json({ error: "无权关联该订单或项目" }, { status: 403 });
    if (msg === "REF_NOT_FOUND") return NextResponse.json({ error: "关联资源不存在" }, { status: 404 });
    if (msg === "REF_CUSTOMER_MISMATCH") return NextResponse.json({ error: "关联订单/项目不属于当前客户" }, { status: 400 });
    if (msg === "INTERACTION_MISMATCH") return NextResponse.json({ error: "沟通记录不属于当前客户档案" }, { status: 400 });
    return NextResponse.json({ error: "关联校验失败" }, { status: 400 });
  }

  try {
    const result = await createComplaint({
      profileId,
      title: title.trim(),
      description: description?.trim() || undefined,
      category,
      severity,
      ownerUserId: ownerUserId || undefined,
      sourceType: sourceType || undefined,
      sourceId: sourceId || undefined,
      relatedOrderId: relatedOrderId || null,
      relatedProjectId: relatedProjectId || null,
      relatedInteractionId: relatedInteractionId || null,
      expectedResolutionAt: expectedResolutionAt || null,
      actorUserId: session.user.id,
    });
    return NextResponse.json(result, { status: 201 });
  } catch {
    return NextResponse.json({ error: "创建客诉失败" }, { status: 500 });
  }
}

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertCrmProfileAccess } from "@/lib/crm/permissions";
import {
  COMPLAINT_CATEGORY,
  COMPLAINT_SEVERITY,
} from "@/lib/crm/constants";
import { syncComplaintHandleTask } from "@/lib/crm/complaints";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ complaintId: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { complaintId } = await params;

  const complaint = await prisma.crmComplaint.findUnique({
    where: { id: complaintId },
    include: {
      events: {
        orderBy: { createdAt: "asc" },
        include: { createdBy: { select: { id: true, name: true } } },
      },
      ownerUser: { select: { id: true, name: true } },
      createdBy: { select: { id: true, name: true } },
    },
  });
  if (!complaint) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    await assertCrmProfileAccess(complaint.profileId, session.user.id, session.user.role);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "";
    if (msg === "NOT_FOUND") return NextResponse.json({ error: "Profile not found" }, { status: 404 });
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  return NextResponse.json({ complaint });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ complaintId: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { complaintId } = await params;

  const existing = await prisma.crmComplaint.findUnique({
    where: { id: complaintId },
    select: { id: true, profileId: true, status: true, ownerUserId: true, severity: true, expectedResolutionAt: true },
  });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    await assertCrmProfileAccess(existing.profileId, session.user.id, session.user.role);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "";
    if (msg === "NOT_FOUND") return NextResponse.json({ error: "Profile not found" }, { status: 404 });
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json();
  const data: Record<string, unknown> = {};

  if (body.title !== undefined) data.title = body.title;
  if (body.description !== undefined) data.description = body.description;
  if (body.category !== undefined) {
    if (!COMPLAINT_CATEGORY.includes(body.category)) {
      return NextResponse.json({ error: `无效的 category` }, { status: 400 });
    }
    data.category = body.category;
  }
  if (body.severity !== undefined) {
    if (!COMPLAINT_SEVERITY.includes(body.severity)) {
      return NextResponse.json({ error: `无效的 severity` }, { status: 400 });
    }
    data.severity = body.severity;
  }
  // 状态不通过通用 PATCH 修改——必须走受控 transition（resolve/close/reopen/events），
  // 否则会绕过 resolvedAt/closedAt/摘要偏好/回访任务等副作用。
  if (body.status !== undefined) {
    return NextResponse.json(
      { error: "客诉状态不可直接修改，请使用 解决/关闭/重新打开 操作" },
      { status: 400 },
    );
  }
  if (body.ownerUserId !== undefined) data.ownerUserId = body.ownerUserId || null;
  if (body.expectedResolutionAt !== undefined) {
    data.expectedResolutionAt = body.expectedResolutionAt ? new Date(body.expectedResolutionAt) : null;
  }
  if (body.resolutionSummary !== undefined) data.resolutionSummary = body.resolutionSummary;
  if (body.customerSatisfied !== undefined) data.customerSatisfied = body.customerSatisfied;

  // 负责人变化时写 ASSIGNED 事件
  const shouldLogAssignment = body.ownerUserId !== undefined && body.ownerUserId !== existing.ownerUserId;
  // 负责人和截止时间独立同步——只有实际变化的字段才写进任务
  const ownerUserIdChanged = body.ownerUserId !== undefined && (body.ownerUserId || null) !== existing.ownerUserId;
  // expectedResolutionAt 或 severity 实际变化才会影响处理任务的 dueAt
  const newExpectedAt = body.expectedResolutionAt !== undefined
    ? (body.expectedResolutionAt ? new Date(body.expectedResolutionAt) : null)
    : existing.expectedResolutionAt;
  const newSeverity = body.severity !== undefined ? body.severity : existing.severity;
  const severityChanged = body.severity !== undefined && body.severity !== existing.severity;
  const dueAtChanged =
    (body.expectedResolutionAt !== undefined && newExpectedAt?.getTime() !== existing.expectedResolutionAt?.getTime()) ||
    severityChanged;
  const shouldSyncTask = ownerUserIdChanged || dueAtChanged;

  // 计算同步给处理任务的最终值
  const finalOwnerUserId = body.ownerUserId !== undefined ? (body.ownerUserId || null) : existing.ownerUserId;

  const updated = await prisma.$transaction(async (tx) => {
    if (shouldLogAssignment) {
      await tx.crmComplaintEvent.create({
        data: {
          complaintId,
          eventType: "ASSIGNED",
          content: body.ownerUserId ? `负责人已更新` : "负责人已移除",
          createdById: session.user.id,
        },
      });
    }
    const result = await tx.crmComplaint.update({
      where: { id: complaintId },
      data,
      include: {
        ownerUser: { select: { id: true, name: true } },
      },
    });
    // 同步当前 OPEN 处理任务——负责人和截止时间独立同步
    if (shouldSyncTask) {
      await syncComplaintHandleTask(
        tx,
        complaintId,
        {
          ownerUserId: finalOwnerUserId,
          actorUserId: session.user.id,
          ownerUserIdChanged,
          dueAt: newExpectedAt,
          severity: newSeverity,
          dueAtChanged,
        },
      );
      // 重算 nextFollowUpAt（dueAt 可能变了）
      const earliestOpen = await tx.crmFollowUpTask.findFirst({
        where: { profileId: existing.profileId, status: "OPEN" },
        orderBy: { dueAt: "asc" },
        select: { dueAt: true },
      });
      await tx.crmCustomerProfile.update({
        where: { id: existing.profileId },
        data: { nextFollowUpAt: earliestOpen?.dueAt ?? null },
      });
    }
    return result;
  });

  return NextResponse.json({ complaint: updated });
}

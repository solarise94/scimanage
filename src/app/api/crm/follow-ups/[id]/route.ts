import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isRepresentativeRole, isRegionalManagerRole, getEffectiveCrmVisibleProfileIds } from "@/lib/crm/permissions";
import { transitionCrmStage } from "@/lib/crm/lifecycle";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;

  const task = await prisma.crmFollowUpTask.findUnique({
    where: { id },
    include: { profile: { select: { ownerUserId: true, assignmentStatus: true } } },
  });
  if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404 });

  if (isRepresentativeRole(session.user.role) || isRegionalManagerRole(session.user.role)) {
    // Allow if task is directly assigned to this user (e.g. pushed from projects)
    if (task.ownerUserId === session.user.id) {
      // pass
    } else {
      const visibleProfileIds = await getEffectiveCrmVisibleProfileIds(session.user.id, session.user.role);
      if (!visibleProfileIds || !visibleProfileIds.has(task.profileId)) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
    }
  }

  const body = await req.json();
  const data: Record<string, unknown> = {};

  if (body.title !== undefined) data.title = body.title;
  if (body.dueAt !== undefined) {
    data.dueAt = new Date(body.dueAt);
    data.reminderSent = false;
    data.reminderStatus = "PENDING";
    data.reminderLockedAt = null;
    data.reminderSentAt = null;
    data.reminderError = null;
  }

  // 校验 completedInteractionId 是否属于当前 profile，防止阶段流转被错误输入污染
  let verifiedInteractionId: string | null = null;
  if (body.status === "DONE" && body.completedInteractionId) {
    const interaction = await prisma.crmInteraction.findUnique({
      where: { id: body.completedInteractionId },
      select: { profileId: true },
    });
    if (interaction && interaction.profileId === task.profileId) {
      verifiedInteractionId = body.completedInteractionId;
    }
  }

  if (body.status === "DONE") {
    data.status = "DONE";
    data.completedAt = new Date();
    data.sourceOpenKey = null;
    if (verifiedInteractionId) data.completedInteractionId = verifiedInteractionId;
  } else if (body.status === "CANCELLED") {
    data.status = "CANCELLED";
    data.sourceOpenKey = null;
  }

  const needsRecalc = body.status === "DONE" || body.status === "CANCELLED" || body.dueAt !== undefined;
  let completedInteractionId: string | null = null;

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.crmFollowUpTask.update({
      where: { id },
      data,
      include: {
        ownerUser: { select: { id: true, name: true } },
        createdByUser: { select: { id: true, name: true } },
        profile: {
          select: {
            id: true,
            name: true,
            customerCode: true,
          },
        },
      },
    });

    if (needsRecalc) {
      const nextOpen = await tx.crmFollowUpTask.findFirst({
        where: { profileId: task.profileId, status: "OPEN" },
        orderBy: { dueAt: "asc" },
      });
      await tx.crmCustomerProfile.update({
        where: { id: task.profileId },
        data: { nextFollowUpAt: nextOpen?.dueAt ?? null },
      });
    }

    if (body.status === "DONE" && verifiedInteractionId) {
      completedInteractionId = verifiedInteractionId;
    }

    return result;
  });

  // 统一阶段流转
  if (body.status === "DONE") {
    try {
      await transitionCrmStage(task.profileId, {
        type: "FOLLOW_UP_COMPLETED",
        taskId: id,
        completedInteractionId,
      });
    } catch (error) {
      console.error(`[CRM][FOLLOW_UP] stage transition failed for profile ${task.profileId}:`, error);
    }
  } else if (body.status === "CANCELLED") {
    try {
      await transitionCrmStage(task.profileId, {
        type: "FOLLOW_UP_CANCELLED",
        taskId: id,
      });
    } catch (error) {
      console.error(`[CRM][FOLLOW_UP] stage transition failed for profile ${task.profileId}:`, error);
    }
  }

  return NextResponse.json({ task: updated });
}

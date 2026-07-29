import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { canManageProject } from "@/lib/permissions";
import { MANUAL_NUDGE_RATELIMIT_MS } from "@/lib/business-email/constants";

const VALID_TYPES = new Set([
  "CUSTOM", "SAMPLE", "SEQUENCING", "REPORT", "DELIVERY", "PAYMENT", "CONTRACT",
]);

function serializeMilestone(m: {
  id: string;
  name: string;
  type: string;
  sortOrder: number;
  dueDate: Date | null;
  doneAt: Date | null;
  completedNotified: boolean;
  note: string | null;
  notifyBeforeHours: number | null;
  nudgeStatus: string | null;
  nudgeLastSentAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  contacts?: Array<{
    id: string;
    externalContactId: string;
    suppressUntil: Date | null;
    externalContact: { id: string; name: string; email: string; department: string | null; enabled: boolean; archived: boolean };
  }>;
}) {
  return {
    id: m.id,
    name: m.name,
    type: m.type,
    sortOrder: m.sortOrder,
    dueDate: m.dueDate,
    doneAt: m.doneAt,
    completedNotified: m.completedNotified,
    note: m.note,
    notifyBeforeHours: m.notifyBeforeHours,
    nudgeStatus: m.nudgeStatus,
    nudgeLastSentAt: m.nudgeLastSentAt,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    contacts: (m.contacts ?? []).map((c) => ({
      id: c.id,
      externalContactId: c.externalContactId,
      suppressUntil: c.suppressUntil,
      name: c.externalContact.name,
      email: c.externalContact.email,
      department: c.externalContact.department,
      enabled: c.externalContact.enabled,
      archived: c.externalContact.archived,
    })),
  };
}

const contactInclude = {
  contacts: {
    include: {
      externalContact: {
        select: { id: true, name: true, email: true, department: true, enabled: true, archived: true },
      },
    },
  },
} as const;

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; mid: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id: projectId, mid } = await params;
  const canManage = await canManageProject(projectId, session.user.id, session.user.role);
  if (!canManage) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const existing = await prisma.milestone.findUnique({ where: { id: mid } });
  if (!existing || existing.projectId !== projectId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = await req.json();
  const { name, type, sortOrder, dueDate, note, notifyBeforeHours, done } = body as Record<string, unknown>;

  const data: Record<string, unknown> = {};

  if (name !== undefined) {
    if (!(name as string)?.trim()) return NextResponse.json({ error: "节点名称不能为空" }, { status: 400 });
    data.name = (name as string).trim();
  }
  if (type !== undefined) {
    const typeVal = (type as string)?.trim() || "CUSTOM";
    if (!VALID_TYPES.has(typeVal)) return NextResponse.json({ error: `无效的节点类型: ${typeVal}` }, { status: 400 });
    data.type = typeVal;
  }
  if (sortOrder !== undefined) {
    data.sortOrder = Number.isFinite(Number(sortOrder)) ? Math.floor(Number(sortOrder)) : 0;
  }
  if (dueDate !== undefined) {
    if (dueDate === null || dueDate === "") {
      data.dueDate = null;
    } else {
      const d = new Date(dueDate as string);
      if (isNaN(d.getTime())) return NextResponse.json({ error: "到期日格式无效" }, { status: 400 });
      data.dueDate = d;
    }
  }
  if (note !== undefined) data.note = (note as string)?.trim() || null;
  if (notifyBeforeHours !== undefined) {
    if (notifyBeforeHours === null || notifyBeforeHours === "") {
      data.notifyBeforeHours = null;
    } else {
      const n = Number(notifyBeforeHours);
      if (!Number.isFinite(n) || n < 0) return NextResponse.json({ error: "提前提醒小时数无效" }, { status: 400 });
      data.notifyBeforeHours = Math.floor(n);
    }
  }

  // 完成态切换：done=true 写 doneAt（若尚未完成）；done=false 取消完成
  let justCompleted = false;
  if (done !== undefined) {
    if (done === true && !existing.doneAt) {
      data.doneAt = new Date();
      // 完成后视为终态，停止自动催办扫描
      data.nudgeStatus = "DONE";
      justCompleted = true;
    } else if (done === false && existing.doneAt) {
      data.doneAt = null;
      data.completedNotified = false;
      // 重新打开扫描
      data.nudgeStatus = "PENDING";
    }
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "无更新内容" }, { status: 400 });
  }

  const updated = await prisma.milestone.update({
    where: { id: mid },
    data,
    include: contactInclude,
  });

  // §4.6 邮件 D：仅在「原 dueDate 已逾期」时，完成才发"已完成"通知（fail-closed）。
  //   同样走 1h 软限速（复用 nudgeLastSentAt），避免反复切换完成态导致重复发送。
  if (justCompleted && existing.dueDate && existing.dueDate.getTime() < Date.now()) {
    const lastSent = existing.nudgeLastSentAt?.getTime() ?? 0;
    const withinRateLimit = lastSent > 0 && Date.now() - lastSent < MANUAL_NUDGE_RATELIMIT_MS;
    if (!withinRateLimit) {
      try {
        const { sendMilestoneCompleted } = await import("@/lib/business-email/notify");
        const project = await prisma.project.findUnique({
          where: { id: projectId },
          select: { id: true, name: true },
        });
        if (project) {
          const res = await sendMilestoneCompleted({
            milestoneId: updated.id,
            projectId: project.id,
            projectName: project.name,
            milestoneName: updated.name,
            dueDate: existing.dueDate,
            doneAt: updated.doneAt!,
          });
          // 仅在确有收件人时推进 nudgeLastSentAt，避免空发也占用限速窗口。
          // 同时持久化 completedNotified——邮件 D 真正发出（而非因无收件人跳过）才置 true，
          // 作为前端"已发完成通知"徽标的权威标志，避免事后编辑 dueDate 导致前后端判定发散。
          if (res.recipients > 0) {
            await prisma.milestone
              .update({ where: { id: mid }, data: { nudgeLastSentAt: new Date(), completedNotified: true } })
              .catch(() => {});
          }
        }
      } catch (err) {
        console.error(`[BIZ_EMAIL][MILESTONE_COMPLETED] failed for ${mid}:`, err instanceof Error ? err.message : err);
      }
    }
  }

  if (justCompleted) {
    await prisma.activityLog.create({
      data: {
        type: "MILESTONE_COMPLETED",
        content: `完成了项目节点「${updated.name}」`,
        projectId,
        userId: session.user.id,
      },
    }).catch(() => {});
  }

  return NextResponse.json({ milestone: serializeMilestone(updated) });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; mid: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id: projectId, mid } = await params;
  const canManage = await canManageProject(projectId, session.user.id, session.user.role);
  if (!canManage) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const existing = await prisma.milestone.findUnique({ where: { id: mid }, select: { id: true, projectId: true, name: true } });
  if (!existing || existing.projectId !== projectId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // MilestoneContact 经 onDelete: Cascade 自动清理
  await prisma.milestone.delete({ where: { id: mid } });

  await prisma.activityLog.create({
    data: {
      type: "MILESTONE_DELETED",
      content: `删除了项目节点「${existing.name}」`,
      projectId,
      userId: session.user.id,
    },
  }).catch(() => {});

  return NextResponse.json({ ok: true });
}

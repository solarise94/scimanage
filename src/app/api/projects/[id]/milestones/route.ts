import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { canReadProject, canManageProject } from "@/lib/permissions";

const VALID_TYPES = new Set([
  "CUSTOM", "SAMPLE", "SEQUENCING", "REPORT", "DELIVERY", "PAYMENT", "CONTRACT",
]);

// 节点收件人形态（供前端展示） — 含外部联系人与静默状态
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

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id: projectId } = await params;
  const canRead = await canReadProject(projectId, session.user.id, session.user.role);
  if (!canRead) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const milestones = await prisma.milestone.findMany({
    where: { projectId },
    orderBy: [{ sortOrder: "asc" }, { dueDate: "asc" }, { createdAt: "asc" }],
    include: {
      contacts: {
        include: {
          externalContact: {
            select: { id: true, name: true, email: true, department: true, enabled: true, archived: true },
          },
        },
      },
    },
  });

  return NextResponse.json({ milestones: milestones.map(serializeMilestone) });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id: projectId } = await params;
  const canManage = await canManageProject(projectId, session.user.id, session.user.role);
  if (!canManage) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true } });
  if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = await req.json();
  const { name, type, sortOrder, dueDate, note, notifyBeforeHours } = body as Record<string, unknown>;

  if (!(name as string)?.trim()) {
    return NextResponse.json({ error: "节点名称不能为空" }, { status: 400 });
  }
  const typeVal = (type as string)?.trim() || "CUSTOM";
  if (!VALID_TYPES.has(typeVal)) {
    return NextResponse.json({ error: `无效的节点类型: ${typeVal}` }, { status: 400 });
  }

  let dueDateVal: Date | null = null;
  if (dueDate !== undefined && dueDate !== null && dueDate !== "") {
    const d = new Date(dueDate as string);
    if (isNaN(d.getTime())) return NextResponse.json({ error: "到期日格式无效" }, { status: 400 });
    dueDateVal = d;
  }

  let notifyHoursVal: number | null = null;
  if (notifyBeforeHours !== undefined && notifyBeforeHours !== null && notifyBeforeHours !== "") {
    const n = Number(notifyBeforeHours);
    if (!Number.isFinite(n) || n < 0) {
      return NextResponse.json({ error: "提前提醒小时数无效" }, { status: 400 });
    }
    notifyHoursVal = Math.floor(n);
  }

  const milestone = await prisma.milestone.create({
    data: {
      projectId,
      name: (name as string).trim(),
      type: typeVal,
      sortOrder: Number.isFinite(Number(sortOrder)) ? Math.floor(Number(sortOrder)) : 0,
      dueDate: dueDateVal,
      note: (note as string)?.trim() || null,
      notifyBeforeHours: notifyHoursVal,
    },
    include: {
      contacts: {
        include: {
          externalContact: {
            select: { id: true, name: true, email: true, department: true, enabled: true, archived: true },
          },
        },
      },
    },
  });

  await prisma.activityLog.create({
    data: {
      type: "MILESTONE_CREATED",
      content: `创建了项目节点「${milestone.name}」`,
      projectId,
      userId: session.user.id,
    },
  }).catch(() => {});

  return NextResponse.json({ milestone: serializeMilestone(milestone) }, { status: 201 });
}

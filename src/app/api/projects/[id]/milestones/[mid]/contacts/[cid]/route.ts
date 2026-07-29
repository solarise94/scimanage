import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { canManageProject } from "@/lib/permissions";

// 节点收件人解绑 / 设置静默（§7：DELETE / PATCH，canManageProject）
// 路径中的 cid 为 MilestoneContact（绑定行）的 id。

async function loadLink(projectId: string, mid: string, cid: string) {
  const link = await prisma.milestoneContact.findUnique({
    where: { id: cid },
    include: { milestone: { select: { id: true, projectId: true } } },
  });
  if (!link || link.milestoneId !== mid || link.milestone.projectId !== projectId) {
    return null;
  }
  return link;
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; mid: string; cid: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id: projectId, mid, cid } = await params;
  const canManage = await canManageProject(projectId, session.user.id, session.user.role);
  if (!canManage) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const link = await loadLink(projectId, mid, cid);
  if (!link) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = await req.json();
  const { suppressUntil } = body as Record<string, unknown>;

  let suppressVal: Date | null = null;
  if (suppressUntil !== undefined && suppressUntil !== null && suppressUntil !== "") {
    const d = new Date(suppressUntil as string);
    if (isNaN(d.getTime())) return NextResponse.json({ error: "静默截止时间格式无效" }, { status: 400 });
    suppressVal = d;
  }

  const updated = await prisma.milestoneContact.update({
    where: { id: cid },
    data: { suppressUntil: suppressVal },
    include: {
      externalContact: {
        select: { id: true, name: true, email: true, department: true, enabled: true, archived: true },
      },
    },
  });

  return NextResponse.json({
    contact: {
      id: updated.id,
      externalContactId: updated.externalContactId,
      suppressUntil: updated.suppressUntil,
      name: updated.externalContact.name,
      email: updated.externalContact.email,
      department: updated.externalContact.department,
      enabled: updated.externalContact.enabled,
      archived: updated.externalContact.archived,
    },
  });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; mid: string; cid: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id: projectId, mid, cid } = await params;
  const canManage = await canManageProject(projectId, session.user.id, session.user.role);
  if (!canManage) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const link = await loadLink(projectId, mid, cid);
  if (!link) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await prisma.milestoneContact.delete({ where: { id: cid } });
  return NextResponse.json({ ok: true });
}

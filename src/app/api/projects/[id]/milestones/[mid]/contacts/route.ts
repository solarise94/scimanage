import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { canManageProject } from "@/lib/permissions";

// 节点绑定外部收件人（§7：POST /milestones/[mid]/contacts，canManageProject）

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; mid: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id: projectId, mid } = await params;
  const canManage = await canManageProject(projectId, session.user.id, session.user.role);
  if (!canManage) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const milestone = await prisma.milestone.findUnique({
    where: { id: mid },
    select: { id: true, projectId: true },
  });
  if (!milestone || milestone.projectId !== projectId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = await req.json();
  const { externalContactId } = body as Record<string, unknown>;
  if (!(externalContactId as string)?.trim()) {
    return NextResponse.json({ error: "缺少外部联系人 ID" }, { status: 400 });
  }

  const contact = await prisma.externalContact.findUnique({
    where: { id: externalContactId as string },
    select: { id: true, archived: true },
  });
  if (!contact || contact.archived) {
    return NextResponse.json({ error: "外部联系人不存在或已归档" }, { status: 400 });
  }

  try {
    const link = await prisma.milestoneContact.create({
      data: { milestoneId: mid, externalContactId: externalContactId as string },
      include: {
        externalContact: {
          select: { id: true, name: true, email: true, department: true, enabled: true, archived: true },
        },
      },
    });
    return NextResponse.json({
      contact: {
        id: link.id,
        externalContactId: link.externalContactId,
        suppressUntil: link.suppressUntil,
        name: link.externalContact.name,
        email: link.externalContact.email,
        department: link.externalContact.department,
        enabled: link.externalContact.enabled,
        archived: link.externalContact.archived,
      },
    }, { status: 201 });
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "P2002") {
      return NextResponse.json({ error: "该联系人已绑定到此节点" }, { status: 409 });
    }
    throw err;
  }
}

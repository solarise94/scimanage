import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { canContributeProject } from "@/lib/permissions";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;

  const canContribute = await canContributeProject(id, session.user.id, session.user.role);
  if (!canContribute) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const project = await prisma.project.findUnique({ where: { id } });
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
  if (project.deleted) return NextResponse.json({ error: "项目已删除，无法发表评论" }, { status: 400 });

  try {
    const { content } = await req.json();
    if (!content?.trim()) {
      return NextResponse.json({ error: "Content is required" }, { status: 400 });
    }

    const comment = await prisma.comment.create({
      data: {
        content: content.trim(),
        projectId: id,
        authorId: session.user.id,
      },
      include: {
        author: {
          select: { id: true, name: true, avatar: true },
        },
      },
    });

    await prisma.activityLog.create({
      data: {
        type: "COMMENT_ADDED",
        content: `发表了评论`,
        projectId: id,
        userId: session.user.id,
      },
    });

    // Notify project owner
    const owner = await prisma.projectMember.findFirst({
      where: { projectId: id, role: "OWNER" },
      include: { user: { select: { id: true, email: true, name: true, emailOnComment: true } } },
    });
    if (owner && owner.user.id !== session.user.id) {
      const shouldEmail = !!(owner.user.email && owner.user.emailOnComment);
      const notification = await prisma.notification.create({
        data: {
          userId: owner.user.id,
          title: `项目评论: ${project.name}`,
          content: `有人在项目 "${project.name}" 发表了评论`,
          type: "COMMENT",
          link: `/projects/${id}`,
          emailStatus: shouldEmail ? "pending" : null,
        },
      });
      if (shouldEmail) {
        const { sendMailInBackground } = await import("@/lib/mail");
        sendMailInBackground({
          to: owner.user.email!,
          subject: `【SciManage】项目评论: ${project.name}`,
          text: `您好 ${owner.user.name || ""}，\n\n有人在项目 "${project.name}" 发表了评论。\n\n---\nSciManage`,
          html: `<p>您好 <strong>${owner.user.name || ""}</strong>，</p>
<p>有人在项目 <strong>"${project.name}"</strong> 发表了评论。</p>
<hr />
<p style="color:#999;font-size:12px;">SciManage</p>`,
        }, notification.id);
      }
    }

    return NextResponse.json({ comment }, { status: 201 });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: "Failed to add comment" }, { status: 500 });
  }
}

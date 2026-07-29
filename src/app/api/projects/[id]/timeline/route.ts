import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { canReadProject } from "@/lib/permissions";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;

  const canRead = await canReadProject(id, session.user.id, session.user.role);
  if (!canRead) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const [activities, comments, attachments, statusHistory] = await Promise.all([
    prisma.activityLog.findMany({
      where: { projectId: id },
      include: { user: { select: { id: true, name: true, avatar: true } } },
      orderBy: { createdAt: "desc" },
    }),
    prisma.comment.findMany({
      where: { projectId: id },
      include: { author: { select: { id: true, name: true, avatar: true } } },
      orderBy: { createdAt: "desc" },
    }),
    prisma.attachment.findMany({
      // 时间线只见 READY 且未归档附件；PENDING_FILE/FAILED/archived 不泄露（docs §5.1）。
      where: { projectId: id, status: "READY", archived: false },
      orderBy: { createdAt: "desc" },
    }),
    prisma.statusHistory.findMany({
      where: { projectId: id },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  // Merge all timeline items
  const timeline = [
    ...activities.map((a) => ({
      id: a.id,
      type: a.type,
      content: a.content,
      metadata: a.metadata,
      createdAt: a.createdAt,
      user: a.user,
      kind: (a.type === "PLUGIN_MESSAGE" ? "plugin" : "activity") as "plugin" | "activity",
    })),
    ...comments.map((c) => ({
      id: c.id,
      type: "COMMENT_ADDED",
      content: c.content,
      metadata: null,
      createdAt: c.createdAt,
      user: c.author,
      kind: "comment" as const,
    })),
    ...attachments.map((a) => ({
      id: a.id,
      type: "FILE_UPLOADED",
      content: `上传了文件 "${a.filename}"`,
      metadata: JSON.stringify({ attachmentId: a.id, filename: a.filename, url: a.url, size: a.size, mimeType: a.mimeType }),
      createdAt: a.createdAt,
      user: null,
      kind: "attachment" as const,
    })),
    ...statusHistory.map((s) => ({
      id: s.id,
      type: "STATUS_CHANGED",
      content: `项目状态从 "${s.oldStatus || "无"}" 变更为 "${s.newStatus}"`,
      metadata: JSON.stringify({ oldStatus: s.oldStatus, newStatus: s.newStatus }),
      createdAt: s.createdAt,
      user: null,
      kind: "status" as const,
    })),
  ];

  timeline.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  return NextResponse.json({ timeline });
}

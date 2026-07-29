import { prisma } from "@/lib/prisma";
import type { ProjectPluginContext } from "./types";

export async function buildProjectPluginContext(projectId: string): Promise<ProjectPluginContext> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: {
      profile: {
        select: {
          id: true,
          name: true,
          customerCode: true,
          organization: true,
          email: true,
          wechat: true,
        },
      },
      rep: {
        select: { id: true, name: true, email: true },
      },
    },
  });

  if (!project) throw new Error("项目不存在");

  const tickets = await prisma.ticket.findMany({
    where: { projectId },
    select: { id: true, title: true, status: true, priority: true, updatedAt: true },
    orderBy: { updatedAt: "desc" },
    take: 20,
  });

  const [activities, comments] = await Promise.all([
    prisma.activityLog.findMany({
      where: { projectId },
      include: { user: { select: { id: true, name: true } } },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
    prisma.comment.findMany({
      where: { projectId },
      include: { author: { select: { id: true, name: true } } },
      orderBy: { createdAt: "desc" },
      take: 10,
    }),
  ]);

  const timeline = [
    ...activities.map((a) => ({
      id: a.id,
      type: a.type,
      kind: "activity" as const,
      content: a.content,
      createdAt: a.createdAt.toISOString(),
      user: a.user,
      metadata: a.metadata ? JSON.parse(a.metadata) : null,
    })),
    ...comments.map((c) => ({
      id: c.id,
      type: "COMMENT_ADDED",
      kind: "comment" as const,
      content: c.content,
      createdAt: c.createdAt.toISOString(),
      user: c.author,
      metadata: null,
    })),
  ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 20);

  return {
    project: {
      id: project.id,
      name: project.name,
      description: project.description,
      status: project.status,
      progress: project.progress,
      organization: project.organization,
      client: project.client,
      representative: project.representative,
    },
    customer: project.profile
      ? {
          id: project.profile.id,
          name: project.profile.name ?? "未命名客户",
          customerCode: project.profile.customerCode ?? "",
          organization: project.profile.organization ?? null,
          email: project.profile.email ?? null,
          wechat: project.profile.wechat ?? null,
        }
      : null,
    representativeDetail: project.rep,
    tickets: tickets.map((t) => ({
      ...t,
      updatedAt: t.updatedAt.toISOString(),
    })),
    timeline,
  };
}

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertProjectMember, isRepresentative } from "@/lib/permissions";
import { getPlugin } from "@/lib/plugins/registry";
import { buildProjectPluginContext } from "@/lib/plugins/context";
import { publishPluginMessage } from "@/lib/plugins/publish";
import type { TimelinePlugin } from "@/lib/plugins/types";

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (isRepresentative(session.user.role)) {
    return NextResponse.json({ error: "代表账号不允许触发时间流插件" }, { status: 403 });
  }

  try {
    const body = await req.json();
    const { pluginKey, projectId, input, dryRun } = body;

    if (!pluginKey || !projectId) {
      return NextResponse.json({ error: "pluginKey 和 projectId 为必填" }, { status: 400 });
    }

    const plugin = await getPlugin(pluginKey);
    if (!plugin || plugin.manifest.capability !== "timeline") {
      return NextResponse.json({ error: "插件不存在或类型不匹配" }, { status: 404 });
    }

    // Check project exists and is not deleted
    const project = await prisma.project.findUnique({ where: { id: projectId }, select: { deleted: true } });
    if (!project) return NextResponse.json({ error: "项目不存在" }, { status: 404 });
    if (project.deleted) return NextResponse.json({ error: "已删除项目不允许插件写入" }, { status: 400 });

    // Check membership (ADMIN can run on any active project)
    if (session.user.role !== "ADMIN") {
      try {
        await assertProjectMember(projectId, session.user.id);
      } catch {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
    }

    // Check role restriction
    if (plugin.manifest.allowedRoles && !plugin.manifest.allowedRoles.includes(session.user.role)) {
      return NextResponse.json({ error: "当前角色无权使用此插件" }, { status: 403 });
    }

    const ctx = await buildProjectPluginContext(projectId);
    const actor = { id: session.user.id, name: session.user.name || "", email: session.user.email || "", role: session.user.role };
    const result = await (plugin as TimelinePlugin).execute(ctx, actor, input);

    if (dryRun || !result.message) {
      return NextResponse.json({ result, published: false });
    }

    await publishPluginMessage(projectId, pluginKey, plugin.manifest.name, result.message);
    return NextResponse.json({ result, published: true });
  } catch (error) {
    console.error(error);
    const message = error instanceof Error ? error.message : "插件执行失败";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

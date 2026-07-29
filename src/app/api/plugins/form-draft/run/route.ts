import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { isRepresentative, getRepresentativeProjectIds, assertProjectContextReadable } from "@/lib/permissions";
import { getPlugin } from "@/lib/plugins/registry";
import { buildProjectPluginContext } from "@/lib/plugins/context";
import type { FormDraftPlugin } from "@/lib/plugins/types";

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const body = await req.json();
    const { pluginKey, formKey, input, projectId } = body;

    if (!pluginKey || !formKey || input === undefined || input === null) {
      return NextResponse.json({ error: "pluginKey、formKey 和 input 为必填" }, { status: 400 });
    }

    const plugin = await getPlugin(pluginKey);
    if (!plugin || plugin.manifest.capability !== "form-draft") {
      return NextResponse.json({ error: "插件不存在或类型不匹配" }, { status: 404 });
    }

    // Validate formKey
    if (plugin.manifest.formKeys && !plugin.manifest.formKeys.includes(formKey)) {
      return NextResponse.json({ error: `此插件不支持 formKey: ${formKey}` }, { status: 400 });
    }

    // Check role restriction
    if (plugin.manifest.allowedRoles && !plugin.manifest.allowedRoles.includes(session.user.role)) {
      return NextResponse.json({ error: "当前角色无权使用此插件" }, { status: 403 });
    }

    // If projectId provided, verify access; representatives get access check but no full context
    let projectCtx = undefined;
    if (projectId) {
      const isRep = isRepresentative(session.user.role);
      if (isRep) {
        const repProjectIds = await getRepresentativeProjectIds(session.user.id);
        if (!repProjectIds.includes(projectId)) {
          return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }
        // Representatives don't get project context — it contains comments/tickets they shouldn't see
      } else {
        try {
          await assertProjectContextReadable(projectId, session.user.id, session.user.role);
        } catch (e) {
          const msg = e instanceof Error ? e.message : "";
          if (msg === "NOT_FOUND") return NextResponse.json({ error: "项目不存在" }, { status: 404 });
          return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }
        projectCtx = await buildProjectPluginContext(projectId);
      }
    }

    const actor = { id: session.user.id, name: session.user.name || "", email: session.user.email || "", role: session.user.role };
    const result = await (plugin as FormDraftPlugin).execute(input, actor, formKey, projectCtx);

    return NextResponse.json({ result });
  } catch (error) {
    console.error(error);
    const message = error instanceof Error ? error.message : "插件执行失败";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

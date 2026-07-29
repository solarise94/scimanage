import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requireBusinessActorFromSession } from "@/lib/agent-actions/actor";
import { AgentActionError, AgentActionInputError } from "@/lib/agent-actions/errors";
import { updateAgentProactiveTask } from "@/lib/agent-runtime/proactive-tasks";
import { requireAgentAccess } from "@/lib/agent-actions/require-agent-access";

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const denied = requireAgentAccess(session);
  if (denied) return denied;

  try {
    const body = await req.json();
    if (!body || typeof body !== "object") {
      throw new AgentActionInputError("Request body must be an object");
    }

    const actor = requireBusinessActorFromSession(session);
    const { id } = await context.params;
    const item = await updateAgentProactiveTask(actor, id, {
      kind: typeof body.kind === "string" ? body.kind : undefined,
      title: typeof body.title === "string" ? body.title : undefined,
      payload: body.payload && typeof body.payload === "object" && !Array.isArray(body.payload)
        ? body.payload as Record<string, unknown>
        : body.payload === null
          ? {}
          : undefined,
      triggerAt: typeof body.triggerAt === "string" ? body.triggerAt : undefined,
      status: typeof body.status === "string" ? body.status : undefined,
      error: typeof body.error === "string" ? body.error : body.error === null ? null : undefined,
    });
    return NextResponse.json({ ok: true, item });
  } catch (error) {
    if (error instanceof AgentActionError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    console.error("agent proactive task update failed:", error);
    return NextResponse.json({ error: "Failed to update proactive task" }, { status: 500 });
  }
}

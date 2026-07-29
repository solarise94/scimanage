import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requireBusinessActorFromSession } from "@/lib/agent-actions/actor";
import type { BusinessActor } from "@/lib/application/actor";
import { AgentActionError, AgentActionInputError } from "@/lib/agent-actions/errors";
import { getExecutionContextFromAgentRun, isValidInternalToolToken } from "@/lib/agent-actions/run-context";
import { createAgentProactiveTask, listAgentProactiveTasks } from "@/lib/agent-runtime/proactive-tasks";
import { requireAgentAccess } from "@/lib/agent-actions/require-agent-access";

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const denied = requireAgentAccess(session);
  if (denied) return denied;

  try {
    const actor = requireBusinessActorFromSession(session);
    const status = req.nextUrl.searchParams.get("status")?.trim() || undefined;
    const kind = req.nextUrl.searchParams.get("kind")?.trim() || undefined;
    const limit = req.nextUrl.searchParams.get("limit");
    const items = await listAgentProactiveTasks(actor, {
      status,
      kind,
      limit: limit ? Number(limit) : undefined,
    });
    return NextResponse.json({ items });
  } catch (error) {
    if (error instanceof AgentActionError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    console.error("agent proactive tasks list failed:", error);
    return NextResponse.json({ error: "Failed to load proactive tasks" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    if (!body || typeof body !== "object") {
      throw new AgentActionInputError("Request body must be an object");
    }

    if (typeof body.kind !== "string" || !body.kind.trim()) {
      throw new AgentActionInputError("kind is required");
    }
    if (typeof body.title !== "string" || !body.title.trim()) {
      throw new AgentActionInputError("title is required");
    }
    if (!body.payload || typeof body.payload !== "object" || Array.isArray(body.payload)) {
      throw new AgentActionInputError("payload must be an object");
    }
    if (typeof body.triggerAt !== "string" || !body.triggerAt.trim()) {
      throw new AgentActionInputError("triggerAt is required");
    }

    const internalToken = req.headers.get("x-agent-internal-token");
    let actor: BusinessActor;
    if (internalToken && isValidInternalToolToken(internalToken)) {
      const agentRunId = typeof body.agentRunId === "string" ? body.agentRunId.trim() : "";
      if (!agentRunId) {
        throw new AgentActionInputError("agentRunId is required for internal proactive task writes");
      }
      actor = (await getExecutionContextFromAgentRun(agentRunId)).actor;
    } else {
      const session = await getServerSession(authOptions);
      if (!session) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
      const denied = requireAgentAccess(session);
      if (denied) return denied;
      actor = requireBusinessActorFromSession(session);
    }

    const item = await createAgentProactiveTask(actor, {
      agentRunId: typeof body.agentRunId === "string" ? body.agentRunId : null,
      sessionId: typeof body.sessionId === "string" ? body.sessionId : null,
      kind: body.kind,
      title: body.title,
      payload: body.payload as Record<string, unknown>,
      triggerAt: body.triggerAt,
      status: typeof body.status === "string" ? body.status : undefined,
    });

    return NextResponse.json({ ok: true, item }, { status: 201 });
  } catch (error) {
    if (error instanceof AgentActionError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    console.error("agent proactive task create failed:", error);
    return NextResponse.json({ error: "Failed to create proactive task" }, { status: 500 });
  }
}

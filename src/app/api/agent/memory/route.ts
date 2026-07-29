import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requireBusinessActorFromSession } from "@/lib/agent-actions/actor";
import type { BusinessActor } from "@/lib/application/actor";
import { AgentActionError, AgentActionInputError } from "@/lib/agent-actions/errors";
import { getExecutionContextFromAgentRun, isValidInternalToolToken } from "@/lib/agent-actions/run-context";
import { createAgentMemory, listAgentMemory } from "@/lib/agent-runtime/memory";
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
    const kind = req.nextUrl.searchParams.get("kind")?.trim() || undefined;
    const status = req.nextUrl.searchParams.get("status")?.trim() || undefined;
    const limit = req.nextUrl.searchParams.get("limit");
    const items = await listAgentMemory(actor, {
      kind,
      status,
      limit: limit ? Number(limit) : undefined,
    });
    return NextResponse.json({ items });
  } catch (error) {
    if (error instanceof AgentActionError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    console.error("agent memory list failed:", error);
    return NextResponse.json({ error: "Failed to load memory" }, { status: 500 });
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
    if (typeof body.content !== "string" || !body.content.trim()) {
      throw new AgentActionInputError("content is required");
    }

    const internalToken = req.headers.get("x-agent-internal-token");
    let actor: BusinessActor;
    if (internalToken && isValidInternalToolToken(internalToken)) {
      const agentRunId = typeof body.agentRunId === "string" ? body.agentRunId.trim() : "";
      if (!agentRunId) {
        throw new AgentActionInputError("agentRunId is required for internal memory writes");
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

    const item = await createAgentMemory(actor, {
      scope: typeof body.scope === "string" ? body.scope : undefined,
      kind: body.kind,
      content: body.content,
      confidence: typeof body.confidence === "number" ? body.confidence : undefined,
      source: typeof body.source === "string" ? body.source : undefined,
      sourceMessageId: typeof body.sourceMessageId === "string" ? body.sourceMessageId : null,
      status: typeof body.status === "string" ? body.status : undefined,
      metadata: body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
        ? body.metadata as Record<string, unknown>
        : null,
      expiresAt: typeof body.expiresAt === "string" ? body.expiresAt : null,
      lastUsedAt: typeof body.lastUsedAt === "string" ? body.lastUsedAt : null,
    });

    return NextResponse.json({ ok: true, item }, { status: 201 });
  } catch (error) {
    if (error instanceof AgentActionError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    console.error("agent memory create failed:", error);
    return NextResponse.json({ error: "Failed to create memory" }, { status: 500 });
  }
}

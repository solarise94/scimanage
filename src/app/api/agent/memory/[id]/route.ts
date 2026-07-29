import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requireBusinessActorFromSession } from "@/lib/agent-actions/actor";
import { AgentActionError, AgentActionInputError } from "@/lib/agent-actions/errors";
import { updateAgentMemory } from "@/lib/agent-runtime/memory";
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
    const item = await updateAgentMemory(actor, id, {
      scope: typeof body.scope === "string" ? body.scope : undefined,
      kind: typeof body.kind === "string" ? body.kind : undefined,
      content: typeof body.content === "string" ? body.content : undefined,
      confidence: typeof body.confidence === "number" ? body.confidence : undefined,
      source: typeof body.source === "string" ? body.source : undefined,
      sourceMessageId: typeof body.sourceMessageId === "string"
        ? body.sourceMessageId
        : body.sourceMessageId === null
          ? null
          : undefined,
      status: typeof body.status === "string" ? body.status : undefined,
      metadata: body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
        ? body.metadata as Record<string, unknown>
        : body.metadata === null
          ? null
          : undefined,
      expiresAt: typeof body.expiresAt === "string" ? body.expiresAt : body.expiresAt === null ? null : undefined,
      lastUsedAt: typeof body.lastUsedAt === "string" ? body.lastUsedAt : body.lastUsedAt === null ? null : undefined,
    });
    return NextResponse.json({ ok: true, item });
  } catch (error) {
    if (error instanceof AgentActionError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    console.error("agent memory update failed:", error);
    return NextResponse.json({ error: "Failed to update memory" }, { status: 500 });
  }
}

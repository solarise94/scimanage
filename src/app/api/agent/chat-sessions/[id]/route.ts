import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requireBusinessActorFromSession } from "@/lib/agent-actions/actor";
import { AgentActionError, AgentActionInputError } from "@/lib/agent-actions/errors";
import { getAgentChatSessionDetail, updateAgentChatSession, deleteAgentChatSession } from "@/lib/agent-runtime/chat-sessions";
import { requireAgentAccess } from "@/lib/agent-actions/require-agent-access";

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const denied = requireAgentAccess(session);
  if (denied) return denied;

  try {
    const actor = requireBusinessActorFromSession(session);
    const { id } = await context.params;
    const chatSession = await getAgentChatSessionDetail(actor, id);
    return NextResponse.json({ session: chatSession });
  } catch (error) {
    if (error instanceof AgentActionError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    console.error("agent chat session get failed:", error);
    return NextResponse.json({ error: "Failed to load chat session" }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const denied = requireAgentAccess(session);
  if (denied) return denied;

  try {
    const actor = requireBusinessActorFromSession(session);
    const { id } = await context.params;
    await deleteAgentChatSession(actor, id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof AgentActionError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    console.error("agent chat session delete failed:", error);
    return NextResponse.json({ error: "Failed to delete chat session" }, { status: 500 });
  }
}

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
    const chatSession = await updateAgentChatSession(actor, id, {
      title: typeof body.title === "string" ? body.title : undefined,
      status: typeof body.status === "string" ? body.status : undefined,
      source: typeof body.source === "string" ? body.source : undefined,
      summary: typeof body.summary === "string" ? body.summary : body.summary === null ? null : undefined,
      compactSummary: typeof body.compactSummary === "string"
        ? body.compactSummary
        : body.compactSummary === null
          ? null
          : undefined,
      metadata: body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
        ? body.metadata as Record<string, unknown>
        : body.metadata === null
          ? null
          : undefined,
    });
    return NextResponse.json({ ok: true, session: chatSession });
  } catch (error) {
    if (error instanceof AgentActionError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    console.error("agent chat session update failed:", error);
    return NextResponse.json({ error: "Failed to update chat session" }, { status: 500 });
  }
}

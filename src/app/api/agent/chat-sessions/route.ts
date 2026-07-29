import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requireBusinessActorFromSession } from "@/lib/agent-actions/actor";
import { AgentActionError, AgentActionInputError } from "@/lib/agent-actions/errors";
import { createAgentChatSession, listAgentChatSessions } from "@/lib/agent-runtime/chat-sessions";
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
    const limit = req.nextUrl.searchParams.get("limit");
    const sessions = await listAgentChatSessions(actor, {
      status,
      limit: limit ? Number(limit) : undefined,
    });
    return NextResponse.json({ sessions });
  } catch (error) {
    if (error instanceof AgentActionError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    console.error("agent chat sessions list failed:", error);
    return NextResponse.json({ error: "Failed to load chat sessions" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
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
    const chatSession = await createAgentChatSession(actor, {
      agentRunId: typeof body.agentRunId === "string" ? body.agentRunId : null,
      title: typeof body.title === "string" ? body.title : null,
      status: typeof body.status === "string" ? body.status : undefined,
      source: typeof body.source === "string" ? body.source : undefined,
      summary: typeof body.summary === "string" ? body.summary : null,
      compactSummary: typeof body.compactSummary === "string" ? body.compactSummary : null,
      metadata: body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
        ? body.metadata as Record<string, unknown>
        : null,
    });

    return NextResponse.json({ ok: true, session: chatSession }, { status: 201 });
  } catch (error) {
    if (error instanceof AgentActionError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    console.error("agent chat session create failed:", error);
    return NextResponse.json({ error: "Failed to create chat session" }, { status: 500 });
  }
}

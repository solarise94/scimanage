import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requireBusinessActorFromSession } from "@/lib/agent-actions/actor";
import { AgentActionError, AgentActionInputError } from "@/lib/agent-actions/errors";
import { createAgentChatMessage, getAgentChatSessionDetail, updateAgentChatSession } from "@/lib/agent-runtime/chat-sessions";
import { getAgentRuntimeBaseUrl, getAgentRuntimeToken, isPiAgentRuntimeEnabled } from "@/lib/agent-runtime/config";
import { requireAgentAccess } from "@/lib/agent-actions/require-agent-access";

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const denied = requireAgentAccess(session);
  if (denied) return denied;
  if (!isPiAgentRuntimeEnabled()) {
    return NextResponse.json({ error: "AGENT_RUNTIME is not set to pi" }, { status: 409 });
  }

  try {
    const body = await req.json();
    if (!body || typeof body !== "object") {
      throw new AgentActionInputError("Request body must be an object");
    }

    const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
    if (!sessionId) {
      throw new AgentActionInputError("sessionId is required");
    }

    const actor = requireBusinessActorFromSession(session);
    const chatSession = await getAgentChatSessionDetail(actor, sessionId);
    const runtimeRes = await fetch(`${getAgentRuntimeBaseUrl()}/chat-compact`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-agent-runtime-token": getAgentRuntimeToken(),
      },
      body: JSON.stringify({
        sessionId: chatSession.id,
        history: chatSession.messages.map((item) => ({
          role: item.role,
          content: item.content,
          createdAt: item.createdAt,
        })),
        compactSummary: chatSession.compactSummary,
      }),
    });

    const payload = await runtimeRes.json() as {
      ok?: boolean;
      summary?: string;
      tokensBefore?: number;
      tokensAfter?: number;
      error?: string;
    };
    if (!runtimeRes.ok) {
      throw new Error(payload.error || "Runtime compact failed");
    }

    const summary = payload.summary?.trim() || "";
    const updatedSession = await updateAgentChatSession(actor, chatSession.id, {
      compactSummary: summary,
    });

    const compactMessage = await createAgentChatMessage(actor, {
      sessionId: chatSession.id,
      agentRunId: updatedSession.agentRunId,
      role: "assistant",
      content: summary ? "已更新上下文摘要。" : "当前没有可压缩的有效上下文。",
      timeline: [
        {
          id: `compact_${Date.now()}`,
          kind: "compact",
          content: summary,
          status: "done",
          tokensBefore: payload.tokensBefore,
          tokensAfter: payload.tokensAfter,
        },
      ],
    });

    return NextResponse.json({
      ok: true,
      session: updatedSession,
      message: compactMessage,
      compactSummary: summary,
      tokensBefore: payload.tokensBefore ?? null,
      tokensAfter: payload.tokensAfter ?? null,
    });
  } catch (error) {
    if (error instanceof AgentActionError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    console.error("agent chat compact failed:", error);
    return NextResponse.json({ error: "Agent chat compact failed" }, { status: 500 });
  }
}

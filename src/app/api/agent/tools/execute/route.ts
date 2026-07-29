import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requireBusinessActorFromSession } from "@/lib/agent-actions/actor";
import { buildAgentExecutionContext, buildInvocationContext, type AgentExecutionContext } from "@/lib/application/actor";
import { AgentActionError, AgentActionInputError } from "@/lib/agent-actions/errors";
import { runAgentToolForActor } from "@/lib/agent-actions/execute-tool-for-run";
import {
  ensureAgentRunBelongsToSession,
  getExecutionContextFromAgentRun,
  isValidInternalToolToken,
  verifyChatSessionForActor,
} from "@/lib/agent-actions/run-context";
import { requireAgentAccess } from "@/lib/agent-actions/require-agent-access";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    if (!body || typeof body !== "object") {
      throw new AgentActionInputError("Request body must be an object");
    }

    const actionKey = typeof body.actionKey === "string" ? body.actionKey.trim() : "";
    if (!actionKey) {
      throw new AgentActionInputError("actionKey is required");
    }

    const agentRunId = typeof body.agentRunId === "string" ? body.agentRunId.trim() : "";
    // P1#2 层 B：runtime→tools/execute 回调携带 sessionId（runtime payload 已含），用于
    // confirm 类 action（如 add_note）创建 proposal 时持久化 chatSessionId，以便 confirm 时恢复。
    const chatSessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : null;
    const internalToken = req.headers.get("x-agent-internal-token");

    let execCtx: AgentExecutionContext;
    if (internalToken && isValidInternalToolToken(internalToken)) {
      if (!agentRunId) {
        throw new AgentActionInputError("agentRunId is required for internal tool execution");
      }
      execCtx = await getExecutionContextFromAgentRun(agentRunId);
    } else {
      const session = await getServerSession(authOptions);
      if (!session) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
      const denied = requireAgentAccess(session);
      if (denied) return denied;
      if (agentRunId) {
        await ensureAgentRunBelongsToSession(agentRunId, session);
        execCtx = await getExecutionContextFromAgentRun(agentRunId);
      } else {
        execCtx = buildAgentExecutionContext(
          requireBusinessActorFromSession(session),
          buildInvocationContext({ channel: "web" }),
        );
      }
    }
    // 把 chatSessionId 注入 actor（仅用于 confirm action 的 session 校验；safe action 不读它）。
    // P1#2 层 B（加固）：绝不直接信任请求体 sessionId；必须校验它属于当前用户且 run 一致，
    // 否则直连 tools/execute 可伪造 sessionId 绕过附件 session/run 隔离。
    if (chatSessionId) {
      const verifiedSessionId = await verifyChatSessionForActor({
        chatSessionId,
        userId: execCtx.actor.userId,
        agentRunId: execCtx.invocation.agentRunId ?? null,
      });
      execCtx = { ...execCtx, invocation: { ...execCtx.invocation, chatSessionId: verifiedSessionId } };
    }

    const outcome = await runAgentToolForActor(execCtx, actionKey, body.input);

    return NextResponse.json(
      { ok: true, ...outcome },
      { status: outcome.mode === "proposal" ? 202 : 200 },
    );
  } catch (error) {
    if (error instanceof AgentActionError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }

    console.error("agent tool execute failed:", error);
    return NextResponse.json({ error: "Failed to execute agent action" }, { status: 500 });
  }
}

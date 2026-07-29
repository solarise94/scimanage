/**
 * Phase A: public tool execution endpoint（修正 3/4）。
 *
 * POST /api/agent/tools/execute-public
 *
 * runtime（dynamic-bundle flag ON）经 bridge token 调此端点，**只认 publicToolKey**，
 * 不接受 internal actionKey（防绕过 manifest）。既有 /api/agent/tools/execute（内部
 * actionKey）保留；flag OFF 时 runtime 仍用既有路径，字节级不变。
 *
 * 双身份与 select-bundle 一致：internal token 或 NextAuth session，actor 服务端解析。
 * Phase A：所有 facade implemented:false → 全部返回 501，证明安全门就位。
 */
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requireBusinessActorFromSession } from "@/lib/agent-actions/actor";
import { buildInvocationContext, type AgentExecutionContext } from "@/lib/application/actor";
import { AgentActionError, AgentActionInputError } from "@/lib/agent-actions/errors";
import {
  ensureAgentRunBelongsToSession,
  getExecutionContextFromAgentRun,
  getTrustedAgentRunSource,
  isValidInternalToolToken,
  verifyChatSessionForActor,
} from "@/lib/agent-actions/run-context";
import { requireAgentAccess } from "@/lib/agent-actions/require-agent-access";
import { ensureBuiltinAgentActionsRegistered } from "@/lib/agent-actions/registry";
import { executePublicTool } from "@/lib/agent-actions/public/public-executor";
import { checkReadOnlyPolicyForPublicTool } from "@/lib/agent-runtime/openai-compat-policy";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      throw new AgentActionInputError("Request body must be an object");
    }

    const publicToolKey = typeof body.publicToolKey === "string" ? body.publicToolKey.trim() : "";
    if (!publicToolKey) {
      throw new AgentActionInputError("publicToolKey is required");
    }

    const agentRunId = typeof body.agentRunId === "string" ? body.agentRunId.trim() : "";
    const chatSessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : null;
    const internalToken = req.headers.get("x-agent-internal-token");

    // ── 双身份解析 actor ──
    let execCtx: AgentExecutionContext;
    if (internalToken && isValidInternalToolToken(internalToken)) {
      if (!agentRunId) {
        throw new AgentActionInputError("agentRunId is required for internal public tool execution");
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
        execCtx = {
          actor: requireBusinessActorFromSession(session),
          invocation: buildInvocationContext({ channel: "web" }),
        };
      }
    }
    if (chatSessionId) {
      const verified = await verifyChatSessionForActor({
        chatSessionId,
        userId: execCtx.actor.userId,
        agentRunId: execCtx.invocation.agentRunId ?? null,
      });
      execCtx = { ...execCtx, invocation: { ...execCtx.invocation, chatSessionId: verified } };
    }

    // 注册兜底（2026-07-27 demo flag-on 实测）：进程内可能尚无其他路径触发过
    // ensureBuiltinAgentActionsRegistered（如 runtime 首轮直接调 execute-public），
    // 导致 FACADE_REGISTRY 为空 → FACADE_HANDLER_MISSING。此处幂等确保注册。
    ensureBuiltinAgentActionsRegistered();

    // Phase 6 Layer 2 (design §8.4): read-only policy gate. The trusted
    // AgentRun.source is read from the DB (never from request body) and the
    // OPENAI_COMPAT run can only execute discovery/context public tools. This
    // is enforced BEFORE the facade handler runs, so a model hand-crafting a
    // write tool publicToolKey is refused with 403. Native CHAT runs are never
    // gated here. The canonical service scope gate remains the final boundary.
    const trustedRunSource = await getTrustedAgentRunSource(
      execCtx.invocation.agentRunId ?? null,
    );
    const policyCheck = checkReadOnlyPolicyForPublicTool(trustedRunSource, publicToolKey);
    if (policyCheck.denied) {
      return NextResponse.json(
        { error: policyCheck.reason, code: "OPENAI_COMPAT_READ_ONLY" },
        { status: 403 },
      );
    }

    const outcome = await executePublicTool({
      actor: execCtx.actor,
      invocation: execCtx.invocation,
      publicToolKey,
      publicInput: body.input,
    });

    if (!outcome.ok) {
      // P1-3 UI 接线：NEEDS_USER_CONFIRMATION 透出 targetIntent，让 runtime→timeline→
      // needs-user-confirmation 卡片能 mint 匹配的 AgentUserConfirmationEvent。
      // 其他失败分支保持原有 { error, code } 字节级不变。
      const body: Record<string, unknown> = { error: outcome.error, code: outcome.code };
      if (outcome.targetIntent) body.targetIntent = outcome.targetIntent;
      return NextResponse.json(body, { status: outcome.status });
    }

    // P2-3：按 facade 显式 mode 映射 HTTP 状态（不再按 internal action 名猜测）。
    // result/preview/needs_input → 200；proposal → 202（已产 PENDING proposal）。
    const mode = outcome.result.mode;
    const status = mode === "proposal" ? 202 : 200;
    return NextResponse.json(
      { ok: true, publicToolKey, result: outcome.result },
      { status },
    );
  } catch (error) {
    if (error instanceof AgentActionError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    console.error("execute-public failed:", error);
    return NextResponse.json({ error: "Failed to execute public tool" }, { status: 500 });
  }
}

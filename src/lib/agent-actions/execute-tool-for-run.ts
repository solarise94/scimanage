/**
 * 同进程 Agent 工具执行入口（T1.4）。
 *
 * 规范禁止 Agent adapter 通过服务端 `fetch("/api/**")` 复用页面/内部 route。
 * chat / chat-stream 过去用内部 HTTP + internal token 调 `/api/agent/tools/execute`
 * 触发 CRM 跟进或 planner 工具执行；这里把该逻辑抽成同进程直调，
 * 使 `/api/agent/tools/execute` route 与聊天 route 共用同一份 action 解析 +
 * confirm/execute 分支，不再有第二条内部 HTTP 复用路径。
 *
 * 本模块只依赖 agent-actions registry / proposals / run-context，
 * 不直接访问 Prisma，也不发起内部 HTTP。
 */
import type { AgentExecutionContext } from "@/lib/agent-actions/types";
import { AgentActionInputError } from "./errors";
import { buildModelFacingToolTextForAction } from "./format-tool-result-for-model";
import { createAgentProposal } from "./proposals";
import { executeAgentAction, getAgentAction } from "./registry";
import { getExecutionContextFromAgentRun, verifyChatSessionForActor } from "./run-context";

export interface AgentToolRunOutcome {
  actionKey: string;
  mode: "result" | "proposal";
  result?: unknown;
  proposal?: unknown;
  modelText: string;
}

/**
 * 用已解析的 actor 执行单个 action：confirm → 生成 proposal；safe → 直接执行。
 * 与 `/api/agent/tools/execute` 内联逻辑一致（单一真相）。
 */
export async function runAgentToolForActor(
  ctx: AgentExecutionContext,
  actionKey: string,
  input: unknown,
): Promise<AgentToolRunOutcome> {
  const action = getAgentAction(actionKey);
  if (!action) {
    throw new AgentActionInputError(`Unknown action: ${actionKey}`);
  }

  if (action.riskLevel === "confirm") {
    const proposal = await createAgentProposal(ctx, actionKey, input);
    const modelText = buildModelFacingToolTextForAction(action, {
      mode: "proposal",
      proposalTitle: typeof proposal.title === "string" ? proposal.title : null,
      proposalSummary: typeof proposal.summary === "string" ? proposal.summary : null,
    });
    return { actionKey, mode: "proposal", proposal, modelText };
  }

  const executed = await executeAgentAction(ctx, actionKey, input);
  const modelText = buildModelFacingToolTextForAction(action, {
    mode: "result",
    result: executed.result,
  });
  return { actionKey, mode: "result", result: executed.result, modelText };
}

/**
 * 由 AgentRun 解析当前 actor 后执行工具（同进程等价于 internal-token tools/execute）。
 *
 * 解析顺序与 route internal-token 分支一致：
 *  1. 由 agentRunId 重新解析当前 actor（刷新 role / 校验归属）；
 *  2. 若提供 chatSessionId，校验其属于当前用户且 run 一致后注入 actor；
 *  3. 执行 action。
 */
export async function executeAgentToolForRun(params: {
  agentRunId: string;
  actionKey: string;
  input: unknown;
  chatSessionId?: string | null;
}): Promise<AgentToolRunOutcome> {
  const actionKey = params.actionKey.trim();
  if (!actionKey) {
    throw new AgentActionInputError("actionKey is required");
  }
  if (!params.agentRunId) {
    throw new AgentActionInputError("agentRunId is required for internal tool execution");
  }

  let ctx = await getExecutionContextFromAgentRun(params.agentRunId);
  if (params.chatSessionId) {
    const verifiedSessionId = await verifyChatSessionForActor({
      chatSessionId: params.chatSessionId,
      userId: ctx.actor.userId,
      agentRunId: ctx.invocation.agentRunId ?? null,
    });
    ctx = { ...ctx, invocation: { ...ctx.invocation, chatSessionId: verifiedSessionId } };
  }

  return runAgentToolForActor(ctx, actionKey, params.input);
}

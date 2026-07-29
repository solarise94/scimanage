import {
  AgentActionConfirmationRequiredError,
  AgentActionForbiddenError,
  AgentActionNotFoundError,
} from "./errors";
import { createAgentActionLog } from "./logs";
import type {
  AgentActionDefinition,
  AgentActionExecutionResult,
  AgentActionTarget,
  AgentExecutionContext,
  BusinessActor,
} from "./types";
import { registerBuiltinAgentActions, assertBuiltinAgentActionsParity } from "./actions";

declare global {
  var __agentActionRegistry: Map<string, AgentActionDefinition<unknown, unknown>> | undefined;
  var __agentActionRegistryBuiltinsRegistered: boolean | undefined;
}

function getRegistryStore() {
  if (!globalThis.__agentActionRegistry) {
    globalThis.__agentActionRegistry = new Map<string, AgentActionDefinition<unknown, unknown>>();
  }
  return globalThis.__agentActionRegistry;
}

export function registerAgentAction<Input, Output>(action: AgentActionDefinition<Input, Output>) {
  const store = getRegistryStore();
  store.set(action.key, action as AgentActionDefinition<unknown, unknown>);
}

export function ensureBuiltinAgentActionsRegistered() {
  if (globalThis.__agentActionRegistryBuiltinsRegistered) return;
  registerBuiltinAgentActions();
  globalThis.__agentActionRegistryBuiltinsRegistered = true;

  // P2-2：manifest↔facade↔action registry 一致性断言（fire-and-forget，一次）。
  // 挂在这里而非 instrumentation.ts：instrumentation 会被 edge bundle 静态跟随
  // actions barrel（→ nodemailer → node builtins）导致 dev edge 编译失败；
  // registry 只在 nodejs 上下文（route/action/worker）被调用，天然安全。
  // 违规记录但不抛错（与 instrumentation worker 同策略）。
  void assertBuiltinAgentActionsParity().catch((err: unknown) => {
    console.error(
      "[agent-actions] manifest-facade parity check failed:",
      err instanceof Error ? err.message : err,
    );
  });
}

export function getAgentAction(key: string) {
  ensureBuiltinAgentActionsRegistered();
  return getRegistryStore().get(key);
}

export function listAgentActions() {
  ensureBuiltinAgentActionsRegistered();
  return Array.from(getRegistryStore().values()).sort((left, right) => left.key.localeCompare(right.key));
}

export async function listAvailableAgentActions(actor: BusinessActor) {
  const actions = listAgentActions();
  const checks = await Promise.all(actions.map(async (action) => ({ action, available: await action.availability(actor) })));
  return checks.filter((item) => item.available).map((item) => item.action);
}

export async function executeAgentAction<Output>(
  ctx: AgentExecutionContext,
  key: string,
  rawInput: unknown,
  opts: { allowConfirm?: boolean; proposalId?: string | null } = {},
): Promise<AgentActionExecutionResult<Output>> {
  const action = getAgentAction(key);
  if (!action) {
    throw new AgentActionNotFoundError(key);
  }

  const available = await action.availability(ctx.actor);
  if (!available) {
    throw new AgentActionForbiddenError();
  }

  if (action.riskLevel !== "safe" && !opts.allowConfirm) {
    throw new AgentActionConfirmationRequiredError();
  }

  const parsed = action.parseInput(rawInput);
  const executionCtx: AgentExecutionContext = opts.proposalId
    ? { ...ctx, invocation: { ...ctx.invocation, proposalId: opts.proposalId } }
    : ctx;
  try {
    const result = await action.execute(executionCtx, parsed) as Output;
    const target = action.resolveTarget
      ? await action.resolveTarget(parsed, result)
      : null;
    await createAgentActionLog(executionCtx, action, {
      status: opts.allowConfirm ? "CONFIRMED_EXECUTED" : "EXECUTED",
      input: parsed,
      output: result,
      proposalId: opts.proposalId ?? null,
      target: target as AgentActionTarget | null,
    });
    return { action: action as AgentActionDefinition<unknown, Output>, result };
  } catch (error) {
    await createAgentActionLog(executionCtx, action, {
      status: opts.allowConfirm ? "CONFIRMED_FAILED" : "FAILED",
      input: parsed,
      error: error instanceof Error ? error.message : "Action execution failed",
      proposalId: opts.proposalId ?? null,
    });
    throw error;
  }
}

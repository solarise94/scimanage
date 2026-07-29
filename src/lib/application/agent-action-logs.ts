/**
 * Agent runtime persistence service: AgentActionLog.
 *
 * Owns the only Prisma access for AgentActionLog writes. Agent adapters
 * (`src/lib/agent-actions/logs.ts`) re-export from here and must not touch
 * Prisma themselves. AgentActionLog is an Agent-own model (§1.4), so this
 * lives in the application layer alongside actor/proposal-lifecycle services.
 */
import { prisma } from "@/lib/prisma";
import type {
  AgentActionDefinition,
  AgentActionTarget,
  AgentExecutionContext,
} from "@/lib/agent-actions/types";

function stringify(value: unknown) {
  return value == null ? null : JSON.stringify(value);
}

function normalizeTarget(target?: AgentActionTarget | null) {
  return {
    targetType: target?.type ?? null,
    targetId: target?.id ?? null,
  };
}

/**
 * Low-level AgentActionLog writer accepting raw audit fields.
 *
 * Used by API adapters (e.g. attachment/invoice/import staging routes) whose
 * audit events are not tied to a registered `AgentActionDefinition` and carry
 * ad-hoc actionKey/status/target. Keeping this in the T1.2 service preserves the
 * single Prisma entry point for AgentActionLog writes.
 */
export async function writeAgentActionLog(params: {
  userId: string;
  agentRunId?: string | null;
  actionKey: string;
  riskLevel: string;
  status: string;
  input: unknown;
  output?: unknown;
  error?: string | null;
  proposalId?: string | null;
  target?: AgentActionTarget | null;
  /** 经 public facade 调度时由服务端注入；直调 internal action 为 null。 */
  publicToolKey?: string | null;
}) {
  const target = normalizeTarget(params.target);
  return prisma.agentActionLog.create({
    data: {
      userId: params.userId,
      agentRunId: params.agentRunId ?? null,
      actionKey: params.actionKey,
      riskLevel: params.riskLevel,
      status: params.status,
      inputJson: stringify(params.input) ?? "{}",
      outputJson: stringify(params.output),
      error: params.error ?? null,
      proposalId: params.proposalId ?? null,
      targetType: target.targetType,
      targetId: target.targetId,
      publicToolKey: params.publicToolKey ?? null,
    },
  });
}

export async function createAgentActionLog(
  ctx: AgentExecutionContext,
  action: AgentActionDefinition<unknown, unknown>,
  opts: {
    status: string;
    input: unknown;
    output?: unknown;
    error?: string | null;
    proposalId?: string | null;
    target?: AgentActionTarget | null;
  },
) {
  return writeAgentActionLog({
    userId: ctx.actor.userId,
    agentRunId: ctx.invocation.agentRunId ?? null,
    actionKey: action.key,
    riskLevel: action.riskLevel,
    status: opts.status,
    input: opts.input,
    output: opts.output,
    error: opts.error,
    proposalId: opts.proposalId,
    target: opts.target,
    // 受控元数据：只认 invocation.publicToolKey（由 public executor 注入），不读模型输入。
    publicToolKey: ctx.invocation.publicToolKey ?? null,
  });
}

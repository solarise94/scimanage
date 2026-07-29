/**
 * 将 proposal 确认/拒绝结果写入 Agent 会话消息，供下一轮 chat-stream history 消费。
 */

import { prisma } from "@/lib/prisma";
import type { BusinessActor } from "@/lib/application/actor";
import { createAgentChatMessage } from "@/lib/application/agent-chat-sessions";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function pickString(obj: Record<string, unknown> | null, key: string): string | null {
  if (!obj) return null;
  const v = obj[key];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function pickNestedString(
  obj: Record<string, unknown> | null,
  path: string[],
): string | null {
  let cur: unknown = obj;
  for (const key of path) {
    const rec = asRecord(cur);
    if (!rec) return null;
    cur = rec[key];
  }
  return typeof cur === "string" && cur.trim() ? cur.trim() : null;
}

/** 从 action 执行结果与 input 抽取模型后续需要的关键实体字段。 */
export function extractConfirmedProposalFacts(opts: {
  actionKey: string;
  input: unknown;
  result: unknown;
}): Record<string, string | null> {
  const input = asRecord(opts.input);
  const result = asRecord(opts.result);
  const order = asRecord(result?.order) ?? asRecord(result);
  const project = asRecord(result?.project);

  return {
    actionKey: opts.actionKey,
    orderId:
      pickNestedString(result, ["order", "id"]) ??
      pickString(order, "id") ??
      pickString(result, "orderId") ??
      pickString(input, "orderId"),
    orderNo:
      pickNestedString(result, ["order", "orderNo"]) ??
      pickString(order, "orderNo") ??
      pickString(result, "orderNo"),
    profileId:
      pickString(result, "profileId") ??
      pickNestedString(result, ["order", "profileId"]) ??
      pickString(input, "profileId"),
    projectId:
      pickNestedString(result, ["project", "id"]) ??
      pickString(project, "id") ??
      pickString(result, "projectId") ??
      pickString(input, "projectId"),
    projectName:
      pickNestedString(result, ["project", "name"]) ??
      pickString(project, "name") ??
      pickString(result, "projectName"),
    customerName:
      pickString(result, "customerName") ??
      pickNestedString(result, ["customer", "name"]) ??
      pickString(input, "customerName"),
  };
}

function formatConfirmedEventContent(opts: {
  actionKey: string;
  title: string;
  facts: Record<string, string | null>;
  result: unknown;
}): string {
  const lines = [
    `[系统事件] 用户已确认并执行 ${opts.actionKey}（${opts.title}）。`,
    "以下字段可供后续工具调用直接引用；不要编造未列出的 ID。",
  ];
  for (const [key, value] of Object.entries(opts.facts)) {
    if (key === "actionKey") continue;
    if (value) lines.push(`- ${key}: ${value}`);
  }
  lines.push(`- actionKey: ${opts.actionKey}`);

  // 附带精简 JSON，便于模型抽取；截断避免撑爆 history
  try {
    const compact = JSON.stringify(opts.result);
    if (compact && compact.length <= 1200) {
      lines.push(`结果 JSON：${compact}`);
    }
  } catch {
    // ignore
  }
  return lines.join("\n");
}

/** 解析确认事件应写入的会话。有 agentRunId 时不回退到无关会话。 */
export async function resolveChatSessionForProposal(
  actor: BusinessActor,
  proposal: { agentRunId: string | null },
): Promise<{ id: string; agentRunId: string | null } | null> {
  if (proposal.agentRunId) {
    // 有 agentRunId 时只绑定对应会话；找不到则放弃写入，避免污染无关会话。
    return prisma.agentChatSession.findFirst({
      where: {
        userId: actor.userId,
        agentRunId: proposal.agentRunId,
        status: "ACTIVE",
      },
      orderBy: { lastMessageAt: "desc" },
      select: { id: true, agentRunId: true },
    });
  }
  return prisma.agentChatSession.findFirst({
    where: { userId: actor.userId, status: "ACTIVE" },
    orderBy: { lastMessageAt: "desc" },
    select: { id: true, agentRunId: true },
  });
}

/**
 * 确认成功后写入会话系统事件。失败只打日志，不回滚业务结果。
 */
export async function appendConfirmedProposalChatEvent(opts: {
  actor: BusinessActor;
  proposal: {
    id: string;
    actionKey: string;
    title: string;
    agentRunId: string | null;
    inputJson: string;
  };
  result: unknown;
}): Promise<{ messageId: string; sessionId: string } | null> {
  try {
    const session = await resolveChatSessionForProposal(opts.actor, opts.proposal);
    if (!session) return null;

    let input: unknown = null;
    try {
      input = JSON.parse(opts.proposal.inputJson) as unknown;
    } catch {
      input = null;
    }
    const facts = extractConfirmedProposalFacts({
      actionKey: opts.proposal.actionKey,
      input,
      result: opts.result,
    });
    const content = formatConfirmedEventContent({
      actionKey: opts.proposal.actionKey,
      title: opts.proposal.title,
      facts,
      result: opts.result,
    });

    const message = await createAgentChatMessage(opts.actor, {
      sessionId: session.id,
      agentRunId: opts.proposal.agentRunId ?? session.agentRunId,
      // 走 assistant：前端把非 user 都当 assistant 展示；内容带结构化字段供模型下一轮引用
      role: "assistant",
      content,
      timeline: [
        {
          id: `proposal_confirmed_${opts.proposal.id}`,
          kind: "text",
          content,
          status: "done",
        },
      ],
      metadata: {
        kind: "proposal_confirmed",
        proposalId: opts.proposal.id,
        actionKey: opts.proposal.actionKey,
        ...facts,
      },
    });

    return { messageId: message.id, sessionId: session.id };
  } catch (err) {
    console.warn(
      "[proposal-chat-events] append confirmed event failed:",
      opts.proposal.id,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

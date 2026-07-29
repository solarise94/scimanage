import { prisma } from "@/lib/prisma";
import type { BusinessActor } from "@/lib/application/actor";
import { AgentActionForbiddenError } from "@/lib/agent-actions/errors";
import { assertAgentRunOwnership } from "@/lib/application/agent-chat-sessions";
import { createNotificationInTx } from "@/lib/application/notifications";
import { parseJsonValue } from "@/lib/agent-runtime/serde";
import type { AgentProactiveTaskRecord } from "@/lib/agent-runtime/types";

function mapAgentProactiveTask(task: {
  id: string;
  userId: string;
  agentRunId: string | null;
  sessionId: string | null;
  kind: string;
  title: string;
  payloadJson: string;
  status: string;
  triggerAt: Date;
  notificationId: string | null;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
  decidedAt: Date | null;
}): AgentProactiveTaskRecord {
  return {
    id: task.id,
    userId: task.userId,
    agentRunId: task.agentRunId,
    sessionId: task.sessionId,
    kind: task.kind,
    title: task.title,
    payload: parseJsonValue<Record<string, unknown>>(task.payloadJson, {}),
    status: task.status,
    triggerAt: task.triggerAt.toISOString(),
    notificationId: task.notificationId,
    error: task.error,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
    decidedAt: task.decidedAt?.toISOString() ?? null,
  };
}

function normalizeDecidedAt(status: string | undefined) {
  if (!status) return undefined;
  if (status === "SCHEDULED" || status === "CANCELLED") {
    return new Date();
  }
  return undefined;
}

export async function listAgentProactiveTasks(
  actor: BusinessActor,
  opts: { status?: string; kind?: string; limit?: number } = {},
) {
  const tasks = await prisma.agentProactiveTask.findMany({
    where: {
      userId: actor.userId,
      ...(opts.status ? { status: opts.status } : {}),
      ...(opts.kind ? { kind: opts.kind } : {}),
    },
    orderBy: [{ triggerAt: "asc" }, { createdAt: "desc" }],
    take: Math.max(1, Math.min(opts.limit ?? 50, 200)),
  });

  return tasks.map(mapAgentProactiveTask);
}

export async function createAgentProactiveTask(
  actor: BusinessActor,
  input: {
    agentRunId?: string | null;
    sessionId?: string | null;
    kind: string;
    title: string;
    payload: Record<string, unknown>;
    triggerAt: string;
    status?: string;
  },
) {
  if (input.agentRunId?.trim()) {
    await assertAgentRunOwnership(actor, input.agentRunId.trim());
  }
  if (input.sessionId?.trim()) {
    const session = await prisma.agentChatSession.findUnique({
      where: { id: input.sessionId.trim() },
      select: { id: true, userId: true },
    });
    if (!session || session.userId !== actor.userId) {
      throw new AgentActionForbiddenError("Chat session not found");
    }
  }

  const status = input.status?.trim() || "PENDING";
  const created = await prisma.agentProactiveTask.create({
    data: {
      userId: actor.userId,
      agentRunId: input.agentRunId?.trim() || null,
      sessionId: input.sessionId?.trim() || null,
      kind: input.kind.trim(),
      title: input.title.trim(),
      payloadJson: JSON.stringify(input.payload),
      triggerAt: new Date(input.triggerAt),
      status,
      decidedAt: normalizeDecidedAt(status),
    },
  });

  return mapAgentProactiveTask(created);
}

export async function updateAgentProactiveTask(
  actor: BusinessActor,
  taskId: string,
  input: {
    kind?: string;
    title?: string;
    payload?: Record<string, unknown>;
    triggerAt?: string;
    status?: string;
    error?: string | null;
  },
) {
  const existing = await prisma.agentProactiveTask.findUnique({
    where: { id: taskId },
    select: { id: true, userId: true },
  });

  if (!existing || existing.userId !== actor.userId) {
    throw new AgentActionForbiddenError("Proactive task not found");
  }

  const decidedAt = normalizeDecidedAt(input.status);
  const updated = await prisma.agentProactiveTask.update({
    where: { id: taskId },
    data: {
      ...(input.kind !== undefined ? { kind: input.kind.trim() } : {}),
      ...(input.title !== undefined ? { title: input.title.trim() } : {}),
      ...(input.payload !== undefined ? { payloadJson: JSON.stringify(input.payload) } : {}),
      ...(input.triggerAt !== undefined ? { triggerAt: new Date(input.triggerAt) } : {}),
      ...(input.status !== undefined ? { status: input.status.trim() } : {}),
      ...(input.error !== undefined ? { error: input.error?.trim() || null } : {}),
      ...(decidedAt ? { decidedAt } : {}),
    },
  });

  return mapAgentProactiveTask(updated);
}

function buildNotificationPayload(task: {
  id: string;
  title: string;
  payloadJson: string;
}) {
  const payload = parseJsonValue<Record<string, unknown>>(task.payloadJson, {});
  const content = typeof payload.content === "string"
    ? payload.content
    : typeof payload.message === "string"
      ? payload.message
      : `${task.title} 已到提醒时间。`;
  const link = typeof payload.link === "string" ? payload.link : null;
  return { content, link };
}

export async function runDueAgentProactiveTasks() {
  const now = new Date();
  const dueTasks = await prisma.agentProactiveTask.findMany({
    where: {
      status: { in: ["PENDING", "SCHEDULED"] },
      triggerAt: { lte: now },
    },
    orderBy: { triggerAt: "asc" },
    take: 100,
  });

  let sent = 0;
  let failed = 0;

  for (const task of dueTasks) {
    try {
      const payload = buildNotificationPayload(task);
      await prisma.$transaction(async (tx) => {
        // 业务模型写入走 notification canonical service（T9.1a），agent 任务状态同事务原子更新
        const notification = await createNotificationInTx(tx, {
          userId: task.userId,
          title: task.title,
          content: payload.content,
          type: "AGENT_PROACTIVE",
          link: payload.link,
          dedupeKey: `agent-proactive:${task.id}`,
        });

        await tx.agentProactiveTask.update({
          where: { id: task.id },
          data: {
            status: "SENT",
            notificationId: notification.id,
            error: null,
          },
        });
      });
      sent += 1;
    } catch (error) {
      failed += 1;
      await prisma.agentProactiveTask.update({
        where: { id: task.id },
        data: {
          status: "FAILED",
          error: error instanceof Error ? error.message : "Failed to dispatch proactive task",
        },
      });
    }
  }

  return {
    checked: dueTasks.length,
    sent,
    failed,
  };
}

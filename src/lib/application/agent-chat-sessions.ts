import { prisma } from "@/lib/prisma";
import type { BusinessActor } from "@/lib/application/actor";
import { writeAgentActionLog } from "@/lib/application/agent-action-logs";
import { AgentActionForbiddenError, AgentActionInputError, AgentActionNotFoundError } from "@/lib/agent-actions/errors";
import { bindAttachmentsToSessionAndRun } from "@/lib/application/agent-attachment-staging";
import { parseJsonValue, serializeJsonValue } from "@/lib/agent-runtime/serde";
import type {
  AgentChatMessageRecord,
  AgentChatSessionDetailRecord,
  AgentChatSessionSummaryRecord,
  AgentTimelineItem,
} from "@/lib/agent-runtime/types";

function mapAgentChatMessage(message: {
  id: string;
  sessionId: string;
  agentRunId: string | null;
  userId: string;
  role: string;
  content: string;
  state: string;
  timelineJson: string | null;
  tokenUsageJson: string | null;
  metadataJson: string | null;
  createdAt: Date;
  attachmentLinks?: Array<{
    staging: {
      id: string;
      originalName: string;
      mimeType: string;
      sizeBytes: number;
      status: string;
      expiresAt: Date;
    };
  }>;
}): AgentChatMessageRecord {
  const now = Date.now();
  return {
    id: message.id,
    sessionId: message.sessionId,
    agentRunId: message.agentRunId,
    userId: message.userId,
    role: message.role,
    content: message.content,
    state: message.state,
    timeline: parseJsonValue<AgentTimelineItem[]>(message.timelineJson, []),
    tokenUsage: parseJsonValue<Record<string, unknown> | null>(message.tokenUsageJson, null),
    metadata: parseJsonValue<Record<string, unknown> | null>(message.metadataJson, null),
    ...(message.attachmentLinks
      ? {
          attachments: message.attachmentLinks.map((link) => ({
            stagingFileId: link.staging.id,
            fileName: link.staging.originalName,
            mimeType: link.staging.mimeType,
            fileSize: link.staging.sizeBytes,
            status: link.staging.status,
            expired: link.staging.expiresAt.getTime() <= now,
          })),
        }
      : {}),
    createdAt: message.createdAt.toISOString(),
  };
}

function mapAgentChatSessionSummary(session: {
  id: string;
  userId: string;
  agentRunId: string | null;
  title: string | null;
  status: string;
  source: string;
  summary: string | null;
  compactSummary: string | null;
  metadataJson: string | null;
  createdAt: Date;
  updatedAt: Date;
  lastMessageAt: Date;
  _count?: { messages?: number };
}): AgentChatSessionSummaryRecord {
  return {
    id: session.id,
    userId: session.userId,
    agentRunId: session.agentRunId,
    title: session.title,
    status: session.status,
    source: session.source,
    summary: session.summary,
    compactSummary: session.compactSummary,
    metadata: parseJsonValue<Record<string, unknown> | null>(session.metadataJson, null),
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString(),
    lastMessageAt: session.lastMessageAt.toISOString(),
    messageCount: session._count?.messages ?? 0,
  };
}

export async function assertAgentRunOwnership(actor: BusinessActor, agentRunId: string) {
  const run = await prisma.agentRun.findUnique({
    where: { id: agentRunId },
    select: { id: true, userId: true },
  });
  if (!run || run.userId !== actor.userId) {
    throw new AgentActionForbiddenError("Agent run not found");
  }
  return run;
}

export async function listAgentChatSessions(
  actor: BusinessActor,
  opts: { status?: string; limit?: number } = {},
) {
  await purgeExpiredAgentChatSessions(actor);
  const sessions = await prisma.agentChatSession.findMany({
    where: {
      userId: actor.userId,
      ...(opts.status ? { status: opts.status } : {}),
    },
    orderBy: { lastMessageAt: "desc" },
    take: Math.max(1, Math.min(opts.limit ?? 30, 100)),
    select: {
      id: true,
      userId: true,
      agentRunId: true,
      title: true,
      status: true,
      source: true,
      summary: true,
      compactSummary: true,
      metadataJson: true,
      createdAt: true,
      updatedAt: true,
      lastMessageAt: true,
      _count: { select: { messages: true } },
    },
  });

  return sessions.map(mapAgentChatSessionSummary);
}

/** 会话保留期：超过 N 天未活跃的会话在下次列表读取时自动清除（懒清理，免定时任务）。 */
export const AGENT_CHAT_SESSION_RETENTION_DAYS = 30;

async function writeChatSessionActionLog(
  actor: BusinessActor,
  opts: {
    actionKey: string;
    status: string;
    input: Record<string, unknown>;
    targetId?: string | null;
    agentRunId?: string | null;
  },
) {
  // T9.1c：审计写入收敛到 AgentActionLog 统一入口（原为直连 prisma.agentActionLog.create）
  await writeAgentActionLog({
    userId: actor.userId,
    agentRunId: opts.agentRunId ?? null,
    actionKey: opts.actionKey,
    riskLevel: "confirm",
    status: opts.status,
    input: opts.input,
    output: { ok: true },
    target: { type: "agent_chat_session", id: opts.targetId ?? null },
  });
}

async function purgeExpiredAgentChatSessions(actor: BusinessActor) {
  const cutoff = new Date(Date.now() - AGENT_CHAT_SESSION_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const expired = await prisma.agentChatSession.findMany({
    where: { userId: actor.userId, lastMessageAt: { lt: cutoff } },
    select: {
      id: true,
      _count: { select: { messages: true } },
    },
  });
  if (expired.length === 0) return;

  const sessionIds = expired.map((session) => session.id);
  const messageCount = expired.reduce((sum, session) => sum + session._count.messages, 0);

  // messages 由 schema 的 onDelete: Cascade 级联删除（DB 层 referential action，deleteMany 同样生效）。
  await prisma.agentChatSession.deleteMany({
    where: { id: { in: sessionIds }, userId: actor.userId },
  });

  await writeChatSessionActionLog(actor, {
    actionKey: "agent.chat_session.purge_expired",
    status: "CHAT_SESSION_PURGED",
    targetId: sessionIds.length === 1 ? sessionIds[0] : null,
    input: {
      reason: "expired_retention",
      retentionDays: AGENT_CHAT_SESSION_RETENTION_DAYS,
      cutoff: cutoff.toISOString(),
      sessionIds,
      sessionCount: sessionIds.length,
      messageCount,
    },
  });
}

/** 删除单个会话（仅限本人）。消息级联删除。 */
export async function deleteAgentChatSession(actor: BusinessActor, sessionId: string) {
  const existing = await prisma.agentChatSession.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      userId: true,
      _count: { select: { messages: true } },
    },
  });
  if (!existing || existing.userId !== actor.userId) {
    throw new AgentActionNotFoundError(sessionId, "会话不存在");
  }
  await prisma.agentChatSession.delete({ where: { id: sessionId } });
  await writeChatSessionActionLog(actor, {
    actionKey: "agent.chat_session.delete",
    status: "CHAT_SESSION_DELETED",
    targetId: sessionId,
    input: {
      reason: "manual",
      sessionId,
      messageCount: existing._count.messages,
    },
  });
  return { ok: true as const };
}

export async function createAgentChatSession(
  actor: BusinessActor,
  input: {
    agentRunId?: string | null;
    title?: string | null;
    status?: string;
    source?: string;
    summary?: string | null;
    compactSummary?: string | null;
    metadata?: Record<string, unknown> | null;
  },
) {
  if (input.agentRunId) {
    await assertAgentRunOwnership(actor, input.agentRunId);
  }

  const created = await prisma.agentChatSession.create({
    data: {
      userId: actor.userId,
      agentRunId: input.agentRunId ?? null,
      title: input.title?.trim() || null,
      status: input.status?.trim() || "ACTIVE",
      source: input.source?.trim() || "CHAT",
      summary: input.summary?.trim() || null,
      compactSummary: input.compactSummary?.trim() || null,
      metadataJson: serializeJsonValue(input.metadata),
      lastMessageAt: new Date(),
    },
    select: {
      id: true,
      userId: true,
      agentRunId: true,
      title: true,
      status: true,
      source: true,
      summary: true,
      compactSummary: true,
      metadataJson: true,
      createdAt: true,
      updatedAt: true,
      lastMessageAt: true,
      _count: { select: { messages: true } },
    },
  });

  return mapAgentChatSessionSummary(created);
}

/**
 * P2：在已开启的事务内创建 chat session。调用方把 session + 绑定 + 消息/link 放同一事务，
 * 使绑定失败或消息写入异常时整笔回滚，不留空 AgentChatSession。
 * ownership 校验在事务外完成（只读）；返回 summary（未映射为 detail）。
 */
export async function createAgentChatSessionInTx(
  tx: ChatTxClient,
  actor: BusinessActor,
  input: {
    agentRunId?: string | null;
    title?: string | null;
    status?: string;
    source?: string;
    summary?: string | null;
    compactSummary?: string | null;
    metadata?: Record<string, unknown> | null;
  },
) {
  const created = await tx.agentChatSession.create({
    data: {
      userId: actor.userId,
      agentRunId: input.agentRunId ?? null,
      title: input.title?.trim() || null,
      status: input.status?.trim() || "ACTIVE",
      source: input.source?.trim() || "CHAT",
      summary: input.summary?.trim() || null,
      compactSummary: input.compactSummary?.trim() || null,
      metadataJson: serializeJsonValue(input.metadata),
      lastMessageAt: new Date(),
    },
    select: {
      id: true,
      userId: true,
      agentRunId: true,
      title: true,
      status: true,
      source: true,
      summary: true,
      compactSummary: true,
      metadataJson: true,
      createdAt: true,
      updatedAt: true,
      lastMessageAt: true,
      _count: { select: { messages: true } },
    },
  });
  return mapAgentChatSessionSummary(created);
}

export async function getAgentChatSessionDetail(actor: BusinessActor, sessionId: string) {
  const session = await prisma.agentChatSession.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      userId: true,
      agentRunId: true,
      title: true,
      status: true,
      source: true,
      summary: true,
      compactSummary: true,
      metadataJson: true,
      createdAt: true,
      updatedAt: true,
      lastMessageAt: true,
      _count: { select: { messages: true } },
      messages: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          sessionId: true,
          agentRunId: true,
          userId: true,
          role: true,
          content: true,
          state: true,
          timelineJson: true,
          tokenUsageJson: true,
          metadataJson: true,
          createdAt: true,
          attachmentLinks: {
            orderBy: { sortOrder: "asc" },
            select: {
              staging: {
                select: {
                  id: true,
                  originalName: true,
                  mimeType: true,
                  sizeBytes: true,
                  status: true,
                  expiresAt: true,
                },
              },
            },
          },
        },
      },
    },
  });

  if (!session || session.userId !== actor.userId) {
    throw new AgentActionForbiddenError("Chat session not found");
  }

  const summary = mapAgentChatSessionSummary(session);
  const detail: AgentChatSessionDetailRecord = {
    ...summary,
    messages: session.messages.map(mapAgentChatMessage),
  };
  return detail;
}

export async function updateAgentChatSession(
  actor: BusinessActor,
  sessionId: string,
  input: {
    title?: string | null;
    status?: string;
    source?: string;
    summary?: string | null;
    compactSummary?: string | null;
    metadata?: Record<string, unknown> | null;
  },
) {
  const existing = await prisma.agentChatSession.findUnique({
    where: { id: sessionId },
    select: { id: true, userId: true },
  });

  if (!existing || existing.userId !== actor.userId) {
    throw new AgentActionForbiddenError("Chat session not found");
  }

  const updated = await prisma.agentChatSession.update({
    where: { id: sessionId },
    data: {
      ...(input.title !== undefined ? { title: input.title?.trim() || null } : {}),
      ...(input.status !== undefined ? { status: input.status.trim() || "ACTIVE" } : {}),
      ...(input.source !== undefined ? { source: input.source.trim() || "CHAT" } : {}),
      ...(input.summary !== undefined ? { summary: input.summary?.trim() || null } : {}),
      ...(input.compactSummary !== undefined ? { compactSummary: input.compactSummary?.trim() || null } : {}),
      ...(input.metadata !== undefined ? { metadataJson: serializeJsonValue(input.metadata) } : {}),
    },
    select: {
      id: true,
      userId: true,
      agentRunId: true,
      title: true,
      status: true,
      source: true,
      summary: true,
      compactSummary: true,
      metadataJson: true,
      createdAt: true,
      updatedAt: true,
      lastMessageAt: true,
      _count: { select: { messages: true } },
    },
  });

  return mapAgentChatSessionSummary(updated);
}

/** Prisma 事务客户端的最小类型约束（prisma 单例与 $transaction 的 tx 都满足）。 */
type ChatTxClient = Parameters<Parameters<typeof prisma["$transaction"]>[0]>[0];

export type CreateAgentChatMessageInput = {
  sessionId: string;
  agentRunId?: string | null;
  role: string;
  content: string;
  state?: string;
  timeline?: AgentTimelineItem[];
  tokenUsage?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
  /**
   * 通用附件 staging ID 列表（docs §6.2.3）。提供时在同一事务内创建
   * AgentChatAttachmentLink，确保「消息 + link」原子，部分失败整体回滚，不留半绑定消息。
   */
  attachmentStagingIds?: string[];
};

/**
 * 在已开启的事务内创建消息 + 附件 link + 更新 session。
 * P1#3: 调用方可在同一 tx 内先跑 bindAttachmentsToSessionAndRun，使「绑定 + 消息 + link」原子。
 * 返回原始消息行（尚未经 mapAgentChatMessage 转换）。
 */
export async function createAgentChatMessageInTx(
  tx: ChatTxClient,
  actor: BusinessActor,
  input: CreateAgentChatMessageInput,
) {
  const message = await tx.agentChatMessage.create({
    data: {
      sessionId: input.sessionId,
      agentRunId: input.agentRunId ?? null,
      userId: actor.userId,
      role: input.role.trim(),
      content: input.content,
      state: input.state?.trim() || "done",
      timelineJson: serializeJsonValue(input.timeline ?? []),
      tokenUsageJson: serializeJsonValue(input.tokenUsage),
      metadataJson: serializeJsonValue(input.metadata),
    },
    select: {
      id: true,
      sessionId: true,
      agentRunId: true,
      userId: true,
      role: true,
      content: true,
      state: true,
      timelineJson: true,
      tokenUsageJson: true,
      metadataJson: true,
      createdAt: true,
    },
  });

  // 同事务创建附件关联（事实源）；任一失败 → 整笔回滚，不产生无 link 的半消息。
  if (input.attachmentStagingIds && input.attachmentStagingIds.length > 0) {
    await Promise.all(
      input.attachmentStagingIds.map((stagingId, index) =>
        tx.agentChatAttachmentLink.create({
          data: {
            messageId: message.id,
            stagingId,
            sortOrder: index,
          },
        }),
      ),
    );
  }

  await tx.agentChatSession.update({
    where: { id: input.sessionId },
    data: { lastMessageAt: message.createdAt },
  });

  return message;
}

export async function createAgentChatMessage(
  actor: BusinessActor,
  input: CreateAgentChatMessageInput,
) {
  const session = await prisma.agentChatSession.findUnique({
    where: { id: input.sessionId },
    select: { id: true, userId: true },
  });
  if (!session || session.userId !== actor.userId) {
    throw new AgentActionForbiddenError("Chat session not found");
  }

  if (!input.content.trim()) {
    throw new AgentActionInputError("content is required");
  }

  const created = await prisma.$transaction(async (tx) =>
    createAgentChatMessageInTx(tx, actor, input),
  );

  return mapAgentChatMessage(created);
}

/**
 * T1.4：chat / chat-stream 用户回合的原子提交（去 route Prisma）。
 *
 * 把「（可选）新建 session + （可选）绑定附件 + 写用户消息/link」收敛到同一事务：
 * 绑定失败（并发/跨会话，抛 StagingError）或消息写入异常 → 整笔回滚，
 * 不留空 AgentChatSession、不留半绑定消息（docs §6.2.2/§6.2.3）。
 *
 * ownership / 附件校验由调用方在事务外完成；本函数只负责事务内写入。
 * 返回提交后的 sessionId（新 session 时为新建 id）。
 */
export async function commitAgentChatUserMessage(
  actor: BusinessActor,
  input: {
    /** 无既有 sessionId 时为 true，需在事务内新建 session。 */
    needsNewSession: boolean;
    /** 既有会话 id（needsNewSession=false 时必填）。 */
    existingSessionId?: string | null;
    agentRunId: string;
    /** 新建 session 时的标题。 */
    newSessionTitle: string;
    source?: string;
    message: string;
    inputMode?: "voice" | "text" | null;
    attachmentStagingIds: string[];
  },
): Promise<string> {
  const hasAttachments = input.attachmentStagingIds.length > 0;
  return prisma.$transaction(async (tx) => {
    let activeSessionId = input.needsNewSession ? null : input.existingSessionId ?? null;
    if (input.needsNewSession) {
      const created = await createAgentChatSessionInTx(tx, actor, {
        agentRunId: input.agentRunId,
        title: input.newSessionTitle,
        source: input.source ?? "CHAT",
      });
      activeSessionId = created.id;
    }
    if (!activeSessionId) {
      throw new Error("sessionId 未初始化（不应到达）");
    }
    if (hasAttachments) {
      await bindAttachmentsToSessionAndRun(
        {
          stagingIds: input.attachmentStagingIds,
          userId: actor.userId,
          chatSessionId: activeSessionId,
          agentRunId: input.agentRunId,
        },
        tx,
      );
    }
    await createAgentChatMessageInTx(tx, actor, {
      sessionId: activeSessionId,
      agentRunId: input.agentRunId,
      role: "user",
      content: input.message,
      timeline: [{ id: `user_${Date.now()}`, kind: "text", content: input.message, status: "done" }],
      metadata: {
        ...(input.inputMode ? { inputMode: input.inputMode } : {}),
        ...(hasAttachments ? { attachmentCount: input.attachmentStagingIds.length } : {}),
      },
      attachmentStagingIds: hasAttachments ? input.attachmentStagingIds : undefined,
    });
    return activeSessionId;
  });
}

import { prisma } from "@/lib/prisma";
import type { BusinessActor } from "@/lib/application/actor";
import { AgentActionForbiddenError } from "@/lib/agent-actions/errors";
import { parseJsonValue, serializeJsonValue } from "@/lib/agent-runtime/serde";
import type { AgentMemoryRecord } from "@/lib/agent-runtime/types";

function mapAgentMemory(memory: {
  id: string;
  userId: string;
  scope: string;
  kind: string;
  content: string;
  confidence: number;
  source: string;
  sourceMessageId: string | null;
  status: string;
  metadataJson: string | null;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): AgentMemoryRecord {
  return {
    id: memory.id,
    userId: memory.userId,
    scope: memory.scope,
    kind: memory.kind,
    content: memory.content,
    confidence: memory.confidence,
    source: memory.source,
    sourceMessageId: memory.sourceMessageId,
    status: memory.status,
    metadata: parseJsonValue<Record<string, unknown> | null>(memory.metadataJson, null),
    expiresAt: memory.expiresAt?.toISOString() ?? null,
    lastUsedAt: memory.lastUsedAt?.toISOString() ?? null,
    createdAt: memory.createdAt.toISOString(),
    updatedAt: memory.updatedAt.toISOString(),
  };
}

/** 实体记忆召回候选（严格限当前 userId；ACTIVE|STALE + 有 embedding）。 */
export type EntityMemoryRecallRow = {
  id: string;
  entityType: string;
  entityId: string;
  name: string;
  summary: string;
  activityScore: number;
  lastActiveAt: Date | null;
  embeddingBytes: Buffer | null;
  metadataJson: string | null;
};

/** 普通记忆召回候选（严格限当前 userId；ACTIVE + 有 embedding）。 */
export type MemoryRecallRow = {
  id: string;
  kind: string;
  content: string;
  confidence: number;
  lastUsedAt: Date | null;
  embeddingBytes: Buffer | null;
};

/**
 * 向量召回候选池（`agent.recall_memory` 专用）。
 *
 * scope-first：候选严格限当前 userId，且必须已有 embeddingBytes；实体记忆取
 * ACTIVE|STALE（ARCHIVED 不召回），普通记忆取 ACTIVE。AgentEntityMemory /
 * AgentMemory 均为 Agent 自身模型（§1.4），持久化收敛在本 runtime service。
 * 实体记忆的项目 scope 再校验由调用方通过 `filterEntityMemoriesForActor` 完成。
 */
export async function listRecallCandidates(
  userId: string,
  opts: { entityType?: "project" | "customer" } = {},
): Promise<{ entityRows: EntityMemoryRecallRow[]; memoryRows: MemoryRecallRow[] }> {
  const [entityRows, memoryRows] = await Promise.all([
    prisma.agentEntityMemory.findMany({
      where: {
        userId,
        status: { in: ["ACTIVE", "STALE"] },
        NOT: { embeddingBytes: null },
        ...(opts.entityType ? { entityType: opts.entityType } : {}),
      },
      select: {
        id: true,
        entityType: true,
        entityId: true,
        name: true,
        summary: true,
        activityScore: true,
        lastActiveAt: true,
        embeddingBytes: true,
        metadataJson: true,
      },
    }),
    prisma.agentMemory.findMany({
      where: {
        userId,
        status: "ACTIVE",
        NOT: { embeddingBytes: null },
      },
      select: {
        id: true,
        kind: true,
        content: true,
        confidence: true,
        lastUsedAt: true,
        embeddingBytes: true,
      },
    }),
  ]);
  return { entityRows, memoryRows };
}

export async function listAgentMemory(
  actor: BusinessActor,
  opts: { kind?: string; status?: string; limit?: number } = {},
) {
  const items = await prisma.agentMemory.findMany({
    where: {
      userId: actor.userId,
      ...(opts.kind ? { kind: opts.kind } : {}),
      ...(opts.status ? { status: opts.status } : {}),
    },
    orderBy: [{ lastUsedAt: "desc" }, { updatedAt: "desc" }],
    take: Math.max(1, Math.min(opts.limit ?? 50, 200)),
  });

  return items.map(mapAgentMemory);
}

export async function createAgentMemory(
  actor: BusinessActor,
  input: {
    scope?: string;
    kind: string;
    content: string;
    confidence?: number;
    source?: string;
    sourceMessageId?: string | null;
    status?: string;
    metadata?: Record<string, unknown> | null;
    expiresAt?: string | null;
    lastUsedAt?: string | null;
  },
) {
  const created = await prisma.agentMemory.create({
    data: {
      userId: actor.userId,
      scope: input.scope?.trim() || "USER",
      kind: input.kind.trim(),
      content: input.content.trim(),
      // 缺省 confidence：0.5 = 中性。上游未显式给出置信度时不应假设高可信。
      confidence: input.confidence ?? 0.5,
      source: input.source?.trim() || "USER_EXPLICIT",
      sourceMessageId: input.sourceMessageId?.trim() || null,
      status: input.status?.trim() || "ACTIVE",
      metadataJson: serializeJsonValue(input.metadata),
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      lastUsedAt: input.lastUsedAt ? new Date(input.lastUsedAt) : null,
    },
  });

  return mapAgentMemory(created);
}

export async function updateAgentMemory(
  actor: BusinessActor,
  memoryId: string,
  input: {
    scope?: string;
    kind?: string;
    content?: string;
    confidence?: number;
    source?: string;
    sourceMessageId?: string | null;
    status?: string;
    metadata?: Record<string, unknown> | null;
    expiresAt?: string | null;
    lastUsedAt?: string | null;
  },
) {
  const existing = await prisma.agentMemory.findUnique({
    where: { id: memoryId },
    select: { id: true, userId: true },
  });

  if (!existing || existing.userId !== actor.userId) {
    throw new AgentActionForbiddenError("Memory not found");
  }

  const updated = await prisma.agentMemory.update({
    where: { id: memoryId },
    data: {
      ...(input.scope !== undefined ? { scope: input.scope.trim() || "USER" } : {}),
      ...(input.kind !== undefined ? { kind: input.kind.trim() } : {}),
      ...(input.content !== undefined ? { content: input.content.trim() } : {}),
      ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
      ...(input.source !== undefined ? { source: input.source.trim() || "USER_EXPLICIT" } : {}),
      ...(input.sourceMessageId !== undefined ? { sourceMessageId: input.sourceMessageId?.trim() || null } : {}),
      ...(input.status !== undefined ? { status: input.status.trim() || "ACTIVE" } : {}),
      ...(input.metadata !== undefined ? { metadataJson: serializeJsonValue(input.metadata) } : {}),
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt ? new Date(input.expiresAt) : null } : {}),
      ...(input.lastUsedAt !== undefined ? { lastUsedAt: input.lastUsedAt ? new Date(input.lastUsedAt) : null } : {}),
    },
  });

  return mapAgentMemory(updated);
}

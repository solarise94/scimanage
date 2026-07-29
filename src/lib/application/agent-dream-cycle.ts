/**
 * 梦境记忆 D2 · 夜间整理主循环（dream cycle）。
 *
 * 三个子步骤（全部优雅降级，单用户/单实体失败不阻断整轮）：
 *  ① refreshEntityMemories   实体热记忆刷新（热客户/热项目 → AgentEntityMemory）
 *  ② consolidateMemories     记忆融合+衰减+容量（FadeMem 风格）
 *  ③ compactStaleSessions    陈旧会话整理（转发 agent-runtime /chat-compact，可关）
 *
 * 向量服务（TEI）不就绪时全链路降级：
 *  - 实体：保留旧 embeddingBytes，本次跳过 embed；
 *  - 融合：退化为「归一化文本完全重复」合并；
 *  - 补 embed：跳过。
 *
 * 设计依据见 docs（梦境记忆 D1/D2）。无 LLM 调用：summary 模板化拼接。
 */

import { prisma } from "@/lib/prisma";
import { listDreamCycleEligibleUsers } from "@/lib/application/dream-cycle-users";
import {
  checkVectorServiceReady,
  cosineSimilarity,
  embedTexts,
  encodeEmbedding,
} from "@/lib/agent-runtime/vector";
import { listHotCustomersForActor } from "@/lib/crm/hot-customers";
import { listHotProjectsForActor } from "@/lib/agent-runtime/hot-projects";
import { getAgentRuntimeBaseUrl, getAgentRuntimeToken } from "@/lib/agent-runtime/config";
import { listProjectNotesForActor } from "@/lib/projects/application/project-notes";

// ── 常量 ───────────────────────────────────────────────────────────────────

/** 每用户热客户抓取条数。 */
const HOT_CUSTOMER_LIMIT = 30;
/** 每用户热项目抓取条数。 */
const HOT_PROJECT_LIMIT = 20;
/** embedTexts 单批上限（与 vector.ts MAX_BATCH 一致）。 */
const EMBED_BATCH = 64;
/** summary 上限（中文字符数，宽松估算，超出截断）。 */
const SUMMARY_MAX_CHARS = 120;
/** STALE 阈值：lastActiveAt 超 N 天未活跃 → ARCHIVED。 */
const STALE_ARCHIVE_DAYS = 45;
/** STALE 时 activityScore 折减系数。 */
const STALE_SCORE_FACTOR = 0.5;

/** 记忆衰减半衰期（天）。confidence *= 0.5^(days/HALF_LIFE_DAYS)。 */
const HALF_LIFE_DAYS = 30;
/** confidence 低于此值 → ARCHIVED。 */
const CONFIDENCE_FLOOR = 0.2;
/** 融合余弦相似度阈值（cosine ≥ 此值视为近重复）。 */
const MERGE_COSINE_THRESHOLD = 0.92;
/** 每用户 ACTIVE AgentMemory 容量上限。 */
const MEMORY_CAPACITY = 100;

/** compact 候选：消息数下限。 */
const COMPACT_MIN_MESSAGES = 30;
/** compact 候选：updatedAt 早于 now - 此窗口。 */
const COMPACT_AGE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** 每夜 compact 上限。 */
const COMPACT_MAX_PER_RUN = 20;
/** compact 单会话 fetch 超时。 */
const COMPACT_FETCH_TIMEOUT_MS = 30_000;

const DAY_MS = 24 * 60 * 60 * 1000;

// ── 类型 ───────────────────────────────────────────────────────────────────

export interface DreamCycleStats {
  usersProcessed: number;
  entityUpserted: number;
  entityStale: number;
  entityArchived: number;
  memoryDecayed: number;
  memoryMerged: number;
  memoryArchived: number;
  memoryCapped: number;
  sessionsCompacted: number;
  errors: string[];
}

function emptyStats(): DreamCycleStats {
  return {
    usersProcessed: 0,
    entityUpserted: 0,
    entityStale: 0,
    entityArchived: 0,
    memoryDecayed: 0,
    memoryMerged: 0,
    memoryArchived: 0,
    memoryCapped: 0,
    sessionsCompacted: 0,
    errors: [],
  };
}

// ── 小工具 ─────────────────────────────────────────────────────────────────

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

/**
 * 归一化文本：去空白/标点/大小写，用于「完全重复」降级合并判定。
 * 仅在 TEI 不可用时使用。
 */
function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\s\u3000.,;:!?'"\-_/\\()()\[\]{}，。；：！？、""''（）【】《》…—~`@#$%^&*+=|<>]/g, "");
}

function daysBetween(fromMs: number, toMs: number): number {
  return Math.max(0, (toMs - fromMs) / DAY_MS);
}

// ── ① 实体热记忆刷新 ────────────────────────────────────────────────────────

interface EntityCandidate {
  entityType: "project" | "customer";
  entityId: string;
  name: string;
  summary: string;
  lastActiveAt: Date | null;
  metadataJson: string | null;
}

function summarizeCustomer(c: {
  name: string;
  organization: string | null;
  stage: string;
  importance: string;
  lastFollowUpAt: string | null;
}): string {
  const parts: string[] = [c.name];
  if (c.organization) parts.push(`机构:${c.organization}`);
  parts.push(`阶段:${c.stage}`);
  parts.push(`重要性:${c.importance}`);
  if (c.lastFollowUpAt) {
    const d = new Date(c.lastFollowUpAt);
    parts.push(`最近跟进:${d.toISOString().slice(0, 10)}`);
  }
  return truncate(parts.join("，"), SUMMARY_MAX_CHARS);
}

function summarizeProject(p: {
  name: string;
  projectNo: string | null;
  status: string;
  customerName: string | null;
  organization: string | null;
  lastActivityAt: string | null;
}, recentNotes: Array<{ category: string; content: string }> = []): string {
  const parts: string[] = [p.name];
  if (p.projectNo) parts.push(`编号:${p.projectNo}`);
  parts.push(`状态:${p.status}`);
  if (p.customerName) parts.push(`客户:${p.customerName}`);
  else if (p.organization) parts.push(`机构:${p.organization}`);
  if (p.lastActivityAt) {
    const d = new Date(p.lastActivityAt);
    parts.push(`最近活动:${d.toISOString().slice(0, 10)}`);
  }
  if (recentNotes.length > 0) {
    const digest = recentNotes
      .map((note) => {
        const compactContent = note.content.replace(/\s+/g, " ").trim();
        return `[${note.category}]${truncate(compactContent, 48)}`;
      })
      .join("；");
    parts.push(`备注:${digest}`);
  }
  return truncate(parts.join("，"), SUMMARY_MAX_CHARS);
}

function parseLastActive(iso: string | null): Date | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t) : null;
}

/**
 * 刷新单个用户的实体热记忆。
 * 返回该用户的 upsert / stale / archive 计数（已并入 stats）。
 * 单用户失败：捕获并 push 到 stats.errors，不抛。
 */
async function refreshUserEntityMemories(
  user: { id: string; role: string },
  stats: DreamCycleStats,
): Promise<void> {
  const actor = { userId: user.id, role: user.role };

  // 热客户 Top30 + 热项目 Top20（已 clamp，非销售角色 → []）。
  const [hotCustomers, hotProjects] = await Promise.all([
    listHotCustomersForActor(actor, { limit: HOT_CUSTOMER_LIMIT }),
    listHotProjectsForActor(actor, { limit: HOT_PROJECT_LIMIT }),
  ]);

  // 第一版内部备注只对 ADMIN / USER 可见。每个热项目最多取最近 3 条，
  // 查询数量被 HOT_PROJECT_LIMIT 限制在 20，避免无界扫描或把原文整批注入。
  const recentNotesByProject = new Map<
    string,
    Array<{ category: string; content: string }>
  >();
  if (
    (user.role === "ADMIN" || user.role === "USER")
    && hotProjects.length > 0
  ) {
    const actorForNotes = {
      userId: user.id,
      role: user.role,
      name: null,
      email: null,
    };
    const noteGroups = await Promise.all(
      hotProjects.map(async (project) => {
        try {
          const result = await listProjectNotesForActor(actorForNotes, {
            projectId: project.projectId,
            limit: 3,
          });
          return {
            projectId: project.projectId,
            notes: result.items.map((note) => ({
              category: note.category,
              content: note.content,
            })),
          };
        } catch {
          return { projectId: project.projectId, notes: [] };
        }
      }),
    );
    for (const group of noteGroups) {
      recentNotesByProject.set(group.projectId, group.notes);
    }
  }

  const candidates: EntityCandidate[] = [];
  for (const c of hotCustomers) {
    candidates.push({
      entityType: "customer",
      entityId: c.profileId,
      name: c.name,
      summary: summarizeCustomer(c),
      lastActiveAt: parseLastActive(c.lastFollowUpAt),
      metadataJson: null,
    });
  }
  for (const p of hotProjects) {
    const recentNotes = recentNotesByProject.get(p.projectId) ?? [];
    candidates.push({
      entityType: "project",
      entityId: p.projectId,
      name: p.name,
      summary: summarizeProject(p, recentNotes),
      lastActiveAt: parseLastActive(p.lastActivityAt),
      metadataJson: recentNotes.length > 0
        ? JSON.stringify({ containsInternalProjectNotes: true })
        : null,
    });
  }

  // 排名分：第 i 名 = (N-i)/N，N 为该用户该类型总数。
  const customerN = hotCustomers.length;
  const projectN = hotProjects.length;
  const customerIdx = { i: 0 };
  const projectIdx = { i: 0 };
  const rankScore = (entityType: "project" | "customer"): number => {
    if (entityType === "customer") {
      const N = customerN;
      const i = customerIdx.i++;
      return N > 0 ? (N - i) / N : 0;
    }
    const N = projectN;
    const i = projectIdx.i++;
    return N > 0 ? (N - i) / N : 0;
  };

  // upsert 当前热榜实体。
  const upsertedIds = new Set<string>();
  for (const cand of candidates) {
    const score = rankScore(cand.entityType);
    try {
      await prisma.agentEntityMemory.upsert({
        where: {
          userId_entityType_entityId: {
            userId: user.id,
            entityType: cand.entityType,
            entityId: cand.entityId,
          },
        },
        create: {
          userId: user.id,
          entityType: cand.entityType,
          entityId: cand.entityId,
          name: cand.name,
          summary: cand.summary,
          activityScore: score,
          lastActiveAt: cand.lastActiveAt,
          status: "ACTIVE",
          metadataJson: cand.metadataJson,
        },
        update: {
          name: cand.name,
          summary: cand.summary,
          activityScore: score,
          lastActiveAt: cand.lastActiveAt ?? undefined,
          status: "ACTIVE",
          metadataJson: cand.metadataJson,
        },
      });
      stats.entityUpserted++;
      upsertedIds.add(`${cand.entityType}:${cand.entityId}`);
    } catch (err) {
      stats.errors.push(
        `entity-upsert[${user.id}:${cand.entityType}:${cand.entityId}]: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // 批量 embed 所有 summary（≤64/批）→ encodeEmbedding 存 embeddingBytes。
  // TEI 不就绪 → embedTexts 返回 null，跳过（保留旧值）。
  if (candidates.length > 0) {
    try {
      const summaries = candidates.map((c) => c.summary);
      const vectors = await embedTexts(summaries);
      if (vectors) {
        for (let i = 0; i < candidates.length; i++) {
          const vec = vectors[i];
          const cand = candidates[i];
          if (!Array.isArray(vec) || vec.length === 0) continue;
          try {
            await prisma.agentEntityMemory.update({
              where: {
                userId_entityType_entityId: {
                  userId: user.id,
                  entityType: cand.entityType,
                  entityId: cand.entityId,
                },
              },
              data: { embeddingBytes: encodeEmbedding(vec) },
            });
          } catch (err) {
            stats.errors.push(
              `entity-embed-update[${user.id}:${cand.entityType}:${cand.entityId}]: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
        }
      }
    } catch (err) {
      stats.errors.push(
        `entity-embed-batch[${user.id}]: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // STALE / ARCHIVED 处理：本用户所有 ACTIVE/STALE 实体中不在本次热榜的。
  const existing = await prisma.agentEntityMemory.findMany({
    where: { userId: user.id, status: { in: ["ACTIVE", "STALE"] } },
    select: { id: true, entityType: true, entityId: true, activityScore: true, lastActiveAt: true, status: true },
  });

  const nowMs = Date.now();
  const staleArchiveMs = STALE_ARCHIVE_DAYS * DAY_MS;
  for (const row of existing) {
    const key = `${row.entityType}:${row.entityId}`;
    if (upsertedIds.has(key)) continue; // 本次仍在热榜，已 upsert 为 ACTIVE。
    try {
      if (row.status === "STALE" && row.lastActiveAt) {
        const age = nowMs - row.lastActiveAt.getTime();
        if (age > staleArchiveMs) {
          await prisma.agentEntityMemory.update({
            where: { id: row.id },
            data: { status: "ARCHIVED" },
          });
          stats.entityArchived++;
          continue;
        }
      }
      // ACTIVE → STALE（activityScore 折半）。
      await prisma.agentEntityMemory.update({
        where: { id: row.id },
        data: {
          status: "STALE",
          activityScore: row.activityScore * STALE_SCORE_FACTOR,
        },
      });
      stats.entityStale++;
    } catch (err) {
      stats.errors.push(
        `entity-stale[${user.id}:${row.entityType}:${row.entityId}]: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

async function refreshEntityMemories(
  stats: DreamCycleStats,
  entityUserLimit?: number,
): Promise<void> {
  console.log("[dream] ① refreshEntityMemories start");
  const users = await listDreamCycleEligibleUsers(
    Number.isFinite(entityUserLimit as number)
      ? { limit: entityUserLimit as number }
      : undefined,
  );
  console.log(`[dream] users to process: ${users.length}`);

  for (const user of users) {
    try {
      await refreshUserEntityMemories(user, stats);
      stats.usersProcessed++;
    } catch (err) {
      stats.errors.push(
        `entity-user[${user.id}]: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  console.log(
    `[dream] ① done: users=${stats.usersProcessed} upsert=${stats.entityUpserted} stale=${stats.entityStale} archived=${stats.entityArchived}`,
  );
}

// ── ② 记忆融合+衰减+容量 ────────────────────────────────────────────────────

type MemoryRow = {
  id: string;
  content: string;
  confidence: number;
  status: string;
  lastUsedAt: Date | null;
  updatedAt: Date;
  expiresAt: Date | null;
  embeddingBytes: Buffer | null;
};

async function consolidateUserMemories(
  userId: string,
  stats: DreamCycleStats,
): Promise<void> {
  const rows = await prisma.agentMemory.findMany({
    where: { userId, status: "ACTIVE" },
    select: {
      id: true,
      content: true,
      confidence: true,
      status: true,
      lastUsedAt: true,
      updatedAt: true,
      expiresAt: true,
      embeddingBytes: true,
    },
  });
  if (rows.length === 0) return;

  const nowMs = Date.now();
  const archived = new Set<string>();

  // ── 衰减 + expiresAt 过期 ────────────────────────────────────────────────
  for (const r of rows) {
    if (archived.has(r.id)) continue;
    // expiresAt 已过 → ARCHIVED。
    if (r.expiresAt && r.expiresAt.getTime() <= nowMs) {
      try {
        await prisma.agentMemory.update({
          where: { id: r.id },
          data: { status: "ARCHIVED" },
        });
        archived.add(r.id);
        stats.memoryArchived++;
      } catch (err) {
        stats.errors.push(
          `mem-expire[${userId}:${r.id}]: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      continue;
    }
    // confidence 衰减：days = 距 COALESCE(lastUsedAt, updatedAt)。
    const anchorMs = (r.lastUsedAt ?? r.updatedAt).getTime();
    const days = daysBetween(anchorMs, nowMs);
    if (days > 0) {
      const decayed = r.confidence * Math.pow(0.5, days / HALF_LIFE_DAYS);
      // 仅在变化显著时落库（避免无意义写）。
      if (Math.abs(decayed - r.confidence) > 1e-6) {
        try {
          await prisma.agentMemory.update({
            where: { id: r.id },
            data: { confidence: decayed },
          });
          r.confidence = decayed;
          stats.memoryDecayed++;
        } catch (err) {
          stats.errors.push(
            `mem-decay[${userId}:${r.id}]: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    }
  }

  // ── 融合 ────────────────────────────────────────────────────────────────
  // 先按 (confidence desc, lastUsedAt desc, updatedAt desc) 排序，保留高/新那条。
  const active = rows
    .filter((r) => !archived.has(r.id))
    .sort((a, b) => {
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      const la = a.lastUsedAt?.getTime() ?? a.updatedAt.getTime();
      const lb = b.lastUsedAt?.getTime() ?? b.updatedAt.getTime();
      if (lb !== la) return lb - la;
      return b.updatedAt.getTime() - a.updatedAt.getTime();
    });

  // 计算向量：TEI 就绪 → 批量 embed；否则 null（退化为文本相等）。
  let vectors: number[][] | null = null;
  let vectorReady = false;
  try {
    vectorReady = await checkVectorServiceReady();
  } catch {
    vectorReady = false;
  }
  if (vectorReady && active.length > 0) {
    try {
      vectors = await embedTexts(active.map((r) => r.content));
    } catch {
      vectors = null;
    }
  }

  const mergedAway = new Set<string>();
  for (let i = 0; i < active.length; i++) {
    const keeper = active[i];
    if (mergedAway.has(keeper.id)) continue;
    for (let j = i + 1; j < active.length; j++) {
      const other = active[j];
      if (mergedAway.has(other.id)) continue;
      let shouldMerge = false;
      if (vectors && vectors[i] && vectors[j]) {
        const sim = cosineSimilarity(vectors[i], vectors[j]);
        shouldMerge = sim >= MERGE_COSINE_THRESHOLD;
      } else {
        // 降级：归一化文本完全相等。
        shouldMerge =
          normalizeText(keeper.content) === normalizeText(other.content) &&
          keeper.content.length > 0;
      }
      if (shouldMerge) {
        try {
          // content 取更长者（keeper 排序靠前，但 other 可能更长）。
          const chosenContent =
            other.content.length > keeper.content.length
              ? other.content
              : keeper.content;
          await prisma.agentMemory.update({
            where: { id: keeper.id },
            data: { content: chosenContent },
          });
          keeper.content = chosenContent;
          await prisma.agentMemory.update({
            where: { id: other.id },
            data: { status: "ARCHIVED" },
          });
          mergedAway.add(other.id);
          archived.add(other.id);
          stats.memoryMerged++;
        } catch (err) {
          stats.errors.push(
            `mem-merge[${userId}:${keeper.id}+${other.id}]: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    }
  }

  // ── confidence < FLOOR → ARCHIVED ───────────────────────────────────────
  for (const r of active) {
    if (archived.has(r.id)) continue;
    if (r.confidence < CONFIDENCE_FLOOR) {
      try {
        await prisma.agentMemory.update({
          where: { id: r.id },
          data: { status: "ARCHIVED" },
        });
        archived.add(r.id);
        stats.memoryArchived++;
      } catch (err) {
        stats.errors.push(
          `mem-floor[${userId}:${r.id}]: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  // ── 容量：每用户 ACTIVE ≤ MEMORY_CAPACITY，超出按 (confidence, lastUsedAt) 最旧最弱归档 ──
  const survivors = active
    .filter((r) => !archived.has(r.id))
    .sort((a, b) => {
      // 最旧最弱排后（先归档）：confidence 升序、lastUsedAt 升序。
      if (a.confidence !== b.confidence) return a.confidence - b.confidence;
      const la = a.lastUsedAt?.getTime() ?? a.updatedAt.getTime();
      const lb = b.lastUsedAt?.getTime() ?? b.updatedAt.getTime();
      return la - lb;
    });
  if (survivors.length > MEMORY_CAPACITY) {
    const overflow = survivors.slice(0, survivors.length - MEMORY_CAPACITY);
    for (const r of overflow) {
      try {
        await prisma.agentMemory.update({
          where: { id: r.id },
          data: { status: "ARCHIVED" },
        });
        archived.add(r.id);
        stats.memoryCapped++;
      } catch (err) {
        stats.errors.push(
          `mem-cap[${userId}:${r.id}]: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  // ── 顺带：ACTIVE 且 embeddingBytes 为空 → 批量补 embed ─────────────────
  const needEmbed = active.filter((r) => !archived.has(r.id) && !r.embeddingBytes);
  if (needEmbed.length > 0 && vectorReady) {
    try {
      const vecs = await embedTexts(needEmbed.map((r) => r.content));
      if (vecs) {
        for (let i = 0; i < needEmbed.length; i++) {
          const v = vecs[i];
          if (!Array.isArray(v) || v.length === 0) continue;
          try {
            await prisma.agentMemory.update({
              where: { id: needEmbed[i].id },
              data: { embeddingBytes: encodeEmbedding(v) },
            });
          } catch (err) {
            stats.errors.push(
              `mem-embed[${userId}:${needEmbed[i].id}]: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
        }
      }
    } catch (err) {
      stats.errors.push(
        `mem-embed-batch[${userId}]: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

async function consolidateMemories(stats: DreamCycleStats): Promise<void> {
  console.log("[dream] ② consolidateMemories start");
  const users = await listDreamCycleEligibleUsers();
  console.log(`[dream] memory users: ${users.length}`);
  for (const user of users) {
    try {
      await consolidateUserMemories(user.id, stats);
    } catch (err) {
      stats.errors.push(
        `mem-user[${user.id}]: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  console.log(
    `[dream] ② done: decayed=${stats.memoryDecayed} merged=${stats.memoryMerged} archived=${stats.memoryArchived} capped=${stats.memoryCapped}`,
  );
}

// ── ③ 陈旧会话整理 ──────────────────────────────────────────────────────────

/**
 * 转发 agent-runtime /chat-compact，仿 chat-compact route。
 * 直接从 DB 读 session + messages（系统级 cron，不走 actor 鉴权）。
 * 失败记数跳过，不抛。
 */
async function compactOneSession(
  session: { id: string; userId: string; agentRunId: string | null; compactSummary: string | null },
  stats: DreamCycleStats,
): Promise<void> {
  const detail = await prisma.agentChatSession.findUnique({
    where: { id: session.id },
    select: {
      id: true,
      messages: {
        orderBy: { createdAt: "asc" },
        select: { role: true, content: true, createdAt: true },
      },
      compactSummary: true,
    },
  });
  if (!detail) return;

  const baseUrl = getAgentRuntimeBaseUrl();
  const token = getAgentRuntimeToken();
  const res = await fetch(`${baseUrl}/chat-compact`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-agent-runtime-token": token,
    },
    body: JSON.stringify({
      sessionId: detail.id,
      history: detail.messages.map((m) => ({
        role: m.role,
        content: m.content,
        createdAt: m.createdAt,
      })),
      compactSummary: detail.compactSummary,
    }),
    signal: AbortSignal.timeout(COMPACT_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`runtime /chat-compact ${res.status}: ${txt.slice(0, 200)}`);
  }
  const payload = (await res.json()) as { summary?: string };
  const summary = payload.summary?.trim() || "";
  await prisma.agentChatSession.update({
    where: { id: session.id },
    data: { compactSummary: summary || null },
  });
  stats.sessionsCompacted++;
}

async function compactStaleSessions(stats: DreamCycleStats): Promise<void> {
  console.log("[dream] ③ compactStaleSessions start");
  const cutoff = new Date(Date.now() - COMPACT_AGE_WINDOW_MS);

  // 候选：消息数>30 且 compactSummary 为 null 且 updatedAt < 24h 前。
  // 用 _count 过滤消息数（Prisma 支持）。
  const candidates = await prisma.agentChatSession.findMany({
    where: {
      updatedAt: { lt: cutoff },
      compactSummary: null,
      messages: { some: {} },
    },
    select: {
      id: true,
      userId: true,
      agentRunId: true,
      compactSummary: true,
      _count: { select: { messages: true } },
    },
    orderBy: { updatedAt: "asc" },
    take: COMPACT_MAX_PER_RUN * 3, // 多取一些，过滤消息数后可能不够。
  });

  const eligible = candidates
    .filter((c) => c._count?.messages && c._count.messages > COMPACT_MIN_MESSAGES)
    .slice(0, COMPACT_MAX_PER_RUN);

  console.log(`[dream] compact candidates: ${eligible.length} (cap ${COMPACT_MAX_PER_RUN})`);

  for (const sess of eligible) {
    try {
      await compactOneSession(
        {
          id: sess.id,
          userId: sess.userId,
          agentRunId: sess.agentRunId,
          compactSummary: sess.compactSummary,
        },
        stats,
      );
    } catch (err) {
      stats.errors.push(
        `compact[${sess.id}]: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  console.log(`[dream] ③ done: compacted=${stats.sessionsCompacted}`);
}

// ── 主入口 ──────────────────────────────────────────────────────────────────

/**
 * 夜间梦境整理主循环。
 *
 * @param opts.compactSessions  默认 true；false 时跳过会话压缩。
 * @param opts.entityUserLimit  限制实体刷新处理的用户数（调试/烟测用）。
 */
export async function runAgentDreamCycle(opts: {
  compactSessions?: boolean;
  entityUserLimit?: number;
} = {}): Promise<DreamCycleStats> {
  const stats = emptyStats();
  const compact = opts.compactSessions !== false;
  console.log(`[dream] === runAgentDreamCycle start (compact=${compact}) ===`);

  try {
    await refreshEntityMemories(stats, opts.entityUserLimit);
  } catch (err) {
    stats.errors.push(
      `refreshEntityMemories: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    console.error("[dream] refreshEntityMemories crashed:", err);
  }

  try {
    await consolidateMemories(stats);
  } catch (err) {
    stats.errors.push(
      `consolidateMemories: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    console.error("[dream] consolidateMemories crashed:", err);
  }

  if (compact) {
    try {
      await compactStaleSessions(stats);
    } catch (err) {
      stats.errors.push(
        `compactStaleSessions: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      console.error("[dream] compactStaleSessions crashed:", err);
    }
  }

  console.log(
    `[dream] === done: users=${stats.usersProcessed} entUp=${stats.entityUpserted} entStale=${stats.entityStale} entArch=${stats.entityArchived} decay=${stats.memoryDecayed} merge=${stats.memoryMerged} arch=${stats.memoryArchived} cap=${stats.memoryCapped} compact=${stats.sessionsCompacted} errs=${stats.errors.length} ===`,
  );
  if (stats.errors.length > 0) {
    // 只打印前 10 条，避免日志爆炸。
    for (const e of stats.errors.slice(0, 10)) console.warn(`[dream] err: ${e}`);
  }
  return stats;
}

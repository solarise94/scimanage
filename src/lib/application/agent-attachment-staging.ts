/**
 * Agent 通用附件 staging 生命周期（docs §4 / §5 / §6.2）。
 *
 * - 私有、按用户隔离；上传不写任何业务数据。
 * - 解析 lease 10 分钟，带 leaseOwner fencing；fresh lease 不抢占，stale 可回收。
 * - 默认 24h TTL；存在活动 proposal/route 时同事务延至最长 createdAt+7d。
 * - chat-stream 条件绑定 session/run：只把 null 写为当前值，绝不覆盖不同值。
 */

import { randomUUID } from "crypto";
import { prisma } from "@/lib/prisma";
import {
  computeExpiresAt,
  computeSha256,
  capExpiresAt,
  isLeaseStale,
  STAGING_ANALYZING_LEASE_MS,
  STAGING_MAX_TTL_MS,
  STAGING_TTL_MS,
  StagingError,
} from "@/lib/staging-common";
import {
  ATTACHMENT_ALLOWED_EXT,
  ATTACHMENT_ANALYSIS_JSON_MAX_BYTES,
  ATTACHMENT_MAX_ANALYSIS_ATTEMPTS,
  ATTACHMENT_MAX_FILES_PER_MESSAGE,
} from "@/lib/agent-attachments/constants";
import {
  deleteStagingBufferQuietly,
  readStagingBuffer,
  stagingStorageKey,
  writeStagingBuffer,
} from "@/lib/agent-attachments/storage";
import { validateAgentAttachmentPayload } from "@/lib/agent-attachments/validation";

export type AgentAttachmentStatus =
  | "UPLOADED"
  | "ANALYZING"
  | "ANALYZED"
  | "FAILED"
  | "EXPIRED";

// ─── 创建 ───────────────────────────────────────────────────

export interface CreateAgentAttachmentInput {
  ownerUserId: string;
  agentRunId?: string | null;
  chatSessionId?: string | null;
  originalFileName: string;
  declaredMime: string;
  buffer: Buffer;
}

export async function createAgentAttachmentStaging(input: CreateAgentAttachmentInput) {
  const validated = validateAgentAttachmentPayload({
    originalFileName: input.originalFileName,
    declaredMime: input.declaredMime,
    buffer: input.buffer,
  });

  const storageKey = stagingStorageKey(input.ownerUserId, validated.ext, ATTACHMENT_ALLOWED_EXT);
  await writeStagingBuffer(storageKey, input.buffer);

  try {
    return await prisma.agentAttachmentStagingFile.create({
      data: {
        ownerUserId: input.ownerUserId,
        agentRunId: input.agentRunId ?? null,
        chatSessionId: input.chatSessionId ?? null,
        storageKey,
        originalName: validated.displayName,
        mimeType: validated.mimeType,
        sizeBytes: validated.sizeBytes,
        sha256: validated.sha256,
        status: "UPLOADED",
        version: 1,
        analysisAttempts: 0,
        expiresAt: computeExpiresAt(STAGING_TTL_MS),
      },
    });
  } catch (err) {
    await deleteStagingBufferQuietly(storageKey);
    throw err;
  }
}

// ─── 读取 / 所有权 ──────────────────────────────────────────

export async function getOwnedAgentAttachment(opts: {
  stagingId: string;
  userId: string;
  requireActive?: boolean;
}) {
  const row = await prisma.agentAttachmentStagingFile.findUnique({
    where: { id: opts.stagingId },
  });
  if (!row || row.ownerUserId !== opts.userId) {
    throw new StagingError("ATTACHMENT_NOT_FOUND", "附件不存在或不可见", 404);
  }
  if (opts.requireActive !== false) {
    if (row.status === "EXPIRED" || row.expiresAt.getTime() <= Date.now()) {
      throw new StagingError("ATTACHMENT_EXPIRED", "附件已过期", 410);
    }
    if (row.status === "FAILED") {
      throw new StagingError("ATTACHMENT_CHANGED", "附件解析失败，不可用", 409);
    }
  }
  return row;
}

/**
 * 只读当前 status/version（不做所有权校验）。
 *
 * 用于解析写回失败后如实重读 staging 状态（ANALYZED/ANALYZING/FAILED），
 * 让 adapter 无需直连 Prisma。调用方已在前序步骤完成 owner/run 校验。
 */
export async function getAttachmentStatusVersion(
  stagingId: string,
): Promise<{ status: string; version: number } | null> {
  return prisma.agentAttachmentStagingFile.findUnique({
    where: { id: stagingId },
    select: { status: true, version: true },
  });
}

/**
 * P1#2 层 A：强校验 staging 的 agentRunId 为 null 或匹配当前 run（null-or-match）。
 * 防止用户在另一 session/run 内用已知 staging ID 调 inspect/adopt/get_detail（docs §6.3：
 * inspect/adopt 校验 owner + run）。
 *
 * 加固（fail-closed）：若 staging 已绑定到某 run（agentRunId 非空）但当前 actor 无 run 上下文
 * （expectedRunId 为空，如直连 API 无 run），必须拒绝——否则可绕过隔离。
 * 仅当 staging 未绑定（null）且 actor 也无 run 时才放行（合法的未绑定附件）。
 */
export function assertAttachmentInCurrentRun(
  staging: { agentRunId: string | null },
  expectedRunId: string | null | undefined,
): void {
  if (!expectedRunId) {
    // actor 无 run 上下文：staging 必须也未绑定，否则 fail-closed。
    if (staging.agentRunId) {
      throw new StagingError(
        "ATTACHMENT_BOUND_TO_ANOTHER_RUN",
        "附件已绑定到 agent run，当前请求无 run 上下文，不可使用",
        409,
      );
    }
    return;
  }
  if (staging.agentRunId && staging.agentRunId !== expectedRunId) {
    throw new StagingError(
      "ATTACHMENT_BOUND_TO_ANOTHER_RUN",
      "附件已绑定到其他 agent run，不可在当前会话使用",
      409,
    );
  }
}

/**
 * P1#2 层 B：add_note 额外校验 chatSessionId（null-or-match）。docs §6.3.3 要求 add_note
 * 校验 owner + run + session；inspect/adopt 不校验 session。
 *
 * 加固（fail-closed）：若 staging 已绑定到某 session 但当前 actor 无 session 上下文，必须拒绝。
 */
export function assertAttachmentInCurrentSession(
  staging: { chatSessionId: string | null },
  expectedSessionId: string | null | undefined,
): void {
  if (!expectedSessionId) {
    if (staging.chatSessionId) {
      throw new StagingError(
        "ATTACHMENT_BOUND_TO_ANOTHER_SESSION",
        "附件已绑定到会话，当前请求无 session 上下文，不可使用",
        409,
      );
    }
    return;
  }
  if (staging.chatSessionId && staging.chatSessionId !== expectedSessionId) {
    throw new StagingError(
      "ATTACHMENT_BOUND_TO_ANOTHER_SESSION",
      "附件已绑定到其他会话，不可用于当前备注",
      409,
    );
  }
}

/** 读取并复核 buffer 的 SHA-256 与版本/哈希期望。 */
export async function verifyAttachmentIntegrity(opts: {
  staging: { storageKey: string; sha256: string; version: number };
  expectedSha256?: string;
  expectedVersion?: number;
}): Promise<Buffer> {
  if (opts.expectedVersion != null && opts.staging.version !== opts.expectedVersion) {
    throw new StagingError("ATTACHMENT_CHANGED", "附件版本已变化", 409);
  }
  if (opts.expectedSha256 && opts.staging.sha256 !== opts.expectedSha256) {
    throw new StagingError("ATTACHMENT_CHANGED", "附件哈希与期望不一致", 409);
  }
  const buffer = await readStagingBuffer(opts.staging.storageKey);
  if (computeSha256(buffer) !== opts.staging.sha256) {
    throw new StagingError("ATTACHMENT_FILE_INVALID", "附件文件哈希校验失败", 400);
  }
  return buffer;
}

// ─── 解析 lease（10 分钟，fencing）─────────────────────────

export interface ClaimAttachmentLeaseResult {
  claimed: boolean;
  reason?: "FRESH_LEASE" | "VERSION_CONFLICT" | "NOT_FOUND" | "ATTEMPTS_EXCEEDED";
}

/**
 * 原子 claim：UPLOADED|ANALYZED → ANALYZING（写 leaseOwner/leaseStartedAt）。
 * 若已处于 ANALYZING：仅当 lease 过期才可接管（fresh lease 不抢占）。
 * analysisAttempts 达到上限时拒绝自动 retry。
 */
export async function claimAttachmentForAnalysis(opts: {
  stagingId: string;
  userId: string;
  leaseOwner: string;
  expectedSha256: string;
  expectedVersion: number;
  now?: Date;
}): Promise<ClaimAttachmentLeaseResult> {
  const now = opts.now ?? new Date();

  const current = await prisma.agentAttachmentStagingFile.findFirst({
    where: { id: opts.stagingId, ownerUserId: opts.userId, sha256: opts.expectedSha256 },
    select: { status: true, version: true, analysisAttempts: true, leaseStartedAt: true, expiresAt: true },
  });
  if (!current) return { claimed: false, reason: "NOT_FOUND" };
  if (current.version !== opts.expectedVersion) return { claimed: false, reason: "VERSION_CONFLICT" };
  if (current.expiresAt.getTime() <= now.getTime()) return { claimed: false, reason: "NOT_FOUND" };
  if (current.analysisAttempts >= ATTACHMENT_MAX_ANALYSIS_ATTEMPTS) {
    return { claimed: false, reason: "ATTEMPTS_EXCEEDED" };
  }

  if (current.status === "UPLOADED" || current.status === "ANALYZED" || current.status === "FAILED") {
    const claim = await prisma.agentAttachmentStagingFile.updateMany({
      where: {
        id: opts.stagingId,
        ownerUserId: opts.userId,
        sha256: opts.expectedSha256,
        version: opts.expectedVersion,
        status: current.status,
        expiresAt: { gt: now },
      },
      data: {
        status: "ANALYZING",
        leaseOwner: opts.leaseOwner,
        leaseStartedAt: now,
        analysisAttempts: { increment: 1 },
      },
    });
    return claim.count === 1
      ? { claimed: true }
      : { claimed: false, reason: "VERSION_CONFLICT" };
  }

  if (current.status === "ANALYZING") {
    // fresh lease 不抢占；仅接管过期 lease。
    if (!isLeaseStale(current.leaseStartedAt, STAGING_ANALYZING_LEASE_MS, now)) {
      return { claimed: false, reason: "FRESH_LEASE" };
    }
    const takeover = await prisma.agentAttachmentStagingFile.updateMany({
      where: {
        id: opts.stagingId,
        ownerUserId: opts.userId,
        sha256: opts.expectedSha256,
        status: "ANALYZING",
        OR: [
          { leaseStartedAt: null },
          { leaseStartedAt: { lte: new Date(now.getTime() - STAGING_ANALYZING_LEASE_MS) } },
        ],
      },
      data: {
        leaseOwner: opts.leaseOwner,
        leaseStartedAt: now,
        analysisAttempts: { increment: 1 },
      },
    });
    return takeover.count === 1
      ? { claimed: true }
      : { claimed: false, reason: "FRESH_LEASE" };
  }

  return { claimed: false, reason: "NOT_FOUND" };
}

/** heartbeat：仅 leaseOwner 匹配时刷新 leaseStartedAt。旧 worker 失去 token 后 beat 失败。 */
export async function heartbeatAttachmentLease(opts: {
  stagingId: string;
  userId: string;
  leaseOwner: string;
  expectedSha256: string;
  now?: Date;
}): Promise<{ ok: boolean }> {
  const result = await prisma.agentAttachmentStagingFile.updateMany({
    where: {
      id: opts.stagingId,
      ownerUserId: opts.userId,
      sha256: opts.expectedSha256,
      status: "ANALYZING",
      leaseOwner: opts.leaseOwner,
    },
    data: { leaseStartedAt: opts.now ?? new Date() },
  });
  return { ok: result.count === 1 };
}

function assertAnalysisJsonSize(analysisJson: string): void {
  if (Buffer.byteLength(analysisJson, "utf8") > ATTACHMENT_ANALYSIS_JSON_MAX_BYTES) {
    throw new StagingError("ATTACHMENT_ANALYSIS_TOO_LARGE", "解析结果超过 32 KiB 上限", 400);
  }
}

/** 解析成功写回：ANALYZING → ANALYZED，version++；要求 leaseOwner 匹配（fencing）。 */
export async function completeAttachmentAnalysis(opts: {
  stagingId: string;
  userId: string;
  leaseOwner: string;
  expectedSha256: string;
  analysisJson: string;
  warningsJson: string;
}): Promise<{ id: string; version: number; status: string }> {
  assertAnalysisJsonSize(opts.analysisJson);
  const updated = await prisma.agentAttachmentStagingFile.updateMany({
    where: {
      id: opts.stagingId,
      ownerUserId: opts.userId,
      sha256: opts.expectedSha256,
      status: "ANALYZING",
      leaseOwner: opts.leaseOwner,
    },
    data: {
      status: "ANALYZED",
      analysisJson: opts.analysisJson,
      warningsJson: opts.warningsJson,
      version: { increment: 1 },
    },
  });
  if (updated.count !== 1) {
    throw new StagingError("ATTACHMENT_CHANGED", "附件分析写回失败（lease 已被接管或状态变化）", 409);
  }
  const row = await prisma.agentAttachmentStagingFile.findUniqueOrThrow({
    where: { id: opts.stagingId },
    select: { id: true, version: true, status: true },
  });
  return row;
}

/** 解析失败：ANALYZING → FAILED（要求 leaseOwner 匹配）；记录安全错误摘要。 */
export async function failAttachmentAnalysis(opts: {
  stagingId: string;
  userId: string;
  leaseOwner: string;
  expectedSha256: string;
  errorSummary: string;
}): Promise<void> {
  const current = await prisma.agentAttachmentStagingFile.findFirst({
    where: {
      id: opts.stagingId,
      ownerUserId: opts.userId,
      sha256: opts.expectedSha256,
      status: "ANALYZING",
      leaseOwner: opts.leaseOwner,
    },
    select: { id: true, warningsJson: true },
  });
  if (!current) return;

  let warnings: string[] = [];
  try {
    const parsed = current.warningsJson ? JSON.parse(current.warningsJson) : [];
    if (Array.isArray(parsed)) warnings = parsed.filter((x): x is string => typeof x === "string");
  } catch {
    warnings = [];
  }
  warnings.push(opts.errorSummary.slice(0, 200));

  await prisma.agentAttachmentStagingFile.updateMany({
    where: {
      id: opts.stagingId,
      ownerUserId: opts.userId,
      sha256: opts.expectedSha256,
      status: "ANALYZING",
      leaseOwner: opts.leaseOwner,
    },
    data: {
      status: "FAILED",
      warningsJson: JSON.stringify(warnings.slice(-10)),
    },
  });
}

// ─── TTL 延期（活动 proposal/route）────────────────────────

/** 结构化的最小事务客户端：prisma 单例与 $transaction 的 tx 都满足。 */
type AttachmentTxClient = {
  agentAttachmentStagingFile: typeof prisma.agentAttachmentStagingFile;
};

/**
 * 在创建引用该附件的 PENDING/PROCESSING proposal/route 的同一事务内调用：
 * 把 expiresAt 延至 min(createdAt+7d, max(现有 expiresAt, now+24h))。
 * 不由 sweep 隐式延期；proposal 终态不主动缩短。
 */
export async function extendAttachmentTtlForActiveRoute(opts: {
  tx?: AttachmentTxClient;
  stagingId: string;
  now?: Date;
}): Promise<void> {
  const now = opts.now ?? new Date();
  const client: AttachmentTxClient = opts.tx ?? prisma;
  const row = await client.agentAttachmentStagingFile.findUnique({
    where: { id: opts.stagingId },
    select: { createdAt: true, expiresAt: true },
  });
  if (!row) return;
  const desired = new Date(Math.max(row.expiresAt.getTime(), now.getTime() + STAGING_TTL_MS));
  const capped = capExpiresAt(row.createdAt, desired, STAGING_MAX_TTL_MS);
  if (capped.getTime() > row.expiresAt.getTime()) {
    await client.agentAttachmentStagingFile.update({
      where: { id: opts.stagingId },
      data: { expiresAt: capped },
    });
  }
}

// ─── chat-stream 条件绑定 session/run（§6.2.2）─────────────

/**
 * 只把 null 绑定为当前 session/run，或接受已匹配当前值；绝不覆盖不同值。
 *
 * P1#3: 全量原子绑定。先在同一事务内 findMany 全量读取并校验（owner/active/expiry/
 * session-run null-or-match），任一不满足即整体抛 StagingMENT_BOUND_TO_ANOTHER_SESSION（409，零副作用）；
 * 全部满足后再批量写绑定。调用方应把本函数与消息/link 创建放在**同一 $transaction** 内，
 * 这样消息创建失败也会回滚已写的绑定，不留"已绑定无消息"孤儿。
 */
export async function bindAttachmentsToSessionAndRun(
  opts: {
    stagingIds: string[];
    userId: string;
    chatSessionId: string;
    agentRunId: string;
    now?: Date;
  },
  tx?: AttachmentTxClient,
): Promise<{ bound: number }> {
  const now = opts.now ?? new Date();
  const client: AttachmentTxClient = tx ?? prisma;
  const uniqueIds = [...new Set(opts.stagingIds)].slice(0, ATTACHMENT_MAX_FILES_PER_MESSAGE);

  if (uniqueIds.length === 0) return { bound: 0 };

  // 1. 全量读取并校验（校验失败即整体拒绝，零副作用）。
  const rows = await client.agentAttachmentStagingFile.findMany({
    where: { id: { in: uniqueIds }, ownerUserId: opts.userId },
    select: {
      id: true,
      status: true,
      expiresAt: true,
      chatSessionId: true,
      agentRunId: true,
    },
  });

  for (const id of uniqueIds) {
    const row = rows.find((r) => r.id === id);
    if (!row) {
      throw new StagingError("ATTACHMENT_BOUND_TO_ANOTHER_SESSION", "附件不可见或不存在", 409);
    }
    if (row.status === "EXPIRED" || row.status === "FAILED" || row.expiresAt.getTime() <= now.getTime()) {
      throw new StagingError("ATTACHMENT_BOUND_TO_ANOTHER_SESSION", "附件已过期或不可用", 409);
    }
    if (row.status !== "UPLOADED" && row.status !== "ANALYZING" && row.status !== "ANALYZED") {
      throw new StagingError("ATTACHMENT_BOUND_TO_ANOTHER_SESSION", `附件状态不可绑定（${row.status}）`, 409);
    }
    if (row.chatSessionId && row.chatSessionId !== opts.chatSessionId) {
      throw new StagingError("ATTACHMENT_BOUND_TO_ANOTHER_SESSION", "附件已绑定到其他会话", 409);
    }
    if (row.agentRunId && row.agentRunId !== opts.agentRunId) {
      throw new StagingError("ATTACHMENT_BOUND_TO_ANOTHER_SESSION", "附件已绑定到其他运行", 409);
    }
  }

  // 2. 全部校验通过，批量写绑定（null → current；已匹配的保持不变）。
  let bound = 0;
  for (const id of uniqueIds) {
    // 用 updateMany 带条件确保只写 null 或已匹配的行（双保险，防并发竞争）。
    const result = await client.agentAttachmentStagingFile.updateMany({
      where: {
        id,
        ownerUserId: opts.userId,
        AND: [
          { OR: [{ chatSessionId: null }, { chatSessionId: opts.chatSessionId }] },
          { OR: [{ agentRunId: null }, { agentRunId: opts.agentRunId }] },
        ],
      },
      data: {
        chatSessionId: opts.chatSessionId,
        agentRunId: opts.agentRunId,
      },
    });
    if (result.count !== 1) {
      // 校验通过但写入 0 行：说明在 findMany 与 update 之间被并发改了。
      throw new StagingError("ATTACHMENT_BOUND_TO_ANOTHER_SESSION", "附件在绑定期间被并发修改", 409);
    }
    bound += 1;
  }
  return { bound };
}

// ─── verified context（注入 runtime 前的服务端校验）────────

export type VerifiedAgentAttachmentContext = {
  stagingFileId: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  sha256: string;
  version: number;
  expiresAt: string;
};

export async function validateVerifiedAgentAttachmentContext(opts: {
  userId: string;
  stagingFileId: string;
  expectedSha256?: string;
  expectedVersion?: number;
  chatSessionId?: string | null;
  agentRunId?: string | null;
}): Promise<VerifiedAgentAttachmentContext | null> {
  try {
    const staging = await getOwnedAgentAttachment({
      stagingId: opts.stagingFileId,
      userId: opts.userId,
      requireActive: true,
    });
    if (staging.status === "ANALYZING") return null; // 解析中不可注入
    if (opts.chatSessionId && staging.chatSessionId && staging.chatSessionId !== opts.chatSessionId) {
      return null;
    }
    if (opts.agentRunId && staging.agentRunId && staging.agentRunId !== opts.agentRunId) {
      return null;
    }
    await verifyAttachmentIntegrity({
      staging,
      expectedSha256: opts.expectedSha256,
      expectedVersion: opts.expectedVersion,
    });
    return {
      stagingFileId: staging.id,
      fileName: staging.originalName,
      mimeType: staging.mimeType,
      fileSize: staging.sizeBytes,
      sha256: staging.sha256,
      version: staging.version,
      expiresAt: staging.expiresAt.toISOString(),
    };
  } catch (error) {
    if (error instanceof StagingError) return null;
    console.error("[agent-attachments] validateVerifiedAgentAttachmentContext infra error:", error);
    throw error;
  }
}

export async function validateVerifiedAgentAttachmentContextList(opts: {
  userId: string;
  items: Array<{ stagingFileId?: unknown; sha256?: unknown; version?: unknown }>;
  chatSessionId?: string | null;
  agentRunId?: string | null;
}): Promise<VerifiedAgentAttachmentContext[]> {
  const rawItems = opts.items.slice(0, ATTACHMENT_MAX_FILES_PER_MESSAGE);
  const seen = new Set<string>();
  const verified: VerifiedAgentAttachmentContext[] = [];
  for (const item of rawItems) {
    const stagingFileId = typeof item.stagingFileId === "string" ? item.stagingFileId.trim() : "";
    if (!stagingFileId || seen.has(stagingFileId)) continue;
    seen.add(stagingFileId);
    const sha256 = typeof item.sha256 === "string" ? item.sha256.trim() : undefined;
    const version = typeof item.version === "number" ? item.version : undefined;
    const validated = await validateVerifiedAgentAttachmentContext({
      userId: opts.userId,
      stagingFileId,
      expectedSha256: sha256,
      expectedVersion: version,
      chatSessionId: opts.chatSessionId,
      agentRunId: opts.agentRunId,
    });
    if (validated) verified.push(validated);
  }
  return verified;
}

// ─── 列表 / 元数据 ──────────────────────────────────────────

export function toPublicAttachmentMeta(row: {
  id: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  status: string;
  version: number;
  expiresAt: Date;
}) {
  return {
    id: row.id,
    fileName: row.originalName,
    mimeType: row.mimeType,
    fileSize: row.sizeBytes,
    sha256: row.sha256,
    status: row.status,
    version: row.version,
    expiresAt: row.expiresAt.toISOString(),
  };
}

export async function listOwnedAgentAttachments(opts: {
  userId: string;
  agentRunId?: string | null;
  chatSessionId?: string | null;
  limit?: number;
}) {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 50);
  return prisma.agentAttachmentStagingFile.findMany({
    where: {
      ownerUserId: opts.userId,
      status: { in: ["UPLOADED", "ANALYZING", "ANALYZED", "FAILED"] },
      expiresAt: { gt: new Date() },
      ...(opts.agentRunId ? { agentRunId: opts.agentRunId } : {}),
      ...(opts.chatSessionId ? { chatSessionId: opts.chatSessionId } : {}),
    },
    orderBy: { createdAt: "asc" },
    take: limit,
    select: {
      id: true,
      originalName: true,
      mimeType: true,
      sizeBytes: true,
      sha256: true,
      status: true,
      version: true,
      expiresAt: true,
      agentRunId: true,
      chatSessionId: true,
      createdAt: true,
      // 永不在此选择 analysisJson 全文给列表 API（inspect 专用路径才返回受限摘要）。
      warningsJson: true,
    },
  });
}

// ─── 删除 ───────────────────────────────────────────────────

/** 删除未被 PROCESSING/PROMOTED route 占用的 staging。 */
export async function deleteOwnedAgentAttachment(opts: {
  stagingId: string;
  userId: string;
}): Promise<{ deleted: boolean; reason?: "BUSY" }> {
  const row = await prisma.agentAttachmentStagingFile.findUnique({
    where: { id: opts.stagingId },
    select: { id: true, ownerUserId: true, storageKey: true },
  });
  if (!row || row.ownerUserId !== opts.userId) {
    throw new StagingError("ATTACHMENT_NOT_FOUND", "附件不存在或不可见", 404);
  }
  const busy = await prisma.agentAttachmentRoute.findFirst({
    where: { stagingId: opts.stagingId, state: { in: ["PROCESSING", "PROMOTED", "PENDING"] } },
    select: { id: true },
  });
  if (busy) return { deleted: false, reason: "BUSY" };

  await prisma.agentAttachmentStagingFile.delete({ where: { id: opts.stagingId } });
  await deleteStagingBufferQuietly(row.storageKey);
  return { deleted: true };
}

// ─── lease 回收 / TTL sweep ────────────────────────────────

/** 将卡住的 ANALYZING（lease 过期）恢复为 UPLOADED；超过 createdAt+7d 标 EXPIRED。 */
export async function recoverStaleAnalyzingAttachments(limit = 20): Promise<number> {
  const now = new Date();
  const leaseCutoff = new Date(now.getTime() - STAGING_ANALYZING_LEASE_MS);
  const rows = await prisma.agentAttachmentStagingFile.findMany({
    where: { status: "ANALYZING", leaseStartedAt: { lte: leaseCutoff } },
    orderBy: { updatedAt: "asc" },
    take: limit,
    select: { id: true, createdAt: true },
  });
  let recovered = 0;
  for (const row of rows) {
    const absoluteMax = new Date(row.createdAt.getTime() + STAGING_MAX_TTL_MS);
    if (absoluteMax.getTime() <= now.getTime()) {
      await prisma.agentAttachmentStagingFile.updateMany({
        where: { id: row.id, status: "ANALYZING" },
        data: { status: "EXPIRED" },
      });
    } else {
      await prisma.agentAttachmentStagingFile.updateMany({
        where: { id: row.id, status: "ANALYZING" },
        data: { status: "UPLOADED", leaseOwner: null, leaseStartedAt: null },
      });
    }
    recovered += 1;
  }
  return recovered;
}

/** 清理 expiresAt 到期且无活跃 PROCESSING route 的 staging。 */
export async function sweepExpiredAgentAttachments(limit = 20): Promise<number> {
  const now = new Date();
  await recoverStaleAnalyzingAttachments(limit).catch(() => 0);

  const candidates = await prisma.agentAttachmentStagingFile.findMany({
    where: {
      status: { in: ["UPLOADED", "ANALYZING", "ANALYZED", "FAILED", "EXPIRED"] },
      expiresAt: { lte: now },
    },
    orderBy: { expiresAt: "asc" },
    take: limit,
    select: { id: true, storageKey: true },
  });

  let cleaned = 0;
  for (const row of candidates) {
    const activeRoute = await prisma.agentAttachmentRoute.findFirst({
      where: { stagingId: row.id, state: { in: ["PROCESSING"] } },
      select: { id: true },
    });
    if (activeRoute) continue; // 有活跃提升任务，暂不清理
    await deleteStagingBufferQuietly(row.storageKey);
    await prisma.agentAttachmentStagingFile.updateMany({
      where: { id: row.id },
      data: { status: "EXPIRED" },
    });
    cleaned += 1;
  }
  return cleaned;
}

export function newLeaseOwner(): string {
  return randomUUID();
}

/**
 * Agent 订单/银行流水导入的单文件私有 staging。
 *
 * 见 docs/agent-sequential-order-import-upgrade-design-2026-07-21.md §4.1。
 * 复用 src/lib/staging-common.ts 的公共安全原语；与发票 staging 保持独立模型，
 * 避免形成"万能上传表"。
 *
 * - 文件永不进入 public/
 * - storageKey 为相对私有根的服务端键，不暴露给客户端
 * - 接受 CSV/TSV/TXT/XLSX；XLSX 走 ZIP 容器安全校验
 */

import path from "path";
import { prisma } from "@/lib/prisma";
import {
  StagingError,
  STAGING_TTL_MS,
  STAGING_MAX_TTL_MS,
  STAGING_ANALYZING_LEASE_MS,
  assertFileSignature,
  assertSafeZipContainer,
  computeExpiresAt,
  computeSha256,
  deleteFileUnderRootQuietly,
  ensureDir,
  isExpired,
  isLeaseStale,
  readFileUnderRoot,
  safeStorageFileName,
  writeFileUnderRoot,
} from "@/lib/staging-common";

export { StagingError };

// ─── 合法值常量（§4.1，禁止散落字符串）────────────────────────

export const IMPORT_KIND = {
  ORDER: "ORDER",
  BANK_FLOW: "BANK_FLOW",
} as const;
export type ImportKind = (typeof IMPORT_KIND)[keyof typeof IMPORT_KIND];

export const IMPORT_PARSER_KEY = {
  ORDER_GENERIC: "ORDER_GENERIC",
  PINGOODMICE: "PINGOODMICE",
  BANK_FLOW: "BANK_FLOW",
} as const;
export type ImportParserKey = (typeof IMPORT_PARSER_KEY)[keyof typeof IMPORT_PARSER_KEY];

export type ImportStagingStatus =
  | "UPLOADED"
  | "ANALYZING"
  | "ANALYZED"
  | "FAILED"
  | "EXPIRED";

// ─── 限额与白名单 ────────────────────────────────────────────

export const IMPORT_STAGING_MAX_BYTES = 10 * 1024 * 1024; // 单文件 10MB
export const IMPORT_STAGING_MAX_ROWS = 500; // 单会话 500 行硬上限（v1）
export const IMPORT_STAGING_MAX_COLS = 100;

const IMPORT_STAGING_MIME = new Set([
  "text/csv",
  "text/tab-separated-values",
  "text/plain",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/zip",
]);

/** BANK_FLOW 额外允许的回单图片/PDF（OCR 管道）。 */
const BANK_FLOW_IMAGE_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
]);

const IMPORT_STAGING_EXTENSIONS = new Set([
  ".csv",
  ".tsv",
  ".txt",
  ".xlsx",
]);

const BANK_FLOW_IMAGE_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".pdf",
]);

const TEXT_EXTENSIONS = new Set([".csv", ".tsv", ".txt"]);

const EXT_TO_MIME = new Map<string, string>([
  [".csv", "text/csv"],
  [".tsv", "text/tab-separated-values"],
  [".txt", "text/plain"],
  [".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
  [".pdf", "application/pdf"],
]);

export function isBankFlowImageMime(mime: string): boolean {
  return BANK_FLOW_IMAGE_MIME.has(mime);
}

// ─── 根目录 ──────────────────────────────────────────────────

export function getImportStagingRoot(): string {
  const configured = (process.env.IMPORT_STAGING_DIR || "").trim();
  if (configured) return path.resolve(configured);
  return path.resolve(process.cwd(), ".import-staging");
}

// ─── 上传 ────────────────────────────────────────────────────

export type CreateImportStagingInput = {
  ownerUserId: string;
  agentRunId?: string | null;
  originalName: string;
  declaredMime: string;
  buffer: Buffer;
  importKind: ImportKind;
  ttlMs?: number;
};

/**
 * 校验并落盘一个导入 staging 文件。
 * 同一用户、同一类型、同一 hash 若已有未过期 staging，直接复用（不重复解析）。
 */
export async function createImportStagingFile(input: CreateImportStagingInput) {
  const allowImages = input.importKind === IMPORT_KIND.BANK_FLOW;
  const allowedMime = allowImages
    ? new Set([...IMPORT_STAGING_MIME, ...BANK_FLOW_IMAGE_MIME])
    : IMPORT_STAGING_MIME;
  const allowedExt = allowImages
    ? new Set([...IMPORT_STAGING_EXTENSIONS, ...BANK_FLOW_IMAGE_EXTENSIONS])
    : IMPORT_STAGING_EXTENSIONS;

  const validated = assertFileSignature({
    originalFileName: input.originalName,
    declaredMime: input.declaredMime,
    buffer: input.buffer,
    allowedMime,
    allowedExt,
    extToMime: EXT_TO_MIME,
    maxBytes: IMPORT_STAGING_MAX_BYTES,
    textExtensions: TEXT_EXTENSIONS,
  });

  // XLSX 需进一步校验 ZIP 容器，防 zip bomb。
  const ext = path.extname(input.originalName).toLowerCase();
  if (ext === ".xlsx") {
    assertSafeZipContainer(input.buffer);
  }

  // 复用同用户/同类型/同 hash 的未过期 staging。
  const existing = await prisma.agentImportStagingFile.findFirst({
    where: {
      ownerUserId: input.ownerUserId,
      importKind: input.importKind,
      sha256: validated.sha256,
      status: { in: ["UPLOADED", "ANALYZING", "ANALYZED"] },
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: "desc" },
  });
  if (existing) return existing;

  const root = await ensureDir(getImportStagingRoot());
  const storageKey = path.posix.join(
    input.ownerUserId,
    safeStorageFileName(input.originalName, allowedExt),
  );
  await writeFileUnderRoot(root, storageKey, input.buffer);

  const expiresAt = computeExpiresAt(input.ttlMs ?? STAGING_TTL_MS);

  try {
    return await prisma.agentImportStagingFile.create({
      data: {
        ownerUserId: input.ownerUserId,
        agentRunId: input.agentRunId ?? null,
        storageKey,
        originalName: validated.displayName,
        mimeType: validated.mimeType,
        sizeBytes: input.buffer.length,
        sha256: validated.sha256,
        importKind: input.importKind,
        status: "UPLOADED",
        version: 1,
        expiresAt,
      },
    });
  } catch (err) {
    await deleteFileUnderRootQuietly(root, storageKey);
    throw err;
  }
}

/** 以 UTF-8 文本保存粘贴内容，走相同 hash/TTL/权限规则。 */
export async function createImportStagingFromText(input: {
  ownerUserId: string;
  agentRunId?: string | null;
  text: string;
  importKind: ImportKind;
  displayName?: string;
}) {
  const buffer = Buffer.from(input.text, "utf8");
  return createImportStagingFile({
    ownerUserId: input.ownerUserId,
    agentRunId: input.agentRunId ?? null,
    originalName: input.displayName ?? "pasted-orders.txt",
    declaredMime: "text/plain",
    buffer,
    importKind: input.importKind,
  });
}

// ─── 读取 / 权限 ─────────────────────────────────────────────

export async function getOwnedImportStaging(opts: {
  stagingFileId: string;
  userId: string;
  requireActive?: boolean;
}) {
  const row = await prisma.agentImportStagingFile.findUnique({
    where: { id: opts.stagingFileId },
  });
  if (!row || row.ownerUserId !== opts.userId) {
    throw new StagingError("STAGING_NOT_FOUND", "staging 不存在或不可见", 404);
  }
  if (opts.requireActive !== false) {
    if (row.status === "EXPIRED" || isExpired(row.expiresAt)) {
      throw new StagingError("STAGING_EXPIRED", "staging 已过期", 410);
    }
  }
  return row;
}

export async function readImportStagingBuffer(staging: {
  storageKey: string;
  sha256: string;
}): Promise<Buffer> {
  const buffer = await readFileUnderRoot(getImportStagingRoot(), staging.storageKey);
  const actual = computeSha256(buffer);
  if (actual !== staging.sha256) {
    throw new StagingError("STAGING_FILE_INVALID", "staging 文件哈希校验失败", 400);
  }
  return buffer;
}

// ─── 分析 claim / 写回 ───────────────────────────────────────

/** 生成 ANALYZING lease fencing token。 */
export function newImportStagingLeaseOwner(): string {
  return `stg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}

/** 原子 claim：UPLOADED → ANALYZING。 */
export async function claimImportStagingForAnalysis(opts: {
  stagingFileId: string;
  userId: string;
  expectedSha256: string;
  expectedVersion: number;
  /** 可选 fencing token；OCR 等长任务必须传入并在 heartbeat/写回时校验。 */
  leaseOwner?: string | null;
}): Promise<{ claimed: boolean }> {
  const result = await prisma.agentImportStagingFile.updateMany({
    where: {
      id: opts.stagingFileId,
      ownerUserId: opts.userId,
      sha256: opts.expectedSha256,
      version: opts.expectedVersion,
      status: "UPLOADED",
      expiresAt: { gt: new Date() },
    },
    data: {
      status: "ANALYZING",
      leaseStartedAt: new Date(),
      leaseOwner: opts.leaseOwner ?? null,
    },
  });
  return { claimed: result.count === 1 };
}

/**
 * 整批原子 claim：任一失败则把已 claim 的恢复为 UPLOADED。
 * 用于 OCR 等多文件一次性锁定，避免并发重试重复计费。
 */
export async function claimImportStagingBatchForAnalysis(opts: {
  userId: string;
  items: Array<{
    stagingFileId: string;
    expectedSha256: string;
    expectedVersion: number;
  }>;
  leaseOwner?: string | null;
}): Promise<{ claimed: boolean; claimedIds: string[] }> {
  const claimedIds: string[] = [];
  for (const item of opts.items) {
    const result = await claimImportStagingForAnalysis({
      stagingFileId: item.stagingFileId,
      userId: opts.userId,
      expectedSha256: item.expectedSha256,
      expectedVersion: item.expectedVersion,
      leaseOwner: opts.leaseOwner,
    });
    if (!result.claimed) {
      for (const id of claimedIds) {
        const prev = opts.items.find((i) => i.stagingFileId === id);
        if (!prev) continue;
        await failImportStagingAnalysis({
          stagingFileId: id,
          userId: opts.userId,
          expectedSha256: prev.expectedSha256,
          recoverable: true,
        }).catch(() => undefined);
      }
      return { claimed: false, claimedIds: [] };
    }
    claimedIds.push(item.stagingFileId);
  }
  return { claimed: true, claimedIds };
}

/**
 * 刷新 ANALYZING lease；必须匹配 leaseOwner（fencing）。
 * 旧 worker 在租约被接管/回收后 heartbeat 失败，应立即停止 OCR 与写回。
 */
export async function heartbeatImportStagingLease(opts: {
  stagingFileId: string;
  userId: string;
  expectedSha256: string;
  leaseOwner: string;
}): Promise<{ ok: boolean }> {
  const result = await prisma.agentImportStagingFile.updateMany({
    where: {
      id: opts.stagingFileId,
      ownerUserId: opts.userId,
      sha256: opts.expectedSha256,
      status: "ANALYZING",
      leaseOwner: opts.leaseOwner,
    },
    data: { leaseStartedAt: new Date() },
  });
  return { ok: result.count === 1 };
}

export async function heartbeatImportStagingBatchLease(opts: {
  userId: string;
  leaseOwner: string;
  items: Array<{ stagingFileId: string; expectedSha256: string }>;
}): Promise<{ ok: boolean }> {
  for (const item of opts.items) {
    const result = await heartbeatImportStagingLease({
      stagingFileId: item.stagingFileId,
      userId: opts.userId,
      expectedSha256: item.expectedSha256,
      leaseOwner: opts.leaseOwner,
    });
    if (!result.ok) return { ok: false };
  }
  return { ok: true };
}

/**
 * 同用户崩溃恢复：仅当 session 已绑定且 lease 已过期时接管 leaseOwner。
 * fresh lease 返回 ok:false，调用方应报 STAGING_IN_PROGRESS。
 */
export async function takeoverImportStagingAnalyzingLease(opts: {
  userId: string;
  sessionId: string;
  leaseOwner: string;
  items: Array<{ stagingFileId: string; expectedSha256: string }>;
  now?: Date;
}): Promise<{ ok: boolean }> {
  if (opts.items.length === 0) return { ok: true };
  const now = opts.now ?? new Date();
  const staleBefore = new Date(now.getTime() - STAGING_ANALYZING_LEASE_MS);
  for (const item of opts.items) {
    const result = await prisma.agentImportStagingFile.updateMany({
      where: {
        id: item.stagingFileId,
        ownerUserId: opts.userId,
        sha256: item.expectedSha256,
        status: "ANALYZING",
        sessionId: opts.sessionId,
        expiresAt: { gt: now },
        OR: [{ leaseStartedAt: null }, { leaseStartedAt: { lte: staleBefore } }],
      },
      data: {
        leaseOwner: opts.leaseOwner,
        leaseStartedAt: now,
      },
    });
    if (result.count !== 1) return { ok: false };
  }
  return { ok: true };
}

/**
 * 仅当 ANALYZING lease 已过期（或 leaseStartedAt 为空）时接管。
 * 不会抢占仍在 heartbeat 窗口内的健康 worker——避免同批重试重复 OCR 计费。
 */
export async function acquireImportStagingAnalyzingLeaseIfStale(opts: {
  userId: string;
  leaseOwner: string;
  items: Array<{ stagingFileId: string; expectedSha256: string }>;
  now?: Date;
}): Promise<{ ok: boolean }> {
  if (opts.items.length === 0) return { ok: true };
  const now = opts.now ?? new Date();
  const staleBefore = new Date(now.getTime() - STAGING_ANALYZING_LEASE_MS);
  for (const item of opts.items) {
    const result = await prisma.agentImportStagingFile.updateMany({
      where: {
        id: item.stagingFileId,
        ownerUserId: opts.userId,
        sha256: item.expectedSha256,
        status: "ANALYZING",
        expiresAt: { gt: now },
        OR: [{ leaseStartedAt: null }, { leaseStartedAt: { lte: staleBefore } }],
      },
      data: {
        leaseOwner: opts.leaseOwner,
        leaseStartedAt: now,
      },
    });
    if (result.count !== 1) return { ok: false };
  }
  return { ok: true };
}

/** 分析成功：ANALYZING → ANALYZED，绑定 sessionId/parserKey，version += 1。 */
export async function completeImportStagingAnalysis(opts: {
  stagingFileId: string;
  userId: string;
  expectedSha256: string;
  sessionId: string;
  parserKey: ImportParserKey;
  /** 若传入则必须匹配，拒绝旧 worker 写回。 */
  leaseOwner?: string;
}): Promise<{ id: string; version: number }> {
  const updated = await prisma.agentImportStagingFile.updateMany({
    where: {
      id: opts.stagingFileId,
      ownerUserId: opts.userId,
      sha256: opts.expectedSha256,
      status: "ANALYZING",
      ...(opts.leaseOwner ? { leaseOwner: opts.leaseOwner } : {}),
    },
    data: {
      status: "ANALYZED",
      sessionId: opts.sessionId,
      parserKey: opts.parserKey,
      leaseStartedAt: null,
      leaseOwner: null,
      version: { increment: 1 },
    },
  });
  if (updated.count !== 1) {
    throw new StagingError("STAGING_VERSION_CONFLICT", "staging 分析写回失败", 409);
  }
  const row = await prisma.agentImportStagingFile.findUniqueOrThrow({
    where: { id: opts.stagingFileId },
    select: { id: true, version: true },
  });
  return row;
}

/**
 * 整批原子完成：全部 ANALYZING → ANALYZED 并绑定同一 sessionId。
 * 任一失败则整批回滚，避免半完成态。
 */
export async function completeImportStagingBatchAnalysis(opts: {
  userId: string;
  sessionId: string;
  parserKey: ImportParserKey;
  items: Array<{ stagingFileId: string; expectedSha256: string }>;
  /** 若传入则必须匹配，拒绝旧 worker 写回。 */
  leaseOwner?: string;
}): Promise<void> {
  if (opts.items.length === 0) return;
  await prisma.$transaction(async (tx) => {
    for (const item of opts.items) {
      const updated = await tx.agentImportStagingFile.updateMany({
        where: {
          id: item.stagingFileId,
          ownerUserId: opts.userId,
          sha256: item.expectedSha256,
          status: "ANALYZING",
          ...(opts.leaseOwner ? { leaseOwner: opts.leaseOwner } : {}),
        },
        data: {
          status: "ANALYZED",
          sessionId: opts.sessionId,
          parserKey: opts.parserKey,
          leaseStartedAt: null,
          leaseOwner: null,
          version: { increment: 1 },
        },
      });
      if (updated.count !== 1) {
        throw new StagingError(
          "STAGING_VERSION_CONFLICT",
          `staging 批量写回失败: ${item.stagingFileId}`,
          409,
        );
      }
    }
  });
}

/**
 * 将批次内尚未 ANALYZED（或 session 不一致）的文件绑定到已有 workspace。
 * 接受 ANALYZING / UPLOADED，用于 OCR 半完成崩溃恢复（workspace 已存在、OCR 结果在 manifest）。
 */
export async function bindImportStagingBatchToSession(opts: {
  userId: string;
  sessionId: string;
  parserKey: ImportParserKey;
  items: Array<{ stagingFileId: string; expectedSha256: string }>;
}): Promise<number> {
  if (opts.items.length === 0) return 0;
  let bound = 0;
  await prisma.$transaction(async (tx) => {
    for (const item of opts.items) {
      const updated = await tx.agentImportStagingFile.updateMany({
        where: {
          id: item.stagingFileId,
          ownerUserId: opts.userId,
          sha256: item.expectedSha256,
          status: { in: ["ANALYZING", "UPLOADED"] },
          expiresAt: { gt: new Date() },
        },
        data: {
          status: "ANALYZED",
          sessionId: opts.sessionId,
          parserKey: opts.parserKey,
          leaseStartedAt: null,
          leaseOwner: null,
          version: { increment: 1 },
        },
      });
      if (updated.count !== 1) {
        // 已是正确 session 的 ANALYZED：跳过；其他状态视为冲突
        const row = await tx.agentImportStagingFile.findFirst({
          where: {
            id: item.stagingFileId,
            ownerUserId: opts.userId,
          },
          select: { status: true, sessionId: true },
        });
        if (row?.status === "ANALYZED" && row.sessionId === opts.sessionId) {
          continue;
        }
        throw new StagingError(
          "STAGING_VERSION_CONFLICT",
          `staging 无法绑定到 workspace: ${item.stagingFileId}`,
          409,
        );
      }
      bound += 1;
    }
  });
  return bound;
}

/**
 * 在 ANALYZING 态提前写入 sessionId（不推进 ANALYZED）。
 * 用于外部 OCR 调用前持久化批次→workspace 关联，崩溃后可按 sessionId 恢复。
 */
export async function attachImportStagingSessionWhileAnalyzing(opts: {
  userId: string;
  sessionId: string;
  items: Array<{ stagingFileId: string; expectedSha256: string }>;
  /** 可选：同时写入/校验 leaseOwner，防止旧 worker 抢写 sessionId。 */
  leaseOwner?: string;
}): Promise<void> {
  if (opts.items.length === 0) return;
  await prisma.$transaction(async (tx) => {
    for (const item of opts.items) {
      const updated = await tx.agentImportStagingFile.updateMany({
        where: {
          id: item.stagingFileId,
          ownerUserId: opts.userId,
          sha256: item.expectedSha256,
          status: "ANALYZING",
          ...(opts.leaseOwner ? { leaseOwner: opts.leaseOwner } : {}),
        },
        data: {
          sessionId: opts.sessionId,
          ...(opts.leaseOwner
            ? { leaseOwner: opts.leaseOwner, leaseStartedAt: new Date() }
            : {}),
        },
      });
      if (updated.count !== 1) {
        throw new StagingError(
          "STAGING_VERSION_CONFLICT",
          `staging 无法预绑定 workspace: ${item.stagingFileId}`,
          409,
        );
      }
    }
  });
}

/** 分析失败：ANALYZING → FAILED（或恢复 UPLOADED 供重试）。保留 sessionId 供崩溃恢复。 */
export async function failImportStagingAnalysis(opts: {
  stagingFileId: string;
  userId: string;
  expectedSha256: string;
  recoverable?: boolean;
  /** 若传入则必须匹配，避免旧 worker 误把新 worker 的 ANALYZING 回退。 */
  leaseOwner?: string;
}): Promise<void> {
  await prisma.agentImportStagingFile.updateMany({
    where: {
      id: opts.stagingFileId,
      ownerUserId: opts.userId,
      sha256: opts.expectedSha256,
      status: "ANALYZING",
      ...(opts.leaseOwner ? { leaseOwner: opts.leaseOwner } : {}),
    },
    data: {
      status: opts.recoverable ? "UPLOADED" : "FAILED",
      leaseStartedAt: null,
      leaseOwner: null,
    },
  });
}

/** 将卡住（lease 超时）的 ANALYZING 恢复为 UPLOADED，不超过绝对 7 天 TTL。 */
export async function recoverStaleImportStaging(limit = 20): Promise<number> {
  const now = new Date();
  const rows = await prisma.agentImportStagingFile.findMany({
    where: { status: "ANALYZING" },
    take: limit,
    select: { id: true, leaseStartedAt: true, createdAt: true },
  });
  let recovered = 0;
  for (const row of rows) {
    if (!isLeaseStale(row.leaseStartedAt, STAGING_ANALYZING_LEASE_MS, now)) continue;
    const absoluteMax = new Date(row.createdAt.getTime() + STAGING_MAX_TTL_MS);
    const target = absoluteMax.getTime() <= now.getTime() ? "EXPIRED" : "UPLOADED";
    const result = await prisma.agentImportStagingFile.updateMany({
      where: { id: row.id, status: "ANALYZING" },
      data: { status: target, leaseStartedAt: null, leaseOwner: null },
    });
    if (result.count === 1) recovered += 1;
  }
  return recovered;
}

// ─── AgentRun 绑定 ───────────────────────────────────────────

export async function assertAndBindImportStagingToAgentRun(opts: {
  stagingFileIds: string[];
  userId: string;
  agentRunId: string;
}): Promise<void> {
  const uniqueIds = [...new Set(opts.stagingFileIds)];
  if (uniqueIds.length === 0) return;
  const rows = await prisma.agentImportStagingFile.findMany({
    where: { id: { in: uniqueIds }, ownerUserId: opts.userId },
    select: { id: true, agentRunId: true, status: true },
  });
  if (rows.length !== uniqueIds.length) {
    throw new StagingError("STAGING_VERSION_CONFLICT", "部分 staging 不可见或不存在", 409);
  }
  for (const row of rows) {
    if (row.agentRunId && row.agentRunId !== opts.agentRunId) {
      throw new StagingError("STAGING_VERSION_CONFLICT", "staging 已绑定其他 Agent 会话", 409);
    }
    if (!["UPLOADED", "ANALYZING", "ANALYZED"].includes(row.status)) {
      throw new StagingError("STAGING_VERSION_CONFLICT", `staging 状态不可绑定: ${row.status}`, 409);
    }
  }
  const bound = await prisma.agentImportStagingFile.updateMany({
    where: {
      id: { in: uniqueIds },
      ownerUserId: opts.userId,
      status: { in: ["UPLOADED", "ANALYZING", "ANALYZED"] },
      OR: [{ agentRunId: null }, { agentRunId: opts.agentRunId }],
    },
    data: { agentRunId: opts.agentRunId },
  });
  if (bound.count !== uniqueIds.length) {
    throw new StagingError("STAGING_VERSION_CONFLICT", "staging 与 AgentRun 绑定失败", 409);
  }
}

// ─── 清理 ────────────────────────────────────────────────────

export async function sweepExpiredImportStaging(limit = 20): Promise<number> {
  const now = new Date();
  await recoverStaleImportStaging(limit).catch(() => 0);
  const root = getImportStagingRoot();
  const candidates = await prisma.agentImportStagingFile.findMany({
    where: {
      status: { in: ["UPLOADED", "ANALYZING", "ANALYZED", "FAILED", "EXPIRED"] },
      expiresAt: { lte: now },
    },
    orderBy: { expiresAt: "asc" },
    take: limit,
    select: { id: true, storageKey: true, createdAt: true },
  });
  let cleaned = 0;
  for (const row of candidates) {
    // 绝对上限 = createdAt + 7d（与 recoverStaleImportStaging 口径一致）。
    // 注意不能用 capExpiresAt(createdAt, now, MAX)：它返回 min(now, 上限)，
    // 永远 ≤ now，延长分支永远不会进入（死代码），文件总是 24h 就被删。
    const absoluteMax = new Date(row.createdAt.getTime() + STAGING_MAX_TTL_MS);
    if (absoluteMax.getTime() > now.getTime()) {
      // 仍在绝对窗口内：延长至绝对上限，给长会话/活动 proposal 留时间。
      await prisma.agentImportStagingFile.update({
        where: { id: row.id },
        data: { expiresAt: absoluteMax },
      });
      continue;
    }
    await deleteFileUnderRootQuietly(root, row.storageKey);
    await prisma.agentImportStagingFile.update({
      where: { id: row.id },
      data: { status: "EXPIRED" },
    });
    cleaned += 1;
  }
  return cleaned;
}

// ─── 列表 / 公开元数据 ───────────────────────────────────────

/** 列出当前用户可见（owner=userId）的未过期 staging；不返回 storageKey。 */
export async function listOwnedImportStaging(opts: {
  userId: string;
  agentRunId?: string | null;
  status?: ImportStagingStatus | ImportStagingStatus[];
  limit?: number;
}) {
  const statuses = opts.status
    ? Array.isArray(opts.status) ? opts.status : [opts.status]
    : (["UPLOADED", "ANALYZING", "ANALYZED"] as ImportStagingStatus[]);
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 50);

  return prisma.agentImportStagingFile.findMany({
    where: {
      ownerUserId: opts.userId,
      status: { in: statuses },
      expiresAt: { gt: new Date() },
      ...(opts.agentRunId ? { agentRunId: opts.agentRunId } : {}),
    },
    orderBy: { createdAt: "asc" },
    take: limit,
    select: {
      id: true,
      originalName: true,
      mimeType: true,
      sizeBytes: true,
      sha256: true,
      importKind: true,
      parserKey: true,
      status: true,
      sessionId: true,
      version: true,
      expiresAt: true,
      agentRunId: true,
      createdAt: true,
      updatedAt: true,
      // Never select storageKey.
    },
  });
}

/** 把 staging 行投影成可返回客户端/模型的公开元数据（不含 storageKey）。 */
export function toPublicImportStagingMeta(row: {
  id: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  importKind: string;
  parserKey: string | null;
  status: string;
  sessionId: string | null;
  version: number;
  expiresAt: Date;
}) {
  return {
    id: row.id,
    fileName: row.originalName,
    mimeType: row.mimeType,
    fileSize: row.sizeBytes,
    sha256: row.sha256,
    importKind: row.importKind,
    parserKey: row.parserKey,
    status: row.status,
    sessionId: row.sessionId,
    version: row.version,
    expiresAt: row.expiresAt.toISOString(),
  };
}

/** 标记 staging 为 EXPIRED 并删除私有文件（owner 校验由调用方完成）。 */
export async function deleteImportStagingFile(opts: {
  stagingFileId: string;
  userId: string;
}): Promise<void> {
  const row = await prisma.agentImportStagingFile.findUnique({
    where: { id: opts.stagingFileId },
    select: { ownerUserId: true, storageKey: true, status: true },
  });
  if (!row || row.ownerUserId !== opts.userId) {
    throw new StagingError("STAGING_NOT_FOUND", "staging 不存在或不可见", 404);
  }
  const root = getImportStagingRoot();
  await deleteFileUnderRootQuietly(root, row.storageKey);
  await prisma.agentImportStagingFile.update({
    where: { id: opts.stagingFileId },
    data: { status: "EXPIRED" },
  });
}

// ─── 可信上下文 ──────────────────────────────────────────────

export type VerifiedImportStagingContext = {
  stagingFileId: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  sha256: string;
  version: number;
  importKind: ImportKind;
  expiresAt: string;
};

/** 服务端重校验客户端传入的 staging 上下文，返回可信三元组或 null。 */
export async function validateVerifiedImportStagingContext(opts: {
  userId: string;
  stagingFileId: string;
  expectedSha256?: string;
  expectedVersion?: number;
  importKind?: ImportKind;
  agentRunId?: string | null;
}): Promise<VerifiedImportStagingContext | null> {
  try {
    const staging = await getOwnedImportStaging({
      stagingFileId: opts.stagingFileId,
      userId: opts.userId,
      requireActive: true,
    });
    if (staging.status === "ANALYZING") return null;
    if (opts.importKind && staging.importKind !== opts.importKind) return null;
    if (opts.agentRunId && staging.agentRunId && staging.agentRunId !== opts.agentRunId) return null;
    if (opts.expectedSha256 && staging.sha256 !== opts.expectedSha256) return null;
    if (opts.expectedVersion != null && staging.version !== opts.expectedVersion) return null;
    return {
      stagingFileId: staging.id,
      fileName: staging.originalName,
      mimeType: staging.mimeType,
      fileSize: staging.sizeBytes,
      sha256: staging.sha256,
      version: staging.version,
      importKind: staging.importKind as ImportKind,
      expiresAt: staging.expiresAt.toISOString(),
    };
  } catch {
    return null;
  }
}

/**
 * Agent 发票单文件私有 staging。
 *
 * - 文件永不进入 public/
 * - storageKey 为相对 staging 根的服务端键，不暴露给客户端
 * - 路径解析统一做根目录逃逸校验
 */

import { createHash, randomUUID } from "crypto";
import fs from "fs/promises";
import path from "path";
import { prisma } from "@/lib/prisma";

export const INVOICE_STAGING_MAX_BYTES = 20 * 1024 * 1024; // 20 MB
export const INVOICE_STAGING_TTL_MS = 24 * 60 * 60 * 1000; // 24h
export const INVOICE_STAGING_MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7d when PENDING proposal

export const AGENT_INVOICE_STAGING_MIME = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
]);

export const AGENT_INVOICE_STAGING_EXTENSIONS = new Set([
  ".pdf",
  ".jpg",
  ".jpeg",
  ".png",
]);

/** Page route keeps broader historical MIME set. */
export const PAGE_INVOICE_UPLOAD_MIME = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/tiff",
]);

export const PAGE_INVOICE_UPLOAD_EXTENSIONS = new Set([
  ".pdf",
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".tiff",
  ".tif",
]);

export type InvoiceStagingStatus =
  | "UPLOADED"
  | "ANALYZING"
  | "ANALYZED"
  | "REGISTERED"
  | "SKIPPED"
  | "EXPIRED";

/** ANALYZING lease：超过该时间可安全恢复为 UPLOADED。 */
export const INVOICE_STAGING_ANALYZING_LEASE_MS = 10 * 60 * 1000;

export const INVOICE_STAGING_MAX_FILES_PER_MESSAGE = 10;

export class InvoiceStagingError extends Error {
  code: string;
  httpStatus: number;

  constructor(code: string, message: string, httpStatus: number) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
    this.name = "InvoiceStagingError";
  }
}

export function getInvoiceStagingRoot(): string {
  const configured = (process.env.INVOICE_STAGING_DIR || "").trim();
  if (configured) {
    return path.resolve(configured);
  }
  return path.resolve(process.cwd(), ".invoice-staging");
}

export function sanitizeDisplayFileName(name: string, maxLen = 180): string {
  const cleaned = name
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[/\\]/g, "_")
    .trim();
  const base = cleaned || "invoice";
  return base.length > maxLen ? base.slice(0, maxLen) : base;
}

export function safeStorageFileName(originalName: string): string {
  const ext = path.extname(originalName).toLowerCase();
  const safeExt = AGENT_INVOICE_STAGING_EXTENSIONS.has(ext) || PAGE_INVOICE_UPLOAD_EXTENSIONS.has(ext)
    ? ext
    : "";
  return `${randomUUID()}${safeExt}`;
}

export function computeSha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

export function detectMimeFromMagic(buffer: Buffer): string | null {
  if (buffer.length >= 5
    && buffer[0] === 0x25
    && buffer[1] === 0x50
    && buffer[2] === 0x44
    && buffer[3] === 0x46) {
    return "application/pdf"; // %PDF
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    buffer.length >= 8
    && buffer[0] === 0x89
    && buffer[1] === 0x50
    && buffer[2] === 0x4e
    && buffer[3] === 0x47
    && buffer[4] === 0x0d
    && buffer[5] === 0x0a
    && buffer[6] === 0x1a
    && buffer[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    buffer.length >= 12
    && buffer.toString("ascii", 0, 4) === "RIFF"
    && buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  if (
    buffer.length >= 4
    && (
      (buffer[0] === 0x49 && buffer[1] === 0x49 && buffer[2] === 0x2a && buffer[3] === 0x00)
      || (buffer[0] === 0x4d && buffer[1] === 0x4d && buffer[2] === 0x00 && buffer[3] === 0x2a)
    )
  ) {
    return "image/tiff";
  }
  return null;
}

function normalizeDeclaredMime(mime: string, ext: string): string {
  const trimmed = (mime || "").trim().toLowerCase();
  if (trimmed === "image/jpg") return "image/jpeg";
  if (!trimmed) {
    if (ext === ".pdf") return "application/pdf";
    if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
    if (ext === ".png") return "image/png";
    if (ext === ".webp") return "image/webp";
    if (ext === ".tif" || ext === ".tiff") return "image/tiff";
  }
  return trimmed;
}

export function assertInvoiceFilePayload(opts: {
  originalFileName: string;
  declaredMime: string;
  buffer: Buffer;
  allowedMime: Set<string>;
  allowedExt: Set<string>;
}): { mimeType: string; ext: string; sha256: string; displayName: string } {
  const displayName = sanitizeDisplayFileName(opts.originalFileName);
  const ext = path.extname(opts.originalFileName).toLowerCase();

  if (opts.buffer.length === 0) {
    throw new InvoiceStagingError("INVOICE_FILE_INVALID", "文件为空", 400);
  }
  if (opts.buffer.length > INVOICE_STAGING_MAX_BYTES) {
    throw new InvoiceStagingError("INVOICE_FILE_INVALID", "文件大小不能超过 20 MB", 400);
  }
  if (!opts.allowedExt.has(ext)) {
    throw new InvoiceStagingError("INVOICE_FILE_INVALID", `不支持的文件类型: ${ext || "(无扩展名)"}`, 400);
  }

  const declared = normalizeDeclaredMime(opts.declaredMime, ext);
  if (declared && !opts.allowedMime.has(declared)) {
    throw new InvoiceStagingError("INVOICE_FILE_INVALID", `不支持的 MIME 类型: ${declared}`, 400);
  }

  const magic = detectMimeFromMagic(opts.buffer);
  if (!magic || !opts.allowedMime.has(magic)) {
    throw new InvoiceStagingError("INVOICE_FILE_INVALID", "文件内容与允许的类型不符", 400);
  }

  // Extension / declared MIME must agree with magic when declared is present.
  if (declared && declared !== magic) {
    throw new InvoiceStagingError("INVOICE_FILE_INVALID", "文件扩展名、MIME 与内容不一致", 400);
  }

  // Extension family must match magic.
  const extMime = normalizeDeclaredMime("", ext);
  if (extMime && extMime !== magic) {
    throw new InvoiceStagingError("INVOICE_FILE_INVALID", "文件扩展名与内容不一致", 400);
  }

  return {
    mimeType: magic,
    ext,
    sha256: computeSha256(opts.buffer),
    displayName,
  };
}

/**
 * Resolve storageKey to an absolute path under the staging root.
 * Rejects absolute keys and `..` traversal.
 */
export function resolveStagingAbsolutePath(storageKey: string): string {
  const key = (storageKey || "").replace(/\\/g, "/").trim();
  if (!key || key.startsWith("/") || key.includes("\0") || key.split("/").some((p) => p === "..")) {
    throw new InvoiceStagingError("INVOICE_FILE_INVALID", "非法 staging 路径", 400);
  }

  const root = getInvoiceStagingRoot();
  const absolute = path.resolve(root, key);
  const rootWithSep = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (absolute !== root && !absolute.startsWith(rootWithSep)) {
    throw new InvoiceStagingError("INVOICE_FILE_INVALID", "非法 staging 路径", 400);
  }
  return absolute;
}

export async function ensureStagingRoot(): Promise<string> {
  const root = getInvoiceStagingRoot();
  await fs.mkdir(root, { recursive: true });
  return root;
}

export async function readStagingFileBuffer(storageKey: string): Promise<Buffer> {
  const absolute = resolveStagingAbsolutePath(storageKey);
  try {
    return await fs.readFile(absolute);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      throw new InvoiceStagingError("INVOICE_STAGING_NOT_FOUND", "staging 文件不存在", 404);
    }
    throw err;
  }
}

export async function deleteStagingFileQuietly(storageKey: string): Promise<void> {
  try {
    const absolute = resolveStagingAbsolutePath(storageKey);
    await fs.unlink(absolute);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return;
    console.warn("[invoice-staging] failed to delete staging file:", (err as Error).message);
  }
}

export type CreateStagingFileInput = {
  createdById: string;
  agentRunId?: string | null;
  originalFileName: string;
  declaredMime: string;
  buffer: Buffer;
  allowedMime?: Set<string>;
  allowedExt?: Set<string>;
  ttlMs?: number;
  /**
   * P1#4: 可选的预分配 ID。调用方可在创建 staging 之前先用该 ID 绑定 route 的 targetId，
   * 使"route 绑定目标"与"staging 持久化"之间的崩溃窗口可恢复（route.targetId 即使 staging
   * 尚未落库也已指向预定 ID；恢复任务据此判断目标是否存在）。
   */
  id?: string;
};

export async function createInvoiceStagingFile(input: CreateStagingFileInput) {
  const validated = assertInvoiceFilePayload({
    originalFileName: input.originalFileName,
    declaredMime: input.declaredMime,
    buffer: input.buffer,
    allowedMime: input.allowedMime ?? AGENT_INVOICE_STAGING_MIME,
    allowedExt: input.allowedExt ?? AGENT_INVOICE_STAGING_EXTENSIONS,
  });

  await ensureStagingRoot();
  const storageKey = path.posix.join(
    input.createdById,
    safeStorageFileName(input.originalFileName),
  );
  const expiresAt = new Date(Date.now() + (input.ttlMs ?? INVOICE_STAGING_TTL_MS));

  // P1 孤儿文件修复：先持久化 DB 行（含 storageKey，status=PENDING_FILE），再写磁盘文件，
  // 写完后 CAS 转 UPLOADED。PENDING_FILE 表示"文件尚未落盘"：
  //  - 恢复/采纳/分析/注册均不把 PENDING_FILE 视为可用，避免读到无实体文件的 staging；
  //  - 文件写入崩溃 → DB 行仍存（PENDING_FILE），sweepExpiredInvoiceStaging 凭 storageKey 清理；
  //  - DB 插入失败 → 无文件产生（零孤儿）。
  const row = await prisma.agentInvoiceStagingFile.create({
    data: {
      // P1#4: 若调用方预分配了 ID（已在 route.targetId 绑定），使用之；否则由 Prisma 生成。
      ...(input.id ? { id: input.id } : {}),
      createdById: input.createdById,
      agentRunId: input.agentRunId ?? null,
      originalFileName: validated.displayName,
      storageKey,
      mimeType: validated.mimeType,
      fileSize: input.buffer.length,
      sha256: validated.sha256,
      status: "PENDING_FILE",
      version: 1,
      expiresAt,
    },
  });

  const absolute = resolveStagingAbsolutePath(storageKey);
  try {
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, input.buffer);
  } catch (err) {
    // P2：写入异常时先删可能已写入的部分文件（storageKey 已知），再删 DB 行。
    // 否则 DB 行一删，部分文件就成了无法定位的孤儿（无 invoice staging 根目录 orphan 扫描）。
    await deleteStagingFileQuietly(storageKey);
    await prisma.agentInvoiceStagingFile.delete({ where: { id: row.id } }).catch(() => undefined);
    throw err;
  }

  // 文件已落盘：CAS PENDING_FILE → UPLOADED。若行在此期间被 sweep/并发改态，CAS 写 0 行——
  // 文件已存在，DB 行仍在，后续 sweep 会按 storageKey 清理；返回当前行（状态可能已变）。
  await prisma.agentInvoiceStagingFile.updateMany({
    where: { id: row.id, status: "PENDING_FILE" },
    data: { status: "UPLOADED" },
  });
  // 重读以返回最新状态（CAS 可能因并发未生效）。
  const refreshed = await prisma.agentInvoiceStagingFile.findUniqueOrThrow({ where: { id: row.id } });
  return refreshed;
}

/**
 * Owner-scoped map of active `finance.register_issued_invoice` proposals keyed by
 * their target stagingFileId. Agent-own model access (AgentProposal) kept in the
 * finance staging service so the Agent API route stays Prisma-free.
 */
export async function listPendingInvoiceRegisterProposals(opts: {
  userId: string;
  agentRunId?: string | null;
}): Promise<Map<string, string>> {
  const pendingProposals = await prisma.agentProposal.findMany({
    where: {
      userId: opts.userId,
      status: { in: ["PENDING", "PROCESSING"] },
      actionKey: "finance.register_issued_invoice",
      ...(opts.agentRunId ? { agentRunId: opts.agentRunId } : {}),
    },
    select: { id: true, inputJson: true },
    take: 100,
  });

  const proposalByStagingId = new Map<string, string>();
  for (const proposal of pendingProposals) {
    try {
      const input = JSON.parse(proposal.inputJson) as Record<string, unknown>;
      const stagingFileId = typeof input.stagingFileId === "string" ? input.stagingFileId : "";
      if (stagingFileId && !proposalByStagingId.has(stagingFileId)) {
        proposalByStagingId.set(stagingFileId, proposal.id);
      }
    } catch {
      // ignore malformed
    }
  }
  return proposalByStagingId;
}

export type DeleteInvoiceStagingResult = { ok: true; cleaned?: "staging_copy" };

/**
 * Owner-scoped delete of an invoice staging file.
 * - REGISTERED: only the staging file copy is removed; formal InvoiceDocument stays.
 * - UPLOADED/ANALYZING/ANALYZED/SKIPPED/EXPIRED: file removed + row marked SKIPPED.
 * - other states (e.g. PENDING_FILE): rejected with INVOICE_STAGING_CHANGED (409).
 * Ownership/visibility enforced by getOwnedStagingFile; receiving an ID never implies access.
 */
export async function deleteOwnedInvoiceStaging(opts: {
  stagingFileId: string;
  userId: string;
}): Promise<DeleteInvoiceStagingResult> {
  const staging = await getOwnedStagingFile({
    stagingFileId: opts.stagingFileId,
    userId: opts.userId,
    requireActive: false,
  });

  if (staging.status === "REGISTERED") {
    await deleteStagingFileQuietly(staging.storageKey);
    return { ok: true, cleaned: "staging_copy" };
  }

  if (!["UPLOADED", "ANALYZING", "ANALYZED", "SKIPPED", "EXPIRED"].includes(staging.status)) {
    throw new InvoiceStagingError(
      "INVOICE_STAGING_CHANGED",
      `当前状态不可删除: ${staging.status}`,
      409,
    );
  }

  await deleteStagingFileQuietly(staging.storageKey);
  await prisma.agentInvoiceStagingFile.update({
    where: { id: staging.id },
    data: { status: "SKIPPED" },
  });
  return { ok: true };
}

export async function getOwnedStagingFile(opts: {
  stagingFileId: string;
  userId: string;
  requireActive?: boolean;
}) {
  const row = await prisma.agentInvoiceStagingFile.findUnique({
    where: { id: opts.stagingFileId },
  });
  if (!row || row.createdById !== opts.userId) {
    throw new InvoiceStagingError("INVOICE_STAGING_NOT_FOUND", "staging 不存在或不可见", 404);
  }
  if (opts.requireActive !== false) {
    if (row.status === "EXPIRED" || row.expiresAt.getTime() <= Date.now()) {
      throw new InvoiceStagingError("INVOICE_STAGING_EXPIRED", "staging 已过期", 410);
    }
    // 登记/注入只接受 UPLOADED|ANALYZED；ANALYZING 由 claim 专用路径处理。
    if (row.status !== "UPLOADED" && row.status !== "ANALYZED") {
      throw new InvoiceStagingError(
        "INVOICE_STAGING_CHANGED",
        `staging 状态不可用: ${row.status}`,
        409,
      );
    }
  }
  return row;
}

/**
 * 原子 claim：UPLOADED|ANALYZED → ANALYZING。
 * 用于 OCR 开始前防止并发分析/登记。
 */
export async function claimStagingForAnalysis(opts: {
  stagingFileId: string;
  userId: string;
  expectedSha256: string;
  expectedVersion: number;
}): Promise<{ claimed: true } | { claimed: false }> {
  const result = await prisma.agentInvoiceStagingFile.updateMany({
    where: {
      id: opts.stagingFileId,
      createdById: opts.userId,
      sha256: opts.expectedSha256,
      version: opts.expectedVersion,
      status: { in: ["UPLOADED", "ANALYZED"] },
      expiresAt: { gt: new Date() },
    },
    data: { status: "ANALYZING" },
  });
  return result.count === 1 ? { claimed: true } : { claimed: false };
}

/**
 * OCR 成功写回：ANALYZING → ANALYZED，version += 1。
 * 保留上一份成功结果的策略：成功后一次性替换 extracted/ocr 字段。
 */
export async function completeStagingAnalysis(opts: {
  stagingFileId: string;
  userId: string;
  expectedSha256: string;
  extractedJson: string;
  ocrRawText: string;
  ocrWarningsJson: string;
}): Promise<{ id: string; version: number; status: string; sha256: string; originalFileName: string }> {
  const current = await prisma.agentInvoiceStagingFile.findFirst({
    where: {
      id: opts.stagingFileId,
      createdById: opts.userId,
      sha256: opts.expectedSha256,
      status: "ANALYZING",
    },
  });
  if (!current) {
    throw new InvoiceStagingError("INVOICE_STAGING_CHANGED", "staging 分析状态已变化", 409);
  }

  const updated = await prisma.agentInvoiceStagingFile.updateMany({
    where: {
      id: opts.stagingFileId,
      createdById: opts.userId,
      sha256: opts.expectedSha256,
      status: "ANALYZING",
      version: current.version,
    },
    data: {
      status: "ANALYZED",
      extractedJson: opts.extractedJson,
      ocrRawText: opts.ocrRawText,
      ocrWarningsJson: opts.ocrWarningsJson,
      version: { increment: 1 },
    },
  });
  if (updated.count !== 1) {
    throw new InvoiceStagingError("INVOICE_STAGING_CHANGED", "staging 分析写回失败", 409);
  }

  const row = await prisma.agentInvoiceStagingFile.findUniqueOrThrow({
    where: { id: opts.stagingFileId },
    select: {
      id: true,
      version: true,
      status: true,
      sha256: true,
      originalFileName: true,
    },
  });
  return row;
}

/**
 * OCR 失败：ANALYZING → UPLOADED。
 * 不清除上一份成功的 extractedJson；仅写入安全错误摘要到 ocrWarningsJson。
 */
export async function failStagingAnalysis(opts: {
  stagingFileId: string;
  userId: string;
  expectedSha256: string;
  errorSummary: string;
}): Promise<void> {
  const current = await prisma.agentInvoiceStagingFile.findFirst({
    where: {
      id: opts.stagingFileId,
      createdById: opts.userId,
      sha256: opts.expectedSha256,
      status: "ANALYZING",
    },
    select: { id: true, ocrWarningsJson: true },
  });
  if (!current) return;

  let warnings: string[] = [];
  try {
    const parsed = current.ocrWarningsJson ? JSON.parse(current.ocrWarningsJson) : [];
    if (Array.isArray(parsed)) {
      warnings = parsed.filter((x): x is string => typeof x === "string").slice(0, 20);
    }
  } catch {
    warnings = [];
  }
  warnings.push(opts.errorSummary.slice(0, 200));

  await prisma.agentInvoiceStagingFile.updateMany({
    where: {
      id: opts.stagingFileId,
      createdById: opts.userId,
      sha256: opts.expectedSha256,
      status: "ANALYZING",
    },
    data: {
      status: "UPLOADED",
      ocrWarningsJson: JSON.stringify(warnings.slice(-10)),
    },
  });
}

/** 将卡住的 ANALYZING 恢复为 UPLOADED（不超过绝对 7 天 TTL）。 */
export async function recoverStaleAnalyzingStaging(limit = 20): Promise<number> {
  const now = new Date();
  const leaseCutoff = new Date(now.getTime() - INVOICE_STAGING_ANALYZING_LEASE_MS);
  const rows = await prisma.agentInvoiceStagingFile.findMany({
    where: {
      status: "ANALYZING",
      updatedAt: { lte: leaseCutoff },
    },
    orderBy: { updatedAt: "asc" },
    take: limit,
    select: { id: true, createdAt: true, expiresAt: true },
  });

  let recovered = 0;
  for (const row of rows) {
    const absoluteMax = new Date(row.createdAt.getTime() + INVOICE_STAGING_MAX_TTL_MS);
    if (absoluteMax.getTime() <= now.getTime()) {
      await prisma.agentInvoiceStagingFile.updateMany({
        where: { id: row.id, status: "ANALYZING" },
        data: { status: "EXPIRED" },
      });
      recovered += 1;
      continue;
    }
    const result = await prisma.agentInvoiceStagingFile.updateMany({
      where: { id: row.id, status: "ANALYZING" },
      data: {
        status: "UPLOADED",
        ocrWarningsJson: JSON.stringify(["OCR 分析中断，已恢复为可重试状态"]),
      },
    });
    if (result.count === 1) recovered += 1;
  }
  return recovered;
}

export async function markStagingSkipped(opts: {
  stagingFileId: string;
  userId: string;
}): Promise<void> {
  const result = await prisma.agentInvoiceStagingFile.updateMany({
    where: {
      id: opts.stagingFileId,
      createdById: opts.userId,
      status: { in: ["UPLOADED", "ANALYZED", "ANALYZING"] },
    },
    data: { status: "SKIPPED" },
  });
  if (result.count !== 1) {
    throw new InvoiceStagingError("INVOICE_STAGING_CHANGED", "staging 无法标记为跳过", 409);
  }
}

export async function bindStagingToAgentRun(opts: {
  stagingFileIds: string[];
  userId: string;
  agentRunId: string;
}): Promise<number> {
  if (opts.stagingFileIds.length === 0) return 0;
  const uniqueIds = [...new Set(opts.stagingFileIds)].slice(0, INVOICE_STAGING_MAX_FILES_PER_MESSAGE);
  const result = await prisma.agentInvoiceStagingFile.updateMany({
    where: {
      id: { in: uniqueIds },
      createdById: opts.userId,
      status: { in: ["UPLOADED", "ANALYZING", "ANALYZED"] },
      OR: [{ agentRunId: null }, { agentRunId: opts.agentRunId }],
    },
    data: { agentRunId: opts.agentRunId },
  });
  return result.count;
}

/**
 * Assert every staging id is owned by user and either unbound or already bound to agentRunId.
 * Then bind unbound rows. Throws InvoiceStagingError if any id cannot be claimed for this run.
 */
export async function assertAndBindStagingToAgentRun(opts: {
  stagingFileIds: string[];
  userId: string;
  agentRunId: string;
}): Promise<void> {
  const uniqueIds = [...new Set(opts.stagingFileIds)].slice(0, INVOICE_STAGING_MAX_FILES_PER_MESSAGE);
  if (uniqueIds.length === 0) return;

  const rows = await prisma.agentInvoiceStagingFile.findMany({
    where: {
      id: { in: uniqueIds },
      createdById: opts.userId,
    },
    select: { id: true, agentRunId: true, status: true },
  });
  if (rows.length !== uniqueIds.length) {
    throw new InvoiceStagingError("INVOICE_STAGING_CHANGED", "部分 staging 不可见或不存在", 409);
  }
  for (const row of rows) {
    if (row.agentRunId && row.agentRunId !== opts.agentRunId) {
      throw new InvoiceStagingError(
        "INVOICE_STAGING_CHANGED",
        "staging 已绑定其他 Agent 会话，无法注入当前对话",
        409,
      );
    }
    if (!["UPLOADED", "ANALYZING", "ANALYZED"].includes(row.status)) {
      throw new InvoiceStagingError(
        "INVOICE_STAGING_CHANGED",
        `staging 状态不可绑定: ${row.status}`,
        409,
      );
    }
  }

  const bound = await bindStagingToAgentRun(opts);
  if (bound !== uniqueIds.length) {
    throw new InvoiceStagingError(
      "INVOICE_STAGING_CHANGED",
      "staging 与 AgentRun 绑定失败，请刷新后重试",
      409,
    );
  }
}

/**
 * Owner scope gate for a set of invoice staging ids (no AgentRun binding).
 *
 * T1.4: the `create-invoice-ingest` route without an agentRunId must still
 * assert ownership before enqueueing a Job, otherwise a Job could be created
 * for someone else's staging (polluting the queue / "my tasks" list even
 * though the worker's owner check skips processing). Kept in the finance
 * staging service so the Agent API route stays Prisma-free.
 */
export async function assertOwnedInvoiceStagingFiles(opts: {
  stagingFileIds: string[];
  userId: string;
}): Promise<void> {
  const uniqueIds = [...new Set(opts.stagingFileIds)];
  if (uniqueIds.length === 0) return;
  const ownedCount = await prisma.agentInvoiceStagingFile.count({
    where: { id: { in: uniqueIds }, createdById: opts.userId },
  });
  if (ownedCount !== uniqueIds.length) {
    throw new InvoiceStagingError(
      "INVOICE_STAGING_CHANGED",
      "部分 staging 不可见或不存在",
      409,
    );
  }
}

export async function listOwnedInvoiceStaging(opts: {
  userId: string;
  agentRunId?: string | null;
  status?: InvoiceStagingStatus | InvoiceStagingStatus[];
  limit?: number;
}) {
  const statuses = opts.status
    ? Array.isArray(opts.status) ? opts.status : [opts.status]
    : (["UPLOADED", "ANALYZING", "ANALYZED"] as InvoiceStagingStatus[]);
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 50);

  return prisma.agentInvoiceStagingFile.findMany({
    where: {
      createdById: opts.userId,
      status: { in: statuses },
      expiresAt: { gt: new Date() },
      ...(opts.agentRunId ? { agentRunId: opts.agentRunId } : {}),
    },
    orderBy: { createdAt: "asc" },
    take: limit,
    select: {
      id: true,
      originalFileName: true,
      mimeType: true,
      fileSize: true,
      sha256: true,
      status: true,
      version: true,
      expiresAt: true,
      agentRunId: true,
      createdAt: true,
      updatedAt: true,
      // Never select ocrRawText for list/metadata APIs.
      extractedJson: true,
      ocrWarningsJson: true,
    },
  });
}

export async function verifyStagingFileIntegrity(opts: {
  staging: { storageKey: string; sha256: string; version: number };
  expectedSha256?: string;
  expectedVersion?: number;
}): Promise<Buffer> {
  if (opts.expectedVersion != null && opts.staging.version !== opts.expectedVersion) {
    throw new InvoiceStagingError("INVOICE_STAGING_CHANGED", "staging 版本已变化", 409);
  }
  if (opts.expectedSha256 && opts.staging.sha256 !== opts.expectedSha256) {
    throw new InvoiceStagingError("INVOICE_STAGING_CHANGED", "staging 文件哈希与期望不一致", 409);
  }

  const buffer = await readStagingFileBuffer(opts.staging.storageKey);
  const actual = computeSha256(buffer);
  if (actual !== opts.staging.sha256) {
    throw new InvoiceStagingError("INVOICE_FILE_INVALID", "staging 文件哈希校验失败", 400);
  }
  return buffer;
}

export function toPublicStagingMeta(row: {
  id: string;
  originalFileName: string;
  mimeType: string;
  fileSize: number;
  sha256: string;
  status: string;
  version: number;
  expiresAt: Date;
}) {
  return {
    id: row.id,
    fileName: row.originalFileName,
    mimeType: row.mimeType,
    fileSize: row.fileSize,
    sha256: row.sha256,
    status: row.status,
    version: row.version,
    expiresAt: row.expiresAt.toISOString(),
  };
}

/**
 * Opportunistic cleanup of expired staging rows/files.
 * PENDING/PROCESSING proposals may delay expiry, but never beyond createdAt + 7 days.
 * Past the absolute max, staging is expired and related open proposals are failed.
 */
export async function sweepExpiredInvoiceStaging(limit = 20): Promise<number> {
  const now = new Date();
  await recoverStaleAnalyzingStaging(limit).catch(() => 0);

  const candidates = await prisma.agentInvoiceStagingFile.findMany({
    where: {
      // P2：PENDING_FILE（文件未落盘的中间态）也需纳入清理，否则崩溃留下的部分文件无法回收。
      status: { in: ["PENDING_FILE", "UPLOADED", "ANALYZING", "ANALYZED", "SKIPPED", "EXPIRED"] },
      expiresAt: { lte: now },
    },
    orderBy: { expiresAt: "asc" },
    take: limit,
    select: { id: true, storageKey: true, status: true, createdAt: true },
  });

  let cleaned = 0;
  for (const row of candidates) {
    const absoluteMax = new Date(row.createdAt.getTime() + INVOICE_STAGING_MAX_TTL_MS);
    const pastAbsoluteMax = absoluteMax.getTime() <= now.getTime();

    const pendingProposals = await prisma.agentProposal.findMany({
      where: {
        status: { in: ["PENDING", "PROCESSING"] },
        actionKey: "finance.register_issued_invoice",
        inputJson: { contains: `"stagingFileId":"${row.id}"` },
      },
      select: { id: true },
      take: 20,
    });

    if (pendingProposals.length > 0 && !pastAbsoluteMax) {
      // Extend toward absolute max (createdAt + 7d), never from "now + 7d".
      await prisma.agentInvoiceStagingFile.update({
        where: { id: row.id },
        data: { expiresAt: absoluteMax },
      });
      continue;
    }

    if (pendingProposals.length > 0 && pastAbsoluteMax) {
      await prisma.agentProposal.updateMany({
        where: {
          id: { in: pendingProposals.map((p) => p.id) },
          status: { in: ["PENDING", "PROCESSING"] },
        },
        data: {
          status: "FAILED",
          error: "关联的发票 staging 已超过最长保留期",
          decidedAt: now,
        },
      });
    }

    await deleteStagingFileQuietly(row.storageKey);
    await prisma.agentInvoiceStagingFile.update({
      where: { id: row.id },
      data: { status: "EXPIRED" },
    });
    cleaned += 1;
  }
  return cleaned;
}

export type VerifiedInvoiceStagingContext = {
  stagingFileId: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  sha256: string;
  version: number;
  expiresAt: string;
};

/** Server-side validation for client-provided staging context before prompt injection. */
export async function validateVerifiedInvoiceStagingContext(opts: {
  userId: string;
  stagingFileId: string;
  expectedSha256?: string;
  expectedStagingVersion?: number;
  /** When set, staging must be unbound or already bound to this run. */
  agentRunId?: string | null;
}): Promise<VerifiedInvoiceStagingContext | null> {
  try {
    const staging = await getOwnedStagingFile({
      stagingFileId: opts.stagingFileId,
      userId: opts.userId,
      requireActive: true,
    });
    // ANALYZING is not injectable into the model mid-flight.
    if (staging.status === "ANALYZING") return null;
    if (
      opts.agentRunId
      && staging.agentRunId
      && staging.agentRunId !== opts.agentRunId
    ) {
      return null;
    }
    await verifyStagingFileIntegrity({
      staging,
      expectedSha256: opts.expectedSha256,
      expectedVersion: opts.expectedStagingVersion,
    });
    return {
      stagingFileId: staging.id,
      fileName: staging.originalFileName,
      mimeType: staging.mimeType,
      fileSize: staging.fileSize,
      sha256: staging.sha256,
      version: staging.version,
      expiresAt: staging.expiresAt.toISOString(),
    };
  } catch (error) {
    // 业务级错误（不存在、过期、状态不可用、完整性不匹配）→ 正常返回 null
    if (error instanceof InvoiceStagingError) return null;
    // 基础设施错误（DB 连接失败等）→ 不伪装成"附件不可用"，向上传播
    console.error("[invoice-staging] validateVerifiedInvoiceStagingContext infra error:", error);
    throw error;
  }
}

/**
 * Validate an array of client-provided staging contexts (max 10, no duplicate IDs).
 * Returns only server-regenerated verified entries, preserving input order.
 * When agentRunId is provided, foreign-run bindings are rejected (item skipped).
 */
export async function validateVerifiedInvoiceStagingContextList(opts: {
  userId: string;
  items: Array<{
    stagingFileId?: unknown;
    sha256?: unknown;
    version?: unknown;
  }>;
  agentRunId?: string | null;
}): Promise<VerifiedInvoiceStagingContext[]> {
  const rawItems = opts.items.slice(0, INVOICE_STAGING_MAX_FILES_PER_MESSAGE);
  const seen = new Set<string>();
  const verified: VerifiedInvoiceStagingContext[] = [];

  for (const item of rawItems) {
    const stagingFileId = typeof item.stagingFileId === "string" ? item.stagingFileId.trim() : "";
    if (!stagingFileId || seen.has(stagingFileId)) continue;
    seen.add(stagingFileId);
    const sha256 = typeof item.sha256 === "string" ? item.sha256.trim() : undefined;
    const version = typeof item.version === "number" ? item.version : undefined;
    const validated = await validateVerifiedInvoiceStagingContext({
      userId: opts.userId,
      stagingFileId,
      expectedSha256: sha256,
      expectedStagingVersion: version,
      agentRunId: opts.agentRunId,
    });
    if (validated) verified.push(validated);
  }
  return verified;
}

/**
 * Worker INVOICE_INGEST item 处理所需的 staging 快照（T9.1a：收敛 worker 对 prisma 的直连）。
 * 字段集与原 worker 内直连查询逐字一致。
 */
export async function getInvoiceStagingForIngest(stagingId: string) {
  return prisma.agentInvoiceStagingFile.findUnique({
    where: { id: stagingId },
    select: {
      id: true,
      createdById: true,
      sha256: true,
      version: true,
      status: true,
      expiresAt: true,
      originalFileName: true,
    },
  });
}

/** Ingest 完成摘要所需的解析结果读取（T9.1a：收敛 worker 直连）。 */
export async function getInvoiceStagingExtracted(stagingFileId: string) {
  return prisma.agentInvoiceStagingFile.findUnique({
    where: { id: stagingFileId },
    select: { extractedJson: true, originalFileName: true },
  });
}

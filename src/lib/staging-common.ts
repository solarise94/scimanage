/**
 * Staging 公共安全原语（无领域状态）。
 *
 * 见 docs/agent-sequential-order-import-upgrade-design-2026-07-21.md §4.1.1。
 * 抽取自发票 staging（src/lib/finance/invoice-staging.ts）中无领域状态的部分：
 *   - 私有根目录下的 canonical path 解析与路径逃逸拒绝；
 *   - 扩展名 / MIME / 魔数一致性检查；
 *   - SHA-256、大小限制和安全文件名；
 *   - TTL 计算、过期判断；
 *   - expectedVersion 校验、lease 超时判断和 claim 结果类型；
 *   - XLSX ZIP 容器及解压总量限制。
 *
 * 明确不抽取：Prisma 模型 CRUD、session/row 状态机、parser 选择、proposal 逻辑。
 * InvoiceStagingFile 与 AgentImportStagingFile 保持独立模型，避免形成"万能上传表"。
 */

import { createHash, randomUUID } from "crypto";
import fs from "fs/promises";
import path from "path";

// ─── 通用错误 ────────────────────────────────────────────────

export class StagingError extends Error {
  code: string;
  httpStatus: number;

  constructor(code: string, message: string, httpStatus: number) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
    this.name = "StagingError";
  }
}

// ─── 通用限额 ────────────────────────────────────────────────

export const STAGING_TTL_MS = 24 * 60 * 60 * 1000; // 24h 默认 TTL
export const STAGING_MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 有活动 proposal 时最长 7d
export const STAGING_ANALYZING_LEASE_MS = 10 * 60 * 1000; // ANALYZING 租约 10min

// ─── 文件名与哈希 ────────────────────────────────────────────

export function sanitizeDisplayFileName(name: string, maxLen = 180): string {
  const cleaned = name
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[/\\]/g, "_")
    .trim();
  const base = cleaned || "file";
  return base.length > maxLen ? base.slice(0, maxLen) : base;
}

/** 生成服务端存储文件名：UUID + 受信任扩展名（扩展名必须在 allowedExt 白名单内）。 */
export function safeStorageFileName(originalName: string, allowedExt: Set<string>): string {
  const ext = path.extname(originalName).toLowerCase();
  const safeExt = allowedExt.has(ext) ? ext : "";
  return `${randomUUID()}${safeExt}`;
}

export function computeSha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

// ─── 路径安全 ────────────────────────────────────────────────

/**
 * 将 storageKey 解析为 root 下的绝对路径。
 * 拒绝绝对路径、NUL 字节与 `..` 逃逸。
 */
export function resolveUnderRoot(root: string, storageKey: string): string {
  const key = (storageKey || "").replace(/\\/g, "/").trim();
  if (!key || key.startsWith("/") || key.includes("\0") || key.split("/").some((p) => p === "..")) {
    throw new StagingError("STAGING_PATH_INVALID", "非法 staging 路径", 400);
  }
  const absolute = path.resolve(root, key);
  const rootWithSep = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (absolute !== root && !absolute.startsWith(rootWithSep)) {
    throw new StagingError("STAGING_PATH_INVALID", "非法 staging 路径", 400);
  }
  return absolute;
}

export async function ensureDir(dir: string): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export async function readFileUnderRoot(root: string, storageKey: string): Promise<Buffer> {
  const absolute = resolveUnderRoot(root, storageKey);
  try {
    return await fs.readFile(absolute);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      throw new StagingError("STAGING_NOT_FOUND", "staging 文件不存在", 404);
    }
    throw err;
  }
}

export async function writeFileUnderRoot(root: string, storageKey: string, buffer: Buffer): Promise<string> {
  const absolute = resolveUnderRoot(root, storageKey);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, buffer);
  return absolute;
}

export async function deleteFileUnderRootQuietly(root: string, storageKey: string): Promise<void> {
  try {
    const absolute = resolveUnderRoot(root, storageKey);
    await fs.unlink(absolute);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return;
    console.warn("[staging-common] failed to delete staging file:", (err as Error).message);
  }
}

/**
 * 严格删除：仅 ENOENT 视作成功（文件本就不存在），其余错误必须抛出。
 * 用于 PURGING 等要求「文件必删或可重试」的路径，避免吞掉 EACCES/EIO 后误删 DB 行。
 */
export async function deleteFileUnderRootStrict(root: string, storageKey: string): Promise<void> {
  const absolute = resolveUnderRoot(root, storageKey);
  try {
    await fs.unlink(absolute);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return;
    throw err;
  }
}

// ─── 魔数 / MIME 一致性 ──────────────────────────────────────

/** 从文件魔数探测 MIME；无法识别返回 null。支持 PDF/JPEG/PNG 与 ZIP（XLSX 容器）。 */
export function detectMimeFromMagic(buffer: Buffer): string | null {
  if (
    buffer.length >= 5
    && buffer[0] === 0x25
    && buffer[1] === 0x50
    && buffer[2] === 0x44
    && buffer[3] === 0x46
  ) {
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
  // WebP：RIFF....WEBP
  if (
    buffer.length >= 12
    && buffer.toString("ascii", 0, 4) === "RIFF"
    && buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  // ZIP 容器（XLSX/DOCX 等 OOXML）：PK\x03\x04
  if (
    buffer.length >= 4
    && buffer[0] === 0x50
    && buffer[1] === 0x4b
    && (buffer[2] === 0x03 || buffer[2] === 0x05 || buffer[2] === 0x07)
    && (buffer[3] === 0x04 || buffer[3] === 0x06 || buffer[3] === 0x08)
  ) {
    return "application/zip";
  }
  return null;
}

/** 文本类文件（CSV/TSV/TXT）没有可靠魔数；允许通过扩展名 + 可解码 UTF-8 判定。 */
export function looksLikeText(buffer: Buffer): boolean {
  if (buffer.length === 0) return false;
  // 拒绝 NUL 字节（二进制强信号）。
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  if (sample.includes(0x00)) return false;
  return true;
}

/**
 * 校验扩展名 / 声明 MIME / 魔数三者一致。
 * textKind=true 时对 CSV/TSV/TXT 走文本判定而非魔数。
 */
export function assertFileSignature(opts: {
  originalFileName: string;
  declaredMime: string;
  buffer: Buffer;
  allowedMime: Set<string>;
  allowedExt: Set<string>;
  /** 扩展名 → 规范 MIME 的映射，用于声明缺失时回填与一致性比对。 */
  extToMime: Map<string, string>;
  maxBytes: number;
  textExtensions?: Set<string>;
}): { mimeType: string; ext: string; sha256: string; displayName: string } {
  const displayName = sanitizeDisplayFileName(opts.originalFileName);
  const ext = path.extname(opts.originalFileName).toLowerCase();

  if (opts.buffer.length === 0) {
    throw new StagingError("STAGING_FILE_INVALID", "文件为空", 400);
  }
  if (opts.buffer.length > opts.maxBytes) {
    throw new StagingError("STAGING_FILE_INVALID", `文件大小超过上限`, 400);
  }
  if (!opts.allowedExt.has(ext)) {
    throw new StagingError("STAGING_FILE_INVALID", `不支持的文件类型: ${ext || "(无扩展名)"}`, 400);
  }

  const declared = (opts.declaredMime || "").trim().toLowerCase() || opts.extToMime.get(ext) || "";
  if (declared && !opts.allowedMime.has(declared)) {
    throw new StagingError("STAGING_FILE_INVALID", `不支持的 MIME 类型: ${declared}`, 400);
  }

  const textExtensions = opts.textExtensions ?? new Set<string>();
  const isText = textExtensions.has(ext);

  let detected: string | null;
  if (isText) {
    if (!looksLikeText(opts.buffer)) {
      throw new StagingError("STAGING_FILE_INVALID", "文本文件内容不可解码", 400);
    }
    detected = opts.extToMime.get(ext) ?? "text/plain";
  } else {
    detected = detectMimeFromMagic(opts.buffer);
    // OOXML 等价类：XLSX/DOCX 等 ZIP 容器的魔数只能识别为 application/zip，
    // 与浏览器（或 ext 回填）声明的具体 OOXML MIME 永远不相等，不归一化会
    // 导致所有 .xlsx 上传被一致性检查误杀。ext 已过 allowedExt 白名单，
    // 且调用方对 OOXML 还有容器级校验（assertSafeZipContainer 查 [Content_Types].xml），
    // 因此把 application/zip 归一化为扩展名规范 MIME 再参与后续比对。
    if (detected === "application/zip" && opts.extToMime.has(ext)) {
      detected = opts.extToMime.get(ext)!;
    }
    if (!detected || !opts.allowedMime.has(detected)) {
      throw new StagingError("STAGING_FILE_INVALID", "文件内容与允许的类型不符", 400);
    }
  }

  if (declared && declared !== detected) {
    throw new StagingError("STAGING_FILE_INVALID", "文件扩展名、MIME 与内容不一致", 400);
  }

  return {
    mimeType: detected,
    ext,
    sha256: computeSha256(opts.buffer),
    displayName,
  };
}

// ─── XLSX ZIP 容器安全 ───────────────────────────────────────

export const XLSX_MAX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024; // 解压后总量上限 100MB
export const XLSX_MAX_ENTRIES = 1024;

/**
 * 轻量校验 ZIP 容器是否为 OOXML（含 [Content_Types].xml），并估算解压总量，防止 zip bomb。
 * 不真正解压；只解析中央目录的 uncompressed size 字段求和。
 */
export function assertSafeZipContainer(buffer: Buffer): { entries: number; uncompressedBytes: number } {
  if (buffer.length < 22) {
    throw new StagingError("STAGING_FILE_INVALID", "ZIP 容器损坏", 400);
  }
  // 定位 End of Central Directory（EOCD），签名 0x06054b50。
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0; i--) {
    if (
      buffer[i] === 0x50
      && buffer[i + 1] === 0x4b
      && buffer[i + 2] === 0x05
      && buffer[i + 3] === 0x06
    ) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    throw new StagingError("STAGING_FILE_INVALID", "ZIP 容器缺少中央目录", 400);
  }
  const totalEntries = buffer.readUInt16LE(eocd + 10);
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  if (totalEntries > XLSX_MAX_ENTRIES) {
    throw new StagingError("STAGING_FILE_INVALID", "ZIP 条目数超过上限", 400);
  }
  if (cdOffset >= buffer.length) {
    throw new StagingError("STAGING_FILE_INVALID", "ZIP 中央目录偏移非法", 400);
  }

  let uncompressedBytes = 0;
  let entries = 0;
  let hasContentTypes = false;
  let cursor = cdOffset;
  for (let n = 0; n < totalEntries; n++) {
    if (cursor + 46 > buffer.length) break;
    // 中央目录文件头签名 0x02014b50
    if (
      buffer[cursor] !== 0x50
      || buffer[cursor + 1] !== 0x4b
      || buffer[cursor + 2] !== 0x01
      || buffer[cursor + 3] !== 0x02
    ) {
      break;
    }
    const uncompressed = buffer.readUInt32LE(cursor + 24);
    const nameLen = buffer.readUInt16LE(cursor + 28);
    const extraLen = buffer.readUInt16LE(cursor + 30);
    const commentLen = buffer.readUInt16LE(cursor + 32);
    const nameStart = cursor + 46;
    const name = buffer.toString("utf8", nameStart, nameStart + nameLen);
    if (name === "[Content_Types].xml") hasContentTypes = true;
    uncompressedBytes += uncompressed;
    entries += 1;
    if (uncompressedBytes > XLSX_MAX_UNCOMPRESSED_BYTES) {
      throw new StagingError("STAGING_FILE_INVALID", "ZIP 解压总量超过上限（疑似 zip bomb）", 400);
    }
    cursor = nameStart + nameLen + extraLen + commentLen;
  }

  if (!hasContentTypes) {
    throw new StagingError("STAGING_FILE_INVALID", "非 OOXML 容器（缺少 [Content_Types].xml）", 400);
  }

  return { entries, uncompressedBytes };
}

// ─── TTL / lease / claim 通用类型 ────────────────────────────

export function computeExpiresAt(ttlMs: number = STAGING_TTL_MS, from: Date = new Date()): Date {
  return new Date(from.getTime() + ttlMs);
}

export function isExpired(expiresAt: Date, now: Date = new Date()): boolean {
  return expiresAt.getTime() <= now.getTime();
}

/** 绝对上限裁剪：延长 TTL 时不得超过 createdAt + maxTtlMs。 */
export function capExpiresAt(createdAt: Date, desired: Date, maxTtlMs: number = STAGING_MAX_TTL_MS): Date {
  const absoluteMax = new Date(createdAt.getTime() + maxTtlMs);
  return desired.getTime() > absoluteMax.getTime() ? absoluteMax : desired;
}

/** lease 是否已超时（可安全回收）。 */
export function isLeaseStale(leaseStartedAt: Date | null, leaseMs: number = STAGING_ANALYZING_LEASE_MS, now: Date = new Date()): boolean {
  if (!leaseStartedAt) return false;
  return now.getTime() - leaseStartedAt.getTime() > leaseMs;
}

export type ClaimResult = { claimed: true } | { claimed: false };

/** 校验 expectedVersion；不一致抛 409。 */
export function assertExpectedVersion(actual: number, expected: number | undefined, entity = "staging"): void {
  if (expected != null && actual !== expected) {
    throw new StagingError("STAGING_VERSION_CONFLICT", `${entity} 版本已变化`, 409);
  }
}

/** 校验 expectedSha256；不一致抛 409。 */
export function assertExpectedSha256(actual: string, expected: string | undefined, entity = "staging"): void {
  if (expected && actual !== expected) {
    throw new StagingError("STAGING_HASH_CONFLICT", `${entity} 文件哈希与期望不一致`, 409);
  }
}

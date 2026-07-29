/**
 * Agent 通用附件与私有项目附件的存储原语（§4.2 / §6.3.3）。
 *
 * - staging 根目录 AGENT_ATTACHMENT_STAGING_DIR（默认 .agent-attachments/）
 * - 项目私有附件根目录 AGENT_PROJECT_ATTACHMENT_DIR（默认 .agent-project-attachments/）
 * - 两个根目录完全隔离；staging sweep 只扫描 staging 根，绝不触碰项目附件。
 * - 提升（promote）走 copy .tmp → fsync → atomic rename，崩溃可由 route 恢复任务续接。
 * - 私有附件永不在 public/，下载经同源、逐次鉴权的内容端点。
 */

import { randomUUID } from "crypto";
import fs from "fs/promises";
import path from "path";
import {
  deleteFileUnderRootQuietly,
  deleteFileUnderRootStrict,
  ensureDir,
  readFileUnderRoot,
  resolveUnderRoot,
  StagingError,
} from "@/lib/staging-common";

// ─── 根目录 ─────────────────────────────────────────────────

export function getAgentAttachmentStagingRoot(): string {
  const configured = (process.env.AGENT_ATTACHMENT_STAGING_DIR || "").trim();
  const resolved = configured ? path.resolve(configured) : path.resolve(process.cwd(), ".agent-attachments");
  // P2#1: 防止误配把私有 staging 目录落入 public/（会被 Next.js 静态服务公开）。
  // assertNotUnderPublic 是 function 声明，会被 hoist，此处可安全调用。
  assertNotUnderPublic(resolved);
  return resolved;
}

export function getAgentProjectAttachmentRoot(): string {
  const configured = (process.env.AGENT_PROJECT_ATTACHMENT_DIR || "").trim();
  const resolved = configured ? path.resolve(configured) : path.resolve(process.cwd(), ".agent-project-attachments");
  // P2#1: 同上，私有项目附件目录不得落入 public/。
  assertNotUnderPublic(resolved);
  return resolved;
}

// ─── storageKey 生成 ────────────────────────────────────────

function safeExt(ext: string, allowed: Set<string>): string {
  return allowed.has(ext) ? ext : "";
}

/** staging 存储键：{ownerUserId}/{uuid}{ext}（ext 必须在白名单）。 */
export function stagingStorageKey(ownerUserId: string, ext: string, allowedExt: Set<string>): string {
  return path.posix.join(ownerUserId, `${randomUUID()}${safeExt(ext, allowedExt)}`);
}

/** 项目私有附件存储键：{projectId}/{uuid}{ext}。 */
export function projectAttachmentStorageKey(projectId: string, ext: string, allowedExt: Set<string>): string {
  return path.posix.join(projectId, `${randomUUID()}${safeExt(ext, allowedExt)}`);
}

// ─── staging 读写 ───────────────────────────────────────────

export async function writeStagingBuffer(storageKey: string, buffer: Buffer): Promise<string> {
  const root = getAgentAttachmentStagingRoot();
  await ensureDir(root);
  const absolute = resolveUnderRoot(root, storageKey);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, buffer);
  return absolute;
}

export async function readStagingBuffer(storageKey: string): Promise<Buffer> {
  return readFileUnderRoot(getAgentAttachmentStagingRoot(), storageKey);
}

/** 解析 staging 文件的绝对本地路径（仅供服务端 Vision provider 本地读取，绝不返回客户端/模型）。 */
export function resolveStagingAbsolutePath(storageKey: string): string {
  return resolveUnderRoot(getAgentAttachmentStagingRoot(), storageKey);
}

export async function deleteStagingBufferQuietly(storageKey: string): Promise<void> {
  await deleteFileUnderRootQuietly(getAgentAttachmentStagingRoot(), storageKey);
}

// ─── 项目私有附件读写 ───────────────────────────────────────

export async function readProjectAttachmentBuffer(storageKey: string): Promise<Buffer> {
  return readFileUnderRoot(getAgentProjectAttachmentRoot(), storageKey);
}

export async function deleteProjectAttachmentQuietly(storageKey: string): Promise<void> {
  await deleteFileUnderRootQuietly(getAgentProjectAttachmentRoot(), storageKey);
}

/** 严格删除私有项目附件：仅 ENOENT 成功，其余错误抛出（供 PURGING 路径使用）。 */
export async function deleteProjectAttachmentStrict(storageKey: string): Promise<void> {
  await deleteFileUnderRootStrict(getAgentProjectAttachmentRoot(), storageKey);
}

/**
 * 原子复制：src 绝对路径 → destRoot/destStorageKey。
 * 在目标目录写 .tmp（与 dest 同文件系统），writeFile → fsync → close → rename。
 * 崩溃在 rename 前：仅留下 .tmp，dest 不存在，恢复任务可重做；
 * 崩溃在 rename 后：dest 已就位。rename 在同一目录内原子完成。
 */
export async function atomicCopyIntoProjectRoot(opts: {
  sourceBuffer: Buffer;
  destStorageKey: string;
}): Promise<string> {
  const root = getAgentProjectAttachmentRoot();
  await ensureDir(root);
  const destAbs = resolveUnderRoot(root, opts.destStorageKey);
  await fs.mkdir(path.dirname(destAbs), { recursive: true });

  const tmpAbs = `${destAbs}.${randomUUID()}.tmp`;
  const handle = await fs.open(tmpAbs, "w");
  try {
    await handle.writeFile(opts.sourceBuffer);
    await handle.sync(); // fsync 数据落盘
  } catch (err) {
    await handle.close().catch(() => undefined);
    await fs.unlink(tmpAbs).catch(() => undefined);
    throw err;
  }
  await handle.close();

  try {
    await fs.rename(tmpAbs, destAbs); // 同目录原子 rename
  } catch (err) {
    await fs.unlink(tmpAbs).catch(() => undefined);
    throw err;
  }
  return destAbs;
}

/** 清理项目附件目录下残留的 .tmp（恢复任务调用）。 */
export async function cleanOrphanProjectTmpFiles(limit = 50): Promise<number> {
  const root = getAgentProjectAttachmentRoot();
  let cleaned = 0;
  async function walk(dir: string): Promise<void> {
    if (cleaned >= limit) return;
    let entries: import("fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (cleaned >= limit) return;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
      } else if (entry.isFile() && /\.tmp$/.test(entry.name)) {
        await fs.unlink(abs).catch(() => undefined);
        cleaned += 1;
      }
    }
  }
  await walk(root);
  return cleaned;
}

// ─── 受控内容 URL ───────────────────────────────────────────

/** 私有项目附件的同源受控内容端点（逐次鉴权）。 */
export function projectAttachmentContentUrl(projectId: string, attachmentId: string): string {
  return `/api/projects/${projectId}/attachments/${attachmentId}/content`;
}

/** 通用 staging 附件的同源受控内容端点（owner 或业务目标读权限）。 */
export function agentAttachmentContentUrl(stagingId: string): string {
  return `/api/agent/attachments/${stagingId}/content`;
}

export function assertNotUnderPublic(absPath: string): void {
  const publicRoot = path.resolve(process.cwd(), "public");
  const publicWithSep = publicRoot.endsWith(path.sep) ? publicRoot : `${publicRoot}${path.sep}`;
  if (absPath === publicRoot || absPath.startsWith(publicWithSep)) {
    throw new StagingError("ATTACHMENT_STORAGE_INVALID", "私有附件不得写入 public/", 500);
  }
}

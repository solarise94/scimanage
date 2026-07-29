/**
 * 私有项目附件共享服务（P0：页面上传与 Agent promotion 共用同一安全口径）。
 *
 * 写入流程（可恢复两阶段）：
 *   1. 事务内创建 Attachment(status=PENDING_FILE, isPrivate=true, storageKey, url=受控端点)
 *   2. 事务外 atomic copy（.tmp → fsync → rename）到 AGENT_PROJECT_ATTACHMENT_DIR
 *   3. 事务内 Attachment.status=READY（如有 route 同事务 PROMOTED）
 * 崩溃恢复：resumePendingPrivateAttachments() 按文件是否就位决定 READY / FAILED。
 *
 * 所有列表/详情/时间线/计数/下载必须只见 status=READY（ATTACHMENT_READY_FILTER）。
 */

import path from "path";
import fs from "node:fs/promises";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { StagingError } from "@/lib/staging-common";
import { ForbiddenError, NotFoundError, ValidationError, ConflictError } from "@/lib/application/errors";
import { ATTACHMENT_ALLOWED_EXT } from "@/lib/agent-attachments/constants";
import {
  atomicCopyIntoProjectRoot,
  deleteProjectAttachmentQuietly,
  deleteProjectAttachmentStrict,
  getAgentProjectAttachmentRoot,
  projectAttachmentContentUrl,
  projectAttachmentStorageKey,
  readProjectAttachmentBuffer,
} from "@/lib/agent-attachments/storage";

type DbLike = typeof prisma | Prisma.TransactionClient;

/**
 * 所有面向用户的项目附件查询都必须合并此过滤，排除 PENDING_FILE/FAILED 与归档项。
 * 归档（archived=true）是业务可见性软删：DB 行与私有文件保留，但从列表/时间线/计数/下载隐藏。
 */
export const ATTACHMENT_READY_FILTER = { status: "READY", archived: false } as const;

export type ProjectAttachmentSource = "PROJECT_UI" | "AGENT";

interface CreatePendingInput {
  projectId: string;
  filename: string;
  mimeType: string;
  size: number;
  ext: string;
  source: ProjectAttachmentSource;
  agentAttachmentRouteId?: string | null;
}

/** 事务内创建 PENDING_FILE 私有附件行（尚未落盘）。url 指向同源受控内容端点。 */
export async function createPendingPrivateAttachment(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  input: CreatePendingInput,
) {
  const storageKey = projectAttachmentStorageKey(input.projectId, input.ext, ATTACHMENT_ALLOWED_EXT);
  return tx.attachment.create({
    data: {
      projectId: input.projectId,
      filename: input.filename,
      mimeType: input.mimeType,
      size: input.size,
      // 先占位；READY 后此 url 即为受控内容端点。历史 public 行保持各自 url 不变。
      url: "",
      storageKey,
      isPrivate: true,
      source: input.source,
      status: "PENDING_FILE",
      agentAttachmentRouteId: input.agentAttachmentRouteId ?? null,
    },
  });
}

/** 把 buffer 原子复制到附件的 storageKey（项目私有根）。 */
export async function writePrivateAttachmentFile(opts: {
  storageKey: string;
  buffer: Buffer;
}): Promise<void> {
  await atomicCopyIntoProjectRoot({ sourceBuffer: opts.buffer, destStorageKey: opts.storageKey });
}

/** 事务内把附件标记 READY 并写入受控 url。 */
export async function markAttachmentReady(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  attachmentId: string,
  projectId: string,
) {
  return tx.attachment.update({
    where: { id: attachmentId },
    data: {
      status: "READY",
      url: projectAttachmentContentUrl(projectId, attachmentId),
    },
  });
}

/**
 * 从 buffer 直接创建并就位一个私有项目附件（页面上传路径）。
 * 校验由调用方完成（validateAgentAttachmentPayload）；此处负责落盘与状态机。
 */
export async function createPrivateProjectAttachmentFromBuffer(opts: {
  projectId: string;
  filename: string;
  mimeType: string;
  size: number;
  ext: string;
  buffer: Buffer;
  source: ProjectAttachmentSource;
}) {
  const attachment = await prisma.$transaction((tx) =>
    createPendingPrivateAttachment(tx, {
      projectId: opts.projectId,
      filename: opts.filename,
      mimeType: opts.mimeType,
      size: opts.size,
      ext: opts.ext,
      source: opts.source,
    }),
  );

  try {
    await writePrivateAttachmentFile({ storageKey: attachment.storageKey!, buffer: opts.buffer });
  } catch (err) {
    // 落盘失败：标 FAILED，保留行供审计/重试，绝不泄露为可下载。
    await prisma.attachment
      .update({ where: { id: attachment.id }, data: { status: "FAILED" } })
      .catch(() => undefined);
    throw err;
  }

  return prisma.$transaction((tx) => markAttachmentReady(tx, attachment.id, opts.projectId));
}

/** 读取私有附件 buffer（内容端点调用前必须先做项目权限检查）。 */
export async function readOwnedReadyAttachment(opts: {
  projectId: string;
  attachmentId: string;
}): Promise<{ filename: string; mimeType: string; buffer: Buffer; isPrivate: boolean; url: string }> {
  const attachment = await prisma.attachment.findFirst({
    where: {
      id: opts.attachmentId,
      projectId: opts.projectId,
      ...ATTACHMENT_READY_FILTER,
    },
  });
  if (!attachment) {
    throw new StagingError("ATTACHMENT_NOT_FOUND", "附件不存在或尚未就绪", 404);
  }

  // 历史 public 附件：保持原 url 行为（静态文件），不由本端点代理。
  if (!attachment.isPrivate) {
    throw new StagingError("ATTACHMENT_PUBLIC_LEGACY", "历史公开附件请通过原 URL 访问", 400);
  }
  if (!attachment.storageKey) {
    throw new StagingError("ATTACHMENT_NOT_FOUND", "私有附件缺少存储键", 404);
  }

  const buffer = await readProjectAttachmentBuffer(attachment.storageKey);
  return {
    filename: attachment.filename,
    mimeType: attachment.mimeType,
    buffer,
    isPrivate: attachment.isPrivate,
    url: attachment.url,
  };
}

/**
 * 崩溃恢复：处理卡在 PENDING_FILE 的项目附件。
 * - 文件已就位（rename 后崩溃）→ 标 READY；
 * - 关联 route 且仍 PROCESSING → 交由 route 恢复（跳过）；
 * - 无 route 且文件缺失（rename 前崩溃）→ 标 FAILED。
 */
export async function resumePendingPrivateAttachments(limit = 50): Promise<{ ready: number; failed: number }> {
  const pending = await prisma.attachment.findMany({
    where: { status: "PENDING_FILE", isPrivate: true },
    take: limit,
    select: { id: true, projectId: true, storageKey: true, agentAttachmentRouteId: true },
  });

  let ready = 0;
  let failed = 0;
  for (const row of pending) {
    if (row.agentAttachmentRouteId) {
      // 有 route 的提升任务由 resumePendingAgentAttachmentRoutes 统一续接。
      continue;
    }
    let fileOk = false;
    if (row.storageKey) {
      try {
        await readProjectAttachmentBuffer(row.storageKey);
        fileOk = true;
      } catch {
        fileOk = false;
      }
    }
    if (fileOk) {
      await prisma.$transaction((tx) => markAttachmentReady(tx, row.id, row.projectId));
      ready += 1;
    } else {
      await prisma.attachment.update({ where: { id: row.id }, data: { status: "FAILED" } });
      if (row.storageKey) await deleteProjectAttachmentQuietly(row.storageKey);
      failed += 1;
    }
  }
  return { ready, failed };
}

export function extFromFileName(filename: string): string {
  return path.extname(filename || "").toLowerCase();
}

/**
 * 附件路由恢复所需的目的地附件状态读取（T9.1a：收敛 agent-attachments/routes 的业务模型直连）。
 * 字段集与原直连查询逐字一致：id/projectId/status/storageKey。
 */
export async function getAttachmentForRouteResume(attachmentId: string) {
  return prisma.attachment.findUnique({
    where: { id: attachmentId },
    select: { id: true, projectId: true, status: true, storageKey: true },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 归档（软删）与永久删除（canonical service）。
//
// 设计要点（三审 P1 durability/TOCTOU）：
//  - 归档/恢复：canManage（ADMIN 或 OWNER）；actor 传入；写事务内用 tx 复验权限。
//  - 永久删除：仅 ADMIN，且必须先归档（两阶段保护）。
//  - 历史 public→private 迁移（MIGRATING 状态机，可恢复）：
//      1) 事务内复验权限并 claim：status=MIGRATING + 持久化目标 storageKey（url 仍指向 public）；
//      2) 事务外：确保私有副本存在 → 删 public 原文件；
//      3) 事务内切换 isPrivate/url/status=READY。
//    崩溃窗口由 resumeMigratingAttachments 续接；unlink 失败不清理私有副本（DB 已记 storageKey）。
//  - PURGING：严格删文件；失败保留行；resumePurgingAttachments 机会式恢复。
//  - 审计：永久删除不抹除 FILE_UPLOADED，只追加 ATTACHMENT_DELETED。
// ─────────────────────────────────────────────────────────────────────────────

/** 权限校验 helper：canManage 断言；可选传入 TransactionClient 做写事务内 TOCTOU 复验。 */
export async function assertCanManageAttachment(opts: {
  projectId: string;
  userId: string;
  role: string;
  requireAdmin?: boolean;
  db?: DbLike;
}): Promise<void> {
  // 延迟 import 避免循环依赖（permissions → prisma ← 本模块）。
  const { canManageProject } = await import("@/lib/permissions");
  if (opts.requireAdmin) {
    if (opts.role !== "ADMIN") {
      throw new ForbiddenError("永久删除附件需要管理员权限");
    }
    return;
  }
  const ok = await canManageProject(opts.projectId, opts.userId, opts.role, opts.db ?? prisma);
  if (!ok) throw new ForbiddenError("无权管理该项目附件");
}

/**
 * 把历史 public URL（`/uploads/...`）解析为 public/uploads 下的绝对真实路径。
 * - 字符串层：拒绝路径穿越、URL 编码、反斜杠、NUL、空段与 `..`
 * - 文件系统层：lstat 拒绝 symlink；realpath 后再断言仍位于 uploads 根内；必须是普通文件
 * - allowMissing：文件不存在时返回逻辑绝对路径（供 unlink 重试；仍拒绝 symlink）
 */
export async function resolveLegacyPublicUploadPath(
  publicUrl: string,
  opts?: { allowMissing?: boolean },
): Promise<string> {
  if (typeof publicUrl !== "string" || !publicUrl.startsWith("/uploads/")) {
    throw new ValidationError(`历史附件 url 格式无法迁移: ${publicUrl}`);
  }
  // Fail-closed：拒绝任何百分号编码 / 反斜杠 / NUL（避免 %2f、%2e%2e 等逃逸变体）。
  if (publicUrl.includes("%") || publicUrl.includes("\\") || publicUrl.includes("\0")) {
    throw new ValidationError(`历史附件 url 含非法路径字符: ${publicUrl}`);
  }
  const relative = publicUrl.slice(1); // "uploads/..."
  const parts = relative.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) {
    throw new ValidationError(`历史附件 url 含非法路径段: ${publicUrl}`);
  }

  const uploadsRoot = path.resolve(process.cwd(), "public", "uploads");
  const absolute = path.resolve(process.cwd(), "public", relative);
  const rootWithSep = uploadsRoot.endsWith(path.sep) ? uploadsRoot : `${uploadsRoot}${path.sep}`;
  if (absolute !== uploadsRoot && !absolute.startsWith(rootWithSep)) {
    throw new ValidationError(`历史附件路径越界: ${publicUrl}`);
  }

  let st: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    st = await fs.lstat(absolute);
  } catch {
    if (opts?.allowMissing) return absolute;
    throw new ValidationError(`历史附件原文件不存在，无法迁移: ${absolute}`);
  }
  if (st.isSymbolicLink()) {
    throw new ValidationError(`历史附件路径是符号链接，拒绝迁移: ${publicUrl}`);
  }
  if (!st.isFile()) {
    throw new ValidationError(`历史附件不是普通文件，无法迁移: ${publicUrl}`);
  }

  // realpath 后再断言（防御 TOCTOU / 目录 symlink 等）；uploads 根本身也可能是 symlink。
  let realFile: string;
  let realUploadsRoot: string;
  try {
    realFile = await fs.realpath(absolute);
    realUploadsRoot = await fs.realpath(uploadsRoot);
  } catch {
    throw new ValidationError(`历史附件路径无法解析: ${publicUrl}`);
  }
  const realRootWithSep = realUploadsRoot.endsWith(path.sep)
    ? realUploadsRoot
    : `${realUploadsRoot}${path.sep}`;
  if (realFile !== realUploadsRoot && !realFile.startsWith(realRootWithSep)) {
    throw new ValidationError(`历史附件 realpath 越界: ${publicUrl}`);
  }
  return realFile;
}

type MigrationClaim = {
  attachmentId: string;
  projectId: string;
  storageKey: string;
  publicUrl: string;
  filename: string;
};

/**
 * 事务内占用历史 public 附件为 MIGRATING，并持久化目标 storageKey。
 * - 已私有且 READY：返回 null（no-op）。
 * - 已是 MIGRATING 且有 storageKey：复用（崩溃恢复续接）。
 * - 否则：生成 storageKey，写入 status=MIGRATING（url 仍为 public，便于恢复时回读）。
 */
async function claimPublicAttachmentMigration(
  tx: Prisma.TransactionClient,
  opts: { attachmentId: string; projectId: string },
): Promise<MigrationClaim | null> {
  const attachment = await tx.attachment.findFirst({
    where: { id: opts.attachmentId, projectId: opts.projectId },
    select: {
      id: true,
      url: true,
      isPrivate: true,
      filename: true,
      status: true,
      storageKey: true,
    },
  });
  if (!attachment) throw new NotFoundError("附件不存在");

  if (attachment.isPrivate && attachment.status === "READY") return null;
  if (attachment.isPrivate && attachment.status !== "MIGRATING") return null;

  if (attachment.status === "MIGRATING" && attachment.storageKey) {
    return {
      attachmentId: attachment.id,
      projectId: opts.projectId,
      storageKey: attachment.storageKey,
      publicUrl: attachment.url,
      filename: attachment.filename,
    };
  }

  if (attachment.isPrivate) {
    // isPrivate 但缺 storageKey 的异常态：无法迁移。
    throw new ValidationError("附件状态异常，无法迁移");
  }

  if (attachment.status === "PURGING" || attachment.status === "PENDING_FILE" || attachment.status === "FAILED") {
    throw new ValidationError(`附件状态 ${attachment.status} 不允许迁移`);
  }

  const ext = path.extname(attachment.filename || attachment.url).toLowerCase();
  const storageKey = projectAttachmentStorageKey(opts.projectId, ext, ATTACHMENT_ALLOWED_EXT);
  await tx.attachment.update({
    where: { id: attachment.id },
    data: { status: "MIGRATING", storageKey },
  });
  return {
    attachmentId: attachment.id,
    projectId: opts.projectId,
    storageKey,
    publicUrl: attachment.url,
    filename: attachment.filename,
  };
}

/**
 * 迁移文件步骤（事务外）：确保私有副本存在，再删 public 原文件。
 * - 私有已就位（崩溃在 unlink 后 / 重试）：跳过 copy。
 * - public unlink 失败：抛错并保留 MIGRATING+storageKey（不 quiet 删私有副本）。
 */
async function runMigrationFileSteps(claim: MigrationClaim): Promise<void> {
  // MIGRATING 期间 url 可能仍是 public，也可能已被并发改写；优先用 claim.publicUrl。
  let privateOk = false;
  try {
    await readProjectAttachmentBuffer(claim.storageKey);
    privateOk = true;
  } catch {
    privateOk = false;
  }

  if (!privateOk) {
    // 需要从 public 读取：路径必须存在且为普通文件（拒 symlink）。
    const physicalPath = await resolveLegacyPublicUploadPath(claim.publicUrl);
    let buffer: Buffer;
    try {
      buffer = await fs.readFile(physicalPath);
    } catch (err) {
      if (err instanceof ValidationError) throw err;
      throw new ValidationError(`历史附件原文件不存在，无法迁移: ${physicalPath}`);
    }
    await atomicCopyIntoProjectRoot({ sourceBuffer: buffer, destStorageKey: claim.storageKey });
  }

  // 私有已就位后清理 public（允许 missing；仍拒 symlink）。
  if (claim.publicUrl.startsWith("/uploads/")) {
    const physicalPath = await resolveLegacyPublicUploadPath(claim.publicUrl, { allowMissing: true });
    try {
      await fs.unlink(physicalPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
        // 保留 MIGRATING + 私有副本（storageKey 已在 DB），供 resume 重试 unlink。
        throw new ValidationError(
          `历史附件 public 原文件删除失败，迁移中止（可重试）: ${(err as Error).message}`,
        );
      }
    }
  }
}

/** 事务内把 MIGRATING 切到私有 READY。 */
async function completePublicAttachmentMigration(
  tx: Prisma.TransactionClient,
  opts: { attachmentId: string; projectId: string },
): Promise<void> {
  const updated = await tx.attachment.updateMany({
    where: { id: opts.attachmentId, projectId: opts.projectId, status: "MIGRATING" },
    data: {
      isPrivate: true,
      url: projectAttachmentContentUrl(opts.projectId, opts.attachmentId),
      status: "READY",
      source: "PROJECT_UI",
    },
  });
  if (updated.count === 0) {
    // 可能已被并发 complete；若已是私有 READY 则 ok。
    const row = await tx.attachment.findFirst({
      where: { id: opts.attachmentId, projectId: opts.projectId },
      select: { isPrivate: true, status: true },
    });
    if (!row?.isPrivate || row.status !== "READY") {
      throw new ConflictError("附件迁移状态已变化，请重试");
    }
  }
}

/**
 * 归档/恢复附件（软删）。
 * 幂等：状态未变时不重复写日志。写 ATTACHMENT_ARCHIVED / ATTACHMENT_RESTORED ActivityLog。
 * 归档历史 public 附件：在**同一事务**内复验权限并 claim MIGRATING，再执行文件步骤与最终提交。
 */
export async function setAttachmentArchived(opts: {
  projectId: string;
  attachmentId: string;
  archived: boolean;
  actorUserId: string;
  actorRole: string;
}) {
  type Phase1 =
    | { kind: "noop"; id: string; archived: boolean }
    | { kind: "done"; id: string; archived: boolean; archivedAt: Date | null }
    | { kind: "migrate"; claim: MigrationClaim; filename: string };

  const phase1 = await prisma.$transaction(async (tx): Promise<Phase1> => {
    await assertCanManageAttachment({
      projectId: opts.projectId,
      userId: opts.actorUserId,
      role: opts.actorRole,
      db: tx,
    });

    const attachment = await tx.attachment.findFirst({
      where: { id: opts.attachmentId, projectId: opts.projectId },
      select: { id: true, filename: true, archived: true, status: true, isPrivate: true },
    });
    if (!attachment) throw new NotFoundError("附件不存在");

    if (attachment.archived === opts.archived) {
      return { kind: "noop", id: attachment.id, archived: attachment.archived };
    }

    // 归档历史 public：先占用 MIGRATING（权限已在本事务复验），文件步骤在事务外。
    if (opts.archived && !attachment.isPrivate) {
      const claim = await claimPublicAttachmentMigration(tx, {
        attachmentId: opts.attachmentId,
        projectId: opts.projectId,
      });
      if (!claim) {
        // 竞态下已变私有：直接归档。
        const a = await tx.attachment.update({
          where: { id: opts.attachmentId },
          data: { archived: true, archivedAt: new Date() },
          select: { id: true, archived: true, archivedAt: true },
        });
        await tx.activityLog.create({
          data: {
            type: "ATTACHMENT_ARCHIVED",
            content: `归档了文件 "${attachment.filename}"`,
            metadata: JSON.stringify({ attachmentId: attachment.id, filename: attachment.filename }),
            projectId: opts.projectId,
            userId: opts.actorUserId,
          },
        });
        return { kind: "done", ...a };
      }
      return { kind: "migrate", claim, filename: attachment.filename };
    }

    const a = await tx.attachment.update({
      where: { id: opts.attachmentId },
      data: { archived: opts.archived, archivedAt: opts.archived ? new Date() : null },
      select: { id: true, archived: true, archivedAt: true },
    });
    await tx.activityLog.create({
      data: {
        type: opts.archived ? "ATTACHMENT_ARCHIVED" : "ATTACHMENT_RESTORED",
        content: opts.archived
          ? `归档了文件 "${attachment.filename}"`
          : `恢复了文件 "${attachment.filename}"`,
        metadata: JSON.stringify({ attachmentId: attachment.id, filename: attachment.filename }),
        projectId: opts.projectId,
        userId: opts.actorUserId,
      },
    });
    return { kind: "done", ...a };
  });

  if (phase1.kind === "noop") {
    return { id: phase1.id, archived: phase1.archived };
  }
  if (phase1.kind === "done") {
    return { id: phase1.id, archived: phase1.archived, archivedAt: phase1.archivedAt };
  }

  // 事务外文件步骤；失败保留 MIGRATING 供 resume。
  await runMigrationFileSteps(phase1.claim);

  // 先完成迁移（durability，不与权限失败捆绑回滚），再事务内复验权限并归档。
  await prisma.$transaction(async (tx) => {
    await completePublicAttachmentMigration(tx, {
      attachmentId: opts.attachmentId,
      projectId: opts.projectId,
    });
  });

  return prisma.$transaction(async (tx) => {
    await assertCanManageAttachment({
      projectId: opts.projectId,
      userId: opts.actorUserId,
      role: opts.actorRole,
      db: tx,
    });
    const a = await tx.attachment.update({
      where: { id: opts.attachmentId },
      data: { archived: true, archivedAt: new Date() },
      select: { id: true, archived: true, archivedAt: true },
    });
    await tx.activityLog.create({
      data: {
        type: "ATTACHMENT_ARCHIVED",
        content: `归档了文件 "${phase1.filename}"`,
        metadata: JSON.stringify({ attachmentId: opts.attachmentId, filename: phase1.filename }),
        projectId: opts.projectId,
        userId: opts.actorUserId,
      },
    });
    return a;
  });
}

/**
 * 把历史 public 附件（isPrivate=false）迁移到私有存储（MIGRATING 状态机）。
 * 不包含权限检查（由调用方在 claim 前/同事务复验）；崩溃可由 resumeMigratingAttachments 续接。
 */
export async function migratePublicAttachmentToPrivate(opts: {
  attachmentId: string;
  projectId: string;
}): Promise<void> {
  const claim = await prisma.$transaction((tx) =>
    claimPublicAttachmentMigration(tx, opts),
  );
  if (!claim) return;

  await runMigrationFileSteps(claim);

  await prisma.$transaction(async (tx) => {
    await completePublicAttachmentMigration(tx, opts);
  });
}

/**
 * 崩溃恢复：处理卡在 MIGRATING 的历史 public→private 迁移。
 * - 有 storageKey：续接文件步骤 → complete 到 READY 私有。
 * - 缺 storageKey：标 FAILED（不可自动恢复）。
 * @param projectId 可选，限定到单个项目（项目页机会式恢复）。
 */
export async function resumeMigratingAttachments(
  limit = 50,
  projectId?: string,
): Promise<{ migrated: number; failed: number }> {
  const rows = await prisma.attachment.findMany({
    where: {
      status: "MIGRATING",
      ...(projectId ? { projectId } : {}),
    },
    take: limit,
    select: { id: true, projectId: true, filename: true, storageKey: true, url: true },
  });

  let migrated = 0;
  let failed = 0;
  for (const row of rows) {
    if (!row.storageKey) {
      await prisma.attachment.update({ where: { id: row.id }, data: { status: "FAILED" } }).catch(() => undefined);
      failed += 1;
      continue;
    }
    try {
      // complete 后 url 已是受控端点时，resume 不应再按 public 解析。
      // MIGRATING 期间约定 url 仍为原 public；若已被改写则仅确保私有文件存在后 complete。
      const stillPublic = row.url.startsWith("/uploads/");
      if (stillPublic) {
        await runMigrationFileSteps({
          attachmentId: row.id,
          projectId: row.projectId,
          storageKey: row.storageKey,
          publicUrl: row.url,
          filename: row.filename,
        });
      } else {
        // url 已非 public：只要求私有文件就位。
        try {
          await readProjectAttachmentBuffer(row.storageKey);
        } catch {
          throw new ValidationError(`MIGRATING 附件私有文件缺失且无 public 源: ${row.id}`);
        }
      }
      await prisma.$transaction(async (tx) => {
        await completePublicAttachmentMigration(tx, {
          attachmentId: row.id,
          projectId: row.projectId,
        });
      });
      migrated += 1;
    } catch (err) {
      console.warn(
        `[project-attachments] resume MIGRATING failed id=${row.id}:`,
        (err as Error).message,
      );
      failed += 1;
    }
  }
  return { migrated, failed };
}

/**
 * 机会式附件维护：续接 MIGRATING + PURGING。
 * 由 reminder 扫描、项目 archived 列表、agent attachments GET 调用。
 */
export async function resumeAttachmentMaintenance(opts?: {
  projectId?: string;
  limit?: number;
}): Promise<{
  migrating: { migrated: number; failed: number };
  purging: { purged: number; failed: number };
}> {
  const limit = opts?.limit ?? 50;
  const [migrating, purging] = await Promise.all([
    resumeMigratingAttachments(limit, opts?.projectId),
    resumePurgingAttachments(limit, opts?.projectId),
  ]);
  return { migrating, purging };
}

/**
 * 管理者可见的迁移中间态（active / archived 列表都不展示 MIGRATING）。
 * 只返回 MIGRATING：普通上传 FAILED 留给 resumePendingPrivateAttachments，不混入「重试迁移」。
 */
export async function listPendingMigrationAttachments(projectId: string) {
  return prisma.attachment.findMany({
    where: { projectId, status: "MIGRATING" },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      filename: true,
      url: true,
      size: true,
      mimeType: true,
      status: true,
      isPrivate: true,
      storageKey: true,
      createdAt: true,
      archived: true,
    },
  });
}

/**
 * 查询引用某附件的备注列表（永久删除前置检查）。
 * 返回 { noteId, preview, createdAt }[]。
 */
export async function findNotesReferencingAttachment(attachmentId: string) {
  const links = await prisma.projectNoteAttachment.findMany({
    where: { attachmentId },
    include: { note: { select: { id: true, content: true, createdAt: true } } },
  });
  return links.map((l) => ({
    noteId: l.note.id,
    preview: l.note.content.slice(0, 120),
    createdAt: l.note.createdAt,
  }));
}

/**
 * 永久删除附件（两阶段：必须先归档）。
 *
 * 流程（PURGING 状态机，可恢复）：
 *   1. 前置：role=ADMIN（事务内复验）；附件必须 archived=true；可选 force 处理备注引用。
 *   2. 历史 public 附件先走 MIGRATING 迁移到私有（统一删除链路，避免假删除）。
 *   3. 事务内标 status=PURGING。
 *   4. 事务外严格删私有文件（仅 ENOENT 成功）；失败则保留 PURGING 行，不删 DB。
 *   5. 删文件成功后：事务内删 Attachment 行（级联删 noteLinks）+ 写一次 ATTACHMENT_DELETED。
 *
 * 崩溃恢复：resumePurgingAttachments() / resumeMigratingAttachments() 由附件恢复入口机会式重试。
 * 审计：保留 FILE_UPLOADED 日志（不抹除上传历史），只在真正删行时追加删除日志。
 *
 * @throws ConflictError 附件被备注引用且未 force（code=ATTACHMENT_REFERENCED_BY_NOTES）
 * @throws ValidationError 附件未归档（两阶段保护）
 * @throws ForbiddenError 非 ADMIN
 */
export async function permanentlyDeleteAttachment(opts: {
  projectId: string;
  attachmentId: string;
  actorUserId: string;
  actorRole: string;
  force?: boolean;
}): Promise<{ referencingNotes?: Array<{ noteId: string; preview: string; createdAt: Date }> }> {
  await assertCanManageAttachment({
    projectId: opts.projectId,
    userId: opts.actorUserId,
    role: opts.actorRole,
    requireAdmin: true,
  });

  const attachment = await prisma.attachment.findFirst({
    where: { id: opts.attachmentId, projectId: opts.projectId },
    select: {
      id: true,
      filename: true,
      storageKey: true,
      isPrivate: true,
      archived: true,
      mimeType: true,
      size: true,
      status: true,
    },
  });
  if (!attachment) throw new NotFoundError("附件不存在");

  if (!attachment.archived) {
    throw new ValidationError("永久删除前必须先归档该附件");
  }

  const referencingNotes = await findNotesReferencingAttachment(opts.attachmentId);
  if (referencingNotes.length > 0 && !opts.force) {
    const err = new ConflictError("附件被项目备注引用，无法直接删除");
    (err as Error & { code?: string; referencingNotes?: unknown[] }).code = "ATTACHMENT_REFERENCED_BY_NOTES";
    (err as Error & { referencingNotes?: unknown[] }).referencingNotes = referencingNotes;
    throw err;
  }

  // 历史 public 或卡在 MIGRATING：先完成迁移。
  if (!attachment.isPrivate || attachment.status === "MIGRATING") {
    await migratePublicAttachmentToPrivate({
      attachmentId: opts.attachmentId,
      projectId: opts.projectId,
    });
  }

  const refreshed = await prisma.attachment.findUniqueOrThrow({
    where: { id: opts.attachmentId },
    select: { storageKey: true },
  });

  await prisma.$transaction(async (tx) => {
    await assertCanManageAttachment({
      projectId: opts.projectId,
      userId: opts.actorUserId,
      role: opts.actorRole,
      requireAdmin: true,
      db: tx,
    });
    await tx.attachment.update({
      where: { id: opts.attachmentId },
      data: { status: "PURGING" },
    });
  });

  if (refreshed.storageKey) {
    try {
      await deleteProjectAttachmentStrict(refreshed.storageKey);
    } catch (err) {
      console.error(
        `[project-attachments] strict delete failed, keeping PURGING id=${opts.attachmentId}:`,
        (err as Error).message,
      );
      throw err;
    }
  }

  await prisma.$transaction(async (tx) => {
    await tx.attachment.delete({ where: { id: opts.attachmentId } });
    await tx.activityLog.create({
      data: {
        type: "ATTACHMENT_DELETED",
        content: `永久删除了文件 "${attachment.filename}"${opts.force && referencingNotes.length > 0 ? `（含 ${referencingNotes.length} 处备注引用）` : ""}`,
        metadata: JSON.stringify({
          filename: attachment.filename,
          mimeType: attachment.mimeType,
          size: attachment.size,
          referencingNoteCount: referencingNotes.length,
        }),
        projectId: opts.projectId,
        userId: opts.actorUserId,
      },
    });
  });

  return {};
}

/**
 * 崩溃恢复：处理卡在 PURGING 的附件（永久删除中途崩溃 / 严格删除失败）。
 * - 严格删文件（仅 ENOENT 成功）；失败则跳过该行，保留 PURGING 待下次重试。
 * - 删文件成功后再删 DB 行 + 写一次删除日志（避免失败重试刷重复审计）。
 * 由 /api/agent/attachments 列表入口机会式触发。
 */
export async function resumePurgingAttachments(
  limit = 50,
  projectId?: string,
): Promise<{ purged: number; failed: number }> {
  const purging = await prisma.attachment.findMany({
    where: {
      status: "PURGING",
      ...(projectId ? { projectId } : {}),
    },
    take: limit,
    select: { id: true, projectId: true, filename: true, storageKey: true, mimeType: true, size: true },
  });

  let purged = 0;
  let failed = 0;
  for (const row of purging) {
    if (row.storageKey) {
      try {
        await deleteProjectAttachmentStrict(row.storageKey);
      } catch (err) {
        console.warn(
          `[project-attachments] resume PURGING delete failed id=${row.id}:`,
          (err as Error).message,
        );
        failed += 1;
        continue;
      }
    }

    try {
      await prisma.$transaction(async (tx) => {
        const still = await tx.attachment.findFirst({
          where: { id: row.id, status: "PURGING" },
          select: { id: true },
        });
        if (!still) return;
        await tx.attachment.delete({ where: { id: row.id } });
        await tx.activityLog.create({
          data: {
            type: "ATTACHMENT_DELETED",
            content: `永久删除了文件 "${row.filename}"（崩溃恢复）`,
            metadata: JSON.stringify({
              filename: row.filename,
              mimeType: row.mimeType,
              size: row.size,
              recovered: true,
            }),
            projectId: row.projectId,
            userId: null,
          },
        });
      });
      purged += 1;
    } catch (err) {
      console.warn(
        `[project-attachments] resume PURGING db cleanup failed id=${row.id}:`,
        (err as Error).message,
      );
      failed += 1;
    }
  }
  return { purged, failed };
}

/**
 * 查询项目已归档附件（管理者「已归档」视图用）。
 * 只返回 status=READY 且 archived=true 的项（PENDING_FILE/FAILED/PURGING/MIGRATING 不展示）。
 */
export async function listArchivedAttachments(projectId: string) {
  return prisma.attachment.findMany({
    where: { projectId, status: "READY", archived: true },
    orderBy: { archivedAt: "desc" },
    select: {
      id: true,
      filename: true,
      url: true,
      size: true,
      mimeType: true,
      archivedAt: true,
      createdAt: true,
    },
  });
}

// getAgentProjectAttachmentRoot 重新导出（迁移逻辑测试可能需要）。
export { getAgentProjectAttachmentRoot };

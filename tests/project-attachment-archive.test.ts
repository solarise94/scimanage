/**
 * 项目附件归档（软删）与永久删除 — 真实路由 + service 级 P0 回归。
 *
 * 注意：本文件只用一个 withTempSmokeDb（Prisma 单例在 ESM 下二次创建无法换绑）。
 */
import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { withTempSmokeDb } from "../scripts/lib/temp-smoke-db";

type SessionUser = { id: string; role: string; name: string; email: string };
type MockSession = { user: SessionUser };
const sessionState = vi.hoisted(() => ({ current: null as MockSession | null }));

vi.mock("next-auth/next", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getServerSession: async () => sessionState.current,
}));
vi.mock("next-auth", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getServerSession: async () => sessionState.current,
}));

describe("project attachment archive + delete (P0/P1)", () => {
  const origStaging = process.env.AGENT_ATTACHMENT_STAGING_DIR;
  const origProject = process.env.AGENT_PROJECT_ATTACHMENT_DIR;
  let tempStorageRoot: string | null = null;

  afterEach(async () => {
    sessionState.current = null;
    vi.restoreAllMocks();
    if (origStaging === undefined) delete process.env.AGENT_ATTACHMENT_STAGING_DIR;
    else process.env.AGENT_ATTACHMENT_STAGING_DIR = origStaging;
    if (origProject === undefined) delete process.env.AGENT_PROJECT_ATTACHMENT_DIR;
    else process.env.AGENT_PROJECT_ATTACHMENT_DIR = origProject;
    if (tempStorageRoot) {
      await fs.rm(tempStorageRoot, { recursive: true, force: true }).catch(() => undefined);
      tempStorageRoot = null;
    }
  });

  async function useIsolatedStorageDirs(): Promise<void> {
    tempStorageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "scimanage-att-route-"));
    const stagingRoot = path.join(tempStorageRoot, "staging");
    const projectRoot = path.join(tempStorageRoot, "project");
    await fs.mkdir(stagingRoot, { recursive: true });
    await fs.mkdir(projectRoot, { recursive: true });
    process.env.AGENT_ATTACHMENT_STAGING_DIR = stagingRoot;
    process.env.AGENT_PROJECT_ATTACHMENT_DIR = projectRoot;
  }

  function asSession(user: SessionUser) {
    sessionState.current = { user };
  }

  function patchReq(projectId: string, attachmentId: string, archived: boolean) {
    return new NextRequest(`http://localhost/api/projects/${projectId}/attachments/${attachmentId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived }),
    });
  }

  function deleteReq(projectId: string, attachmentId: string, force = false) {
    const url = new URL(`http://localhost/api/projects/${projectId}/attachments/${attachmentId}`);
    if (force) url.searchParams.set("force", "true");
    return new NextRequest(url, { method: "DELETE" });
  }

  async function jsonBody(res: Response): Promise<Record<string, unknown>> {
    return (await res.json().catch(() => ({}))) as Record<string, unknown>;
  }

  it("归档删除 + 路径穿越 + MIGRATING 崩溃恢复 + 撤权 TOCTOU + PURGING 严格删除", async () => {
    await withTempSmokeDb(async () => {
      await useIsolatedStorageDirs();
      const { prisma } = await import("@/lib/prisma");
      const { hashSync } = await import("bcryptjs");
      const {
        createPrivateProjectAttachmentFromBuffer,
        resolveLegacyPublicUploadPath,
        migratePublicAttachmentToPrivate,
        setAttachmentArchived,
        permanentlyDeleteAttachment,
        resumePurgingAttachments,
        resumeMigratingAttachments,
      } = await import("@/lib/projects/application/project-attachments");
      const { getAgentProjectAttachmentRoot, atomicCopyIntoProjectRoot, projectAttachmentStorageKey } =
        await import("@/lib/agent-attachments/storage");
      const { ValidationError, ForbiddenError } = await import("@/lib/application/errors");
      const { ATTACHMENT_ALLOWED_EXT } = await import("@/lib/agent-attachments/constants");
      const fsSync = await import("node:fs");

      // ── 0. 恶意 legacy URL 路径安全 + symlink 拒绝 ──
      const malicious = [
        "/uploads/../../.env",
        "/uploads/foo/../../../.env",
        "/uploads/%2e%2e/%2e%2e/.env",
        "/uploads/foo%2f..%2f..%2f.env",
        "/uploads/foo\\..\\..\\.env",
        "/uploads/foo//bar.pdf",
        "/uploads/./secret.pdf",
      ];
      for (const url of malicious) {
        await expect(resolveLegacyPublicUploadPath(url), url).rejects.toBeInstanceOf(ValidationError);
      }
      const okPath = await resolveLegacyPublicUploadPath("/uploads/test-att-route/ok.pdf", {
        allowMissing: true,
      });
      const uploadsRoot = path.resolve(process.cwd(), "public", "uploads");
      expect(okPath.startsWith(uploadsRoot + path.sep) || okPath === uploadsRoot).toBe(true);
      // 旧 path.join 实现会逃逸到仓库根 .env
      expect(path.join(process.cwd(), "public", "/uploads/../../.env")).toBe(
        path.join(process.cwd(), ".env"),
      );

      // symlink 指向 uploads 外普通文件：lstat 拒绝（stat 会误判为普通文件）
      const symlinkDir = path.join(process.cwd(), "public", "uploads", "test-att-symlink");
      await fs.mkdir(symlinkDir, { recursive: true });
      const outsideTarget = path.join(os.tmpdir(), `att-outside-${Date.now()}.pdf`);
      await fs.writeFile(outsideTarget, Buffer.from("%PDF-1.4 outside"));
      await fs.symlink(outsideTarget, path.join(symlinkDir, "linked.pdf"));
      await expect(
        resolveLegacyPublicUploadPath("/uploads/test-att-symlink/linked.pdf"),
      ).rejects.toBeInstanceOf(ValidationError);
      await fs.rm(symlinkDir, { recursive: true, force: true }).catch(() => undefined);
      await fs.unlink(outsideTarget).catch(() => undefined);

      const admin = await prisma.user.create({
        data: { email: "att-admin@example.com", name: "Admin", password: hashSync("x", 10), role: "ADMIN" },
      });
      const owner = await prisma.user.create({
        data: { email: "att-owner@example.com", name: "Owner", password: hashSync("x", 10), role: "USER" },
      });
      const outsider = await prisma.user.create({
        data: { email: "att-out@example.com", name: "Outsider", password: hashSync("x", 10), role: "USER" },
      });
      const project = await prisma.project.create({
        data: {
          name: "附件路由测试",
          status: "IN_PROGRESS",
          members: { create: { userId: owner.id, role: "OWNER" } },
        },
      });

      const buffer = Buffer.from("%PDF-1.4 route-test");
      const att = await createPrivateProjectAttachmentFromBuffer({
        projectId: project.id,
        filename: "report.pdf",
        mimeType: "application/pdf",
        size: buffer.length,
        ext: ".pdf",
        buffer,
        source: "PROJECT_UI",
      });

      // ── 1. PATCH 归档 ──
      asSession({ id: owner.id, role: "USER", name: "Owner", email: "" });
      const { PATCH } = await import("@/app/api/projects/[id]/attachments/[attachmentId]/route");
      const archiveRes = await PATCH(patchReq(project.id, att.id, true), {
        params: Promise.resolve({ id: project.id, attachmentId: att.id }),
      } as never);
      expect(archiveRes.status, "PATCH 归档应 200").toBe(200);
      const archivedRow = await prisma.attachment.findUniqueOrThrow({ where: { id: att.id } });
      expect(archivedRow.archived).toBe(true);
      expect(archivedRow.archivedAt).not.toBeNull();
      expect(
        await prisma.activityLog.count({ where: { projectId: project.id, type: "ATTACHMENT_ARCHIVED" } }),
      ).toBe(1);

      // ── 2. 局外人 PATCH → 403 ──
      asSession({ id: outsider.id, role: "USER", name: "Outsider", email: "" });
      expect(
        (
          await PATCH(patchReq(project.id, att.id, false), {
            params: Promise.resolve({ id: project.id, attachmentId: att.id }),
          } as never)
        ).status,
      ).toBe(403);

      // ── 3. 未归档 DELETE → 400 ──
      const att2 = await createPrivateProjectAttachmentFromBuffer({
        projectId: project.id,
        filename: "not-archived.pdf",
        mimeType: "application/pdf",
        size: buffer.length,
        ext: ".pdf",
        buffer,
        source: "PROJECT_UI",
      });
      asSession({ id: admin.id, role: "ADMIN", name: "Admin", email: "" });
      const { DELETE } = await import("@/app/api/projects/[id]/attachments/[attachmentId]/route");
      expect(
        (
          await DELETE(deleteReq(project.id, att2.id), {
            params: Promise.resolve({ id: project.id, attachmentId: att2.id }),
          } as never)
        ).status,
      ).toBe(400);

      // ── 4. OWNER DELETE → 403 ──
      await PATCH(patchReq(project.id, att2.id, true), {
        params: Promise.resolve({ id: project.id, attachmentId: att2.id }),
      } as never);
      asSession({ id: owner.id, role: "USER", name: "Owner", email: "" });
      expect(
        (
          await DELETE(deleteReq(project.id, att2.id), {
            params: Promise.resolve({ id: project.id, attachmentId: att2.id }),
          } as never)
        ).status,
      ).toBe(403);

      // ── 5. 备注引用 409 ──
      asSession({ id: admin.id, role: "ADMIN", name: "Admin", email: "" });
      const note = await prisma.projectNote.create({
        data: {
          projectId: project.id,
          authorId: owner.id,
          authorNameSnapshot: "Owner",
          content: `参见 [${att.filename}](${att.url})`,
          source: "AGENT",
        },
      });
      await prisma.projectNoteAttachment.create({
        data: { noteId: note.id, attachmentId: att.id, sortOrder: 0 },
      });
      const refRes = await DELETE(deleteReq(project.id, att.id), {
        params: Promise.resolve({ id: project.id, attachmentId: att.id }),
      } as never);
      expect(refRes.status).toBe(409);
      const refBody = await jsonBody(refRes);
      expect(refBody.code).toBe("ATTACHMENT_REFERENCED_BY_NOTES");

      // ── 6. force 删除 ──
      expect(
        (
          await DELETE(deleteReq(project.id, att.id, true), {
            params: Promise.resolve({ id: project.id, attachmentId: att.id }),
          } as never)
        ).status,
      ).toBe(200);
      expect(await prisma.attachment.findUnique({ where: { id: att.id } })).toBeNull();
      expect(fsSync.existsSync(path.join(getAgentProjectAttachmentRoot(), att.storageKey!))).toBe(false);
      expect(
        await prisma.activityLog.count({ where: { projectId: project.id, type: "ATTACHMENT_DELETED" } }),
      ).toBe(1);

      // ── 7. 历史 public：归档前迁移（public 文件消失）──
      const publicDir = path.join(process.cwd(), "public", "uploads", "test-att-route");
      await fs.mkdir(publicDir, { recursive: true });
      const legacyFile = path.join(publicDir, "legacy.pdf");
      await fs.writeFile(legacyFile, Buffer.from("%PDF-1.4 legacy"));
      const legacy = await prisma.attachment.create({
        data: {
          projectId: project.id,
          filename: "legacy.pdf",
          url: "/uploads/test-att-route/legacy.pdf",
          size: 14,
          mimeType: "application/pdf",
          isPrivate: false,
          source: "PROJECT_UI",
          status: "READY",
          archived: false,
        },
      });
      expect(
        (
          await PATCH(patchReq(project.id, legacy.id, true), {
            params: Promise.resolve({ id: project.id, attachmentId: legacy.id }),
          } as never)
        ).status,
      ).toBe(200);
      expect(fsSync.existsSync(legacyFile), "归档后 public 原文件已删").toBe(false);
      const legacyAfter = await prisma.attachment.findUniqueOrThrow({ where: { id: legacy.id } });
      expect(legacyAfter.isPrivate).toBe(true);
      expect(legacyAfter.archived).toBe(true);
      expect(
        (
          await DELETE(deleteReq(project.id, legacy.id, true), {
            params: Promise.resolve({ id: project.id, attachmentId: legacy.id }),
          } as never)
        ).status,
      ).toBe(200);
      await fs.rm(publicDir, { recursive: true, force: true }).catch(() => undefined);

      // ── 8. public unlink 失败 → 保留 MIGRATING+storageKey（不丢私有副本）──
      const unlinkDir = path.join(process.cwd(), "public", "uploads", "test-att-unlink");
      await fs.mkdir(unlinkDir, { recursive: true });
      const stuckFile = path.join(unlinkDir, "stuck.pdf");
      await fs.writeFile(stuckFile, Buffer.from("%PDF-1.4 stuck"));
      const stuck = await prisma.attachment.create({
        data: {
          projectId: project.id,
          filename: "stuck.pdf",
          url: "/uploads/test-att-unlink/stuck.pdf",
          size: 14,
          mimeType: "application/pdf",
          isPrivate: false,
          source: "PROJECT_UI",
          status: "READY",
        },
      });
      await fs.chmod(unlinkDir, 0o555);
      await expect(
        migratePublicAttachmentToPrivate({ attachmentId: stuck.id, projectId: project.id }),
      ).rejects.toBeInstanceOf(ValidationError);
      const stuckAfterFail = await prisma.attachment.findUniqueOrThrow({ where: { id: stuck.id } });
      expect(stuckAfterFail.isPrivate, "unlink 失败仍未切私有").toBe(false);
      expect(stuckAfterFail.status, "已 claim MIGRATING").toBe("MIGRATING");
      expect(stuckAfterFail.storageKey, "目标 storageKey 已持久化").toBeTruthy();
      expect(fsSync.existsSync(stuckFile), "public 仍在").toBe(true);
      expect(
        fsSync.existsSync(path.join(getAgentProjectAttachmentRoot(), stuckAfterFail.storageKey!)),
        "私有副本保留（不 quiet 删）",
      ).toBe(true);
      await expect(
        setAttachmentArchived({
          projectId: project.id,
          attachmentId: stuck.id,
          archived: true,
          actorUserId: owner.id,
          actorRole: "USER",
        }),
      ).rejects.toBeInstanceOf(ValidationError);
      expect((await prisma.attachment.findUniqueOrThrow({ where: { id: stuck.id } })).archived).toBe(false);

      // 恢复写权限后 resume MIGRATING 完成迁移
      await fs.chmod(unlinkDir, 0o755);
      const migResume = await resumeMigratingAttachments();
      expect(migResume.migrated).toBeGreaterThanOrEqual(1);
      const stuckOk = await prisma.attachment.findUniqueOrThrow({ where: { id: stuck.id } });
      expect(stuckOk.isPrivate).toBe(true);
      expect(stuckOk.status).toBe("READY");
      expect(fsSync.existsSync(stuckFile)).toBe(false);
      await fs.rm(unlinkDir, { recursive: true, force: true }).catch(() => undefined);

      // ── 8b. 崩溃窗口：public 已删、DB 仍 MIGRATING → resume 续接 complete ──
      const crashDir = path.join(process.cwd(), "public", "uploads", "test-att-crash");
      await fs.mkdir(crashDir, { recursive: true });
      const crashPublic = path.join(crashDir, "crash.pdf");
      await fs.writeFile(crashPublic, Buffer.from("%PDF-1.4 crash"));
      const crashKey = projectAttachmentStorageKey(project.id, ".pdf", ATTACHMENT_ALLOWED_EXT);
      await atomicCopyIntoProjectRoot({
        sourceBuffer: Buffer.from("%PDF-1.4 crash"),
        destStorageKey: crashKey,
      });
      await fs.unlink(crashPublic); // 模拟 unlink 成功后、DB complete 前崩溃
      const crashAtt = await prisma.attachment.create({
        data: {
          projectId: project.id,
          filename: "crash.pdf",
          url: "/uploads/test-att-crash/crash.pdf",
          size: 14,
          mimeType: "application/pdf",
          isPrivate: false,
          storageKey: crashKey,
          source: "PROJECT_UI",
          status: "MIGRATING",
        },
      });
      const crashResume = await resumeMigratingAttachments();
      expect(crashResume.migrated).toBeGreaterThanOrEqual(1);
      const crashDone = await prisma.attachment.findUniqueOrThrow({ where: { id: crashAtt.id } });
      expect(crashDone.isPrivate).toBe(true);
      expect(crashDone.status).toBe("READY");
      expect(crashDone.url).toContain("/api/projects/");
      await fs.rm(crashDir, { recursive: true, force: true }).catch(() => undefined);

      // ── 8c. 撤权后归档：迁移前事务复验失败，不留下 MIGRATING ──
      const revokeDir = path.join(process.cwd(), "public", "uploads", "test-att-revoke");
      await fs.mkdir(revokeDir, { recursive: true });
      const revokeFile = path.join(revokeDir, "revoke.pdf");
      await fs.writeFile(revokeFile, Buffer.from("%PDF-1.4 revoke"));
      const revokeAtt = await prisma.attachment.create({
        data: {
          projectId: project.id,
          filename: "revoke.pdf",
          url: "/uploads/test-att-revoke/revoke.pdf",
          size: 14,
          mimeType: "application/pdf",
          isPrivate: false,
          source: "PROJECT_UI",
          status: "READY",
        },
      });
      // 撤掉 OWNER 成员资格
      await prisma.projectMember.deleteMany({ where: { projectId: project.id, userId: owner.id } });
      await expect(
        setAttachmentArchived({
          projectId: project.id,
          attachmentId: revokeAtt.id,
          archived: true,
          actorUserId: owner.id,
          actorRole: "USER",
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      const revokeAfter = await prisma.attachment.findUniqueOrThrow({ where: { id: revokeAtt.id } });
      expect(revokeAfter.status, "撤权后未 claim MIGRATING").toBe("READY");
      expect(revokeAfter.isPrivate).toBe(false);
      expect(revokeAfter.storageKey).toBeNull();
      expect(fsSync.existsSync(revokeFile), "public 文件未被动").toBe(true);
      // 恢复 OWNER 供后续用例
      await prisma.projectMember.create({ data: { projectId: project.id, userId: owner.id, role: "OWNER" } });
      await fs.rm(revokeDir, { recursive: true, force: true }).catch(() => undefined);

      // ── 9. 严格删除失败保留 PURGING；resume 失败不删行；成功后删行+一次审计 ──
      const purgeAtt = await createPrivateProjectAttachmentFromBuffer({
        projectId: project.id,
        filename: "purge.pdf",
        mimeType: "application/pdf",
        size: buffer.length,
        ext: ".pdf",
        buffer,
        source: "PROJECT_UI",
      });
      await prisma.attachment.update({
        where: { id: purgeAtt.id },
        data: { archived: true, archivedAt: new Date() },
      });
      const purgePath = path.join(getAgentProjectAttachmentRoot(), purgeAtt.storageKey!);
      const purgeDir = path.dirname(purgePath);
      await fs.chmod(purgeDir, 0o555);
      const deletedBefore = await prisma.activityLog.count({
        where: { projectId: project.id, type: "ATTACHMENT_DELETED" },
      });
      await expect(
        permanentlyDeleteAttachment({
          projectId: project.id,
          attachmentId: purgeAtt.id,
          actorUserId: admin.id,
          actorRole: "ADMIN",
          force: true,
        }),
      ).rejects.toMatchObject({ code: "EACCES" });
      expect((await prisma.attachment.findUniqueOrThrow({ where: { id: purgeAtt.id } })).status).toBe(
        "PURGING",
      );
      expect(
        await prisma.activityLog.count({ where: { projectId: project.id, type: "ATTACHMENT_DELETED" } }),
      ).toBe(deletedBefore);

      const resumeFail = await resumePurgingAttachments();
      expect(resumeFail.purged).toBe(0);
      expect(resumeFail.failed).toBeGreaterThanOrEqual(1);
      expect(await prisma.attachment.findUnique({ where: { id: purgeAtt.id } })).not.toBeNull();

      await fs.chmod(purgeDir, 0o755);
      const resumeOk = await resumePurgingAttachments();
      expect(resumeOk.purged).toBeGreaterThanOrEqual(1);
      expect(await prisma.attachment.findUnique({ where: { id: purgeAtt.id } })).toBeNull();
      expect(
        await prisma.activityLog.count({ where: { projectId: project.id, type: "ATTACHMENT_DELETED" } }),
      ).toBe(deletedBefore + 1);
      expect((await resumePurgingAttachments()).purged).toBe(0);
      expect(
        await prisma.activityLog.count({ where: { projectId: project.id, type: "ATTACHMENT_DELETED" } }),
      ).toBe(deletedBefore + 1);

      // ── 10. 项目 archived GET 真实触发 resume（非源码文本检查）──
      const gateDir = path.join(process.cwd(), "public", "uploads", "test-att-gate");
      await fs.mkdir(gateDir, { recursive: true });
      const gatePublic = path.join(gateDir, "gate.pdf");
      await fs.writeFile(gatePublic, Buffer.from("%PDF-1.4 gate"));
      const gateKey = projectAttachmentStorageKey(project.id, ".pdf", ATTACHMENT_ALLOWED_EXT);
      await atomicCopyIntoProjectRoot({
        sourceBuffer: Buffer.from("%PDF-1.4 gate"),
        destStorageKey: gateKey,
      });
      await fs.unlink(gatePublic);
      const gateAtt = await prisma.attachment.create({
        data: {
          projectId: project.id,
          filename: "gate.pdf",
          url: "/uploads/test-att-gate/gate.pdf",
          size: 14,
          mimeType: "application/pdf",
          isPrivate: false,
          storageKey: gateKey,
          source: "PROJECT_UI",
          status: "MIGRATING",
        },
      });
      asSession({ id: owner.id, role: "USER", name: "Owner", email: "" });
      const { GET: getArchived } = await import(
        "@/app/api/projects/[id]/attachments/archived/route"
      );
      const archivedRes = await getArchived(new Request("http://localhost/archived"), {
        params: Promise.resolve({ id: project.id }),
      } as never);
      expect(archivedRes.status, "archived GET 应 200").toBe(200);
      const archivedBody = (await archivedRes.json()) as {
        attachments: unknown[];
        pendingMigrations: Array<{ id: string; status: string }>;
      };
      expect(Array.isArray(archivedBody.pendingMigrations)).toBe(true);
      const gateDone = await prisma.attachment.findUniqueOrThrow({ where: { id: gateAtt.id } });
      expect(gateDone.status, "archived GET 应续接 MIGRATING→READY").toBe("READY");
      expect(gateDone.isPrivate).toBe(true);
      expect(archivedBody.pendingMigrations.some((p) => p.id === gateAtt.id)).toBe(false);
      await fs.rm(gateDir, { recursive: true, force: true }).catch(() => undefined);

      // reminder / agent 入口也已挂 resumeAttachmentMaintenance
      const reminderSrc = await fs.readFile(
        path.join(process.cwd(), "src/lib/reminder.ts"),
        "utf8",
      );
      expect(reminderSrc).toContain("resumeAttachmentMaintenance");
      const agentAttSrc = await fs.readFile(
        path.join(process.cwd(), "src/app/api/agent/attachments/route.ts"),
        "utf8",
      );
      expect(agentAttSrc).toContain("resumeAttachmentMaintenance");
    });
  });
});

import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { withTempSmokeDb } from "../../../../../scripts/lib/temp-smoke-db";
import { computeSha256 } from "@/lib/staging-common";

/**
 * T3.4: canonical note attachment promote/recover command.
 * All scenarios share one temporary SQLite (withTempSmokeDb must not run in parallel).
 */
describe("T3.4 note attachment promote/recover", () => {
  const origStaging = process.env.AGENT_ATTACHMENT_STAGING_DIR;
  const origProject = process.env.AGENT_PROJECT_ATTACHMENT_DIR;
  let tempStorageRoot: string | null = null;

  afterEach(async () => {
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
    tempStorageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "scimanage-att-promote-"));
    const stagingRoot = path.join(tempStorageRoot, "staging");
    const projectRoot = path.join(tempStorageRoot, "project");
    await fs.mkdir(stagingRoot, { recursive: true });
    await fs.mkdir(projectRoot, { recursive: true });
    process.env.AGENT_ATTACHMENT_STAGING_DIR = stagingRoot;
    process.env.AGENT_PROJECT_ATTACHMENT_DIR = projectRoot;
  }

  it("promote, idempotent recovery, resume sweep, and recoverable failures", async () => {
    await withTempSmokeDb(async () => {
      await useIsolatedStorageDirs();
      const { prisma } = await import("@/lib/prisma");
      const { writeStagingBuffer } = await import("@/lib/agent-attachments/storage");
      const { createPendingPrivateAttachment, markAttachmentReady } = await import(
        "@/lib/projects/application/project-attachments"
      );
      const {
        NoteAttachmentPromoteError,
        promoteProjectNoteAttachment,
      } = await import("@/lib/projects/application/note-attachment-promote");
      const { resumePendingAgentAttachmentRoutes } = await import("@/lib/agent-attachments/routes");

      const user = await prisma.user.create({
        data: { email: "t34-user@example.com", name: "User", password: "h", role: "USER" },
      });
      const project = await prisma.project.create({
        data: {
          name: "附件项目",
          status: "IN_PROGRESS",
          members: { create: { userId: user.id, role: "OWNER" } },
        },
      });

      // ---- successful promote ------------------------------------------------
      const buffer = Buffer.from("hello-note-attachment");
      const sha256 = computeSha256(buffer);
      const storageKey = `${user.id}/note-test.pdf`;
      await writeStagingBuffer(storageKey, buffer);

      const staging = await prisma.agentAttachmentStagingFile.create({
        data: {
          ownerUserId: user.id,
          storageKey,
          originalName: "note-test.pdf",
          mimeType: "application/pdf",
          sizeBytes: buffer.length,
          sha256,
          status: "ANALYZED",
          version: 2,
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        },
      });

      const pending = await prisma.$transaction((tx) =>
        createPendingPrivateAttachment(tx, {
          projectId: project.id,
          filename: "note-test.pdf",
          mimeType: "application/pdf",
          size: buffer.length,
          ext: ".pdf",
          source: "AGENT",
        }),
      );

      const route = await prisma.agentAttachmentRoute.create({
        data: {
          stagingId: staging.id,
          targetType: "PROJECT_NOTE",
          state: "PROCESSING",
          expectedSha256: sha256,
          expectedVersion: 2,
          destinationAttachmentId: pending.id,
        },
      });

      const promoted = await promoteProjectNoteAttachment({
        attachmentId: pending.id,
        projectId: project.id,
        storageKey: pending.storageKey!,
        stagingStorageKey: storageKey,
        routeId: route.id,
        integrity: {
          expectedSha256: sha256,
          expectedVersion: 2,
          stagingSha256: sha256,
          stagingVersion: 2,
        },
      });
      expect(promoted.outcome).toBe("promoted");
      expect(
        (await prisma.attachment.findUniqueOrThrow({ where: { id: pending.id } })).status,
      ).toBe("READY");
      expect(
        (await prisma.agentAttachmentRoute.findUniqueOrThrow({ where: { id: route.id } })).state,
      ).toBe("PROMOTED");

      // ---- idempotent when already READY ------------------------------------
      const idemBuffer = Buffer.from("idem-body");
      const idemSha = computeSha256(idemBuffer);
      const idemKey = `${user.id}/idem.pdf`;
      await writeStagingBuffer(idemKey, idemBuffer);
      const idemStaging = await prisma.agentAttachmentStagingFile.create({
        data: {
          ownerUserId: user.id,
          storageKey: idemKey,
          originalName: "idem.pdf",
          mimeType: "application/pdf",
          sizeBytes: idemBuffer.length,
          sha256: idemSha,
          status: "ANALYZED",
          version: 1,
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        },
      });
      const idemPending = await prisma.$transaction((tx) =>
        createPendingPrivateAttachment(tx, {
          projectId: project.id,
          filename: "idem.pdf",
          mimeType: "application/pdf",
          size: idemBuffer.length,
          ext: ".pdf",
          source: "AGENT",
        }),
      );
      await prisma.$transaction((tx) => markAttachmentReady(tx, idemPending.id, project.id));
      const idemRoute = await prisma.agentAttachmentRoute.create({
        data: {
          stagingId: idemStaging.id,
          targetType: "PROJECT_NOTE",
          state: "PROCESSING",
          expectedSha256: idemSha,
          expectedVersion: 1,
          destinationAttachmentId: idemPending.id,
        },
      });
      const idem = await promoteProjectNoteAttachment({
        attachmentId: idemPending.id,
        projectId: project.id,
        storageKey: idemPending.storageKey!,
        stagingStorageKey: idemKey,
        routeId: idemRoute.id,
        integrity: {
          expectedSha256: idemSha,
          expectedVersion: 1,
          stagingSha256: idemSha,
          stagingVersion: 1,
        },
      });
      expect(idem.outcome).toBe("already_ready");
      expect(
        (await prisma.agentAttachmentRoute.findUniqueOrThrow({ where: { id: idemRoute.id } })).state,
      ).toBe("PROMOTED");

      // ---- resume PENDING_FILE without duplicating --------------------------
      const resumeBuffer = Buffer.from("resume-body");
      const resumeSha = computeSha256(resumeBuffer);
      const resumeKey = `${user.id}/resume.pdf`;
      await writeStagingBuffer(resumeKey, resumeBuffer);
      const resumeStaging = await prisma.agentAttachmentStagingFile.create({
        data: {
          ownerUserId: user.id,
          storageKey: resumeKey,
          originalName: "resume.pdf",
          mimeType: "application/pdf",
          sizeBytes: resumeBuffer.length,
          sha256: resumeSha,
          status: "ANALYZED",
          version: 3,
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        },
      });
      const resumePending = await prisma.$transaction((tx) =>
        createPendingPrivateAttachment(tx, {
          projectId: project.id,
          filename: "resume.pdf",
          mimeType: "application/pdf",
          size: resumeBuffer.length,
          ext: ".pdf",
          source: "AGENT",
        }),
      );
      await prisma.agentAttachmentRoute.create({
        data: {
          stagingId: resumeStaging.id,
          targetType: "PROJECT_NOTE",
          state: "PROCESSING",
          expectedSha256: resumeSha,
          expectedVersion: 3,
          destinationAttachmentId: resumePending.id,
        },
      });
      expect(await resumePendingAgentAttachmentRoutes()).toEqual({ promoted: 1, failed: 0 });
      expect(await resumePendingAgentAttachmentRoutes()).toEqual({ promoted: 0, failed: 0 });

      // ---- integrity failure stays recoverable ------------------------------
      const badBuffer = Buffer.from("bad-hash-body");
      const badSha = computeSha256(badBuffer);
      const badKey = `${user.id}/bad.pdf`;
      await writeStagingBuffer(badKey, badBuffer);
      const badStaging = await prisma.agentAttachmentStagingFile.create({
        data: {
          ownerUserId: user.id,
          storageKey: badKey,
          originalName: "bad.pdf",
          mimeType: "application/pdf",
          sizeBytes: badBuffer.length,
          sha256: badSha,
          status: "ANALYZED",
          version: 1,
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        },
      });
      const badPending = await prisma.$transaction((tx) =>
        createPendingPrivateAttachment(tx, {
          projectId: project.id,
          filename: "bad.pdf",
          mimeType: "application/pdf",
          size: badBuffer.length,
          ext: ".pdf",
          source: "AGENT",
        }),
      );
      const badRoute = await prisma.agentAttachmentRoute.create({
        data: {
          stagingId: badStaging.id,
          targetType: "PROJECT_NOTE",
          state: "PROCESSING",
          expectedSha256: "wrong-hash",
          expectedVersion: 1,
          destinationAttachmentId: badPending.id,
        },
      });
      await expect(
        promoteProjectNoteAttachment({
          attachmentId: badPending.id,
          projectId: project.id,
          storageKey: badPending.storageKey!,
          stagingStorageKey: badKey,
          routeId: badRoute.id,
          integrity: {
            expectedSha256: "wrong-hash",
            expectedVersion: 1,
            stagingSha256: badSha,
            stagingVersion: 1,
          },
        }),
      ).rejects.toMatchObject({ recoverable: true, name: "NoteAttachmentPromoteError" });
      expect(
        (await prisma.attachment.findUniqueOrThrow({ where: { id: badPending.id } })).status,
      ).toBe("PENDING_FILE");
      expect(await resumePendingAgentAttachmentRoutes()).toEqual({ promoted: 0, failed: 0 });

      // ---- missing staging source stays recoverable -------------------------
      const missingStaging = await prisma.agentAttachmentStagingFile.create({
        data: {
          ownerUserId: user.id,
          storageKey: `${user.id}/missing.pdf`,
          originalName: "missing.pdf",
          mimeType: "application/pdf",
          sizeBytes: 4,
          sha256: computeSha256(Buffer.from("x")),
          status: "ANALYZED",
          version: 1,
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        },
      });
      const missingPending = await prisma.$transaction((tx) =>
        createPendingPrivateAttachment(tx, {
          projectId: project.id,
          filename: "missing.pdf",
          mimeType: "application/pdf",
          size: 4,
          ext: ".pdf",
          source: "AGENT",
        }),
      );
      await expect(
        promoteProjectNoteAttachment({
          attachmentId: missingPending.id,
          projectId: project.id,
          storageKey: missingPending.storageKey!,
          stagingStorageKey: missingStaging.storageKey,
          integrity: {
            expectedSha256: missingStaging.sha256,
            expectedVersion: 1,
            stagingSha256: missingStaging.sha256,
            stagingVersion: 1,
          },
        }),
      ).rejects.toBeInstanceOf(NoteAttachmentPromoteError);
      expect(
        (await prisma.attachment.findUniqueOrThrow({ where: { id: missingPending.id } })).status,
      ).toBe("PENDING_FILE");
    });
  }, 120_000);
});

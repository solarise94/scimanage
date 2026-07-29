import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { withTempSmokeDb } from "../../../../../scripts/lib/temp-smoke-db";
import { computeSha256 } from "@/lib/staging-common";

/**
 * T6.6: canonical invoice attachment adoption shared by Agent
 * `finance.adopt_agent_attachment_as_invoice`. Covers capability denial,
 * successful copy into invoice staging, idempotent reuse, and resume/CAS
 * without duplicate promote.
 */
describe("T6.6 adopt agent attachment as invoice", () => {
  const origAttachmentStaging = process.env.AGENT_ATTACHMENT_STAGING_DIR;
  const origInvoiceStaging = process.env.INVOICE_STAGING_DIR;
  let tempStorageRoot: string | null = null;

  afterEach(async () => {
    if (origAttachmentStaging === undefined) delete process.env.AGENT_ATTACHMENT_STAGING_DIR;
    else process.env.AGENT_ATTACHMENT_STAGING_DIR = origAttachmentStaging;
    if (origInvoiceStaging === undefined) delete process.env.INVOICE_STAGING_DIR;
    else process.env.INVOICE_STAGING_DIR = origInvoiceStaging;
    if (tempStorageRoot) {
      await fs.rm(tempStorageRoot, { recursive: true, force: true }).catch(() => undefined);
      tempStorageRoot = null;
    }
  });

  async function useIsolatedStorageDirs(): Promise<void> {
    tempStorageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "scimanage-inv-adopt-"));
    const attachmentRoot = path.join(tempStorageRoot, "attachments");
    const invoiceRoot = path.join(tempStorageRoot, "invoice");
    await fs.mkdir(attachmentRoot, { recursive: true });
    await fs.mkdir(invoiceRoot, { recursive: true });
    process.env.AGENT_ATTACHMENT_STAGING_DIR = attachmentRoot;
    process.env.INVOICE_STAGING_DIR = invoiceRoot;
  }

  it("enforces capability, adopts, reuses, and resume does not duplicate promote", async () => {
    await withTempSmokeDb(async () => {
      await useIsolatedStorageDirs();
      const { prisma } = await import("@/lib/prisma");
      const { ForbiddenError } = await import("@/lib/application/errors");
      const { writeStagingBuffer } = await import("@/lib/agent-attachments/storage");
      const { adoptAgentAttachmentAsInvoiceForActor } = await import(
        "@/lib/finance/application/adopt-agent-attachment-as-invoice"
      );
      const { resumePendingInvoiceRoutes, invoiceAdoptionRouteKey } = await import(
        "@/lib/agent-attachments/routes"
      );

      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const admin = await prisma.user.create({
        data: { email: `t66-admin-${suffix}@example.com`, name: "Admin", password: "h", role: "ADMIN" },
      });
      const user = await prisma.user.create({
        data: { email: `t66-user-${suffix}@example.com`, name: "User", password: "h", role: "USER" },
      });
      const agentRun = await prisma.agentRun.create({
        data: { userId: admin.id, role: "ADMIN", status: "ACTIVE", source: "CHAT" },
      });

      const adminActor = {
        userId: admin.id,
        role: "ADMIN" as const,
        email: admin.email,
        name: admin.name,
      };
      const userActor = { userId: user.id, role: "USER" as const };

      const pdfBuffer = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(64, 0x20)]);
      const sha256 = computeSha256(pdfBuffer);
      const storageKey = `${admin.id}/invoice.pdf`;
      await writeStagingBuffer(storageKey, pdfBuffer);

      const attachment = await prisma.agentAttachmentStagingFile.create({
        data: {
          ownerUserId: admin.id,
          agentRunId: agentRun.id,
          storageKey,
          originalName: "invoice.pdf",
          mimeType: "application/pdf",
          sizeBytes: pdfBuffer.length,
          sha256,
          status: "ANALYZED",
          version: 1,
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        },
      });

      const adoptInput = {
        stagingFileId: attachment.id,
        expectedSha256: sha256,
        expectedVersion: 1,
      };

      await expect(
        adoptAgentAttachmentAsInvoiceForActor(userActor, adoptInput, {
          invocation: { channel: "agent", agentRunId: agentRun.id },
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);

      const first = await adoptAgentAttachmentAsInvoiceForActor(adminActor, adoptInput, {
        invocation: { channel: "agent", agentRunId: agentRun.id },
      });
      expect(first.reused).toBe(false);
      expect(first.invoiceStaging.id).toBeTruthy();
      expect(first.invoiceStaging.status).toBe("UPLOADED");

      const invoiceCountAfterFirst = await prisma.agentInvoiceStagingFile.count({
        where: { createdById: admin.id },
      });
      expect(invoiceCountAfterFirst).toBe(1);

      const second = await adoptAgentAttachmentAsInvoiceForActor(adminActor, adoptInput, {
        invocation: { channel: "agent", agentRunId: agentRun.id },
      });
      expect(second.reused).toBe(true);
      expect(second.invoiceStaging.id).toBe(first.invoiceStaging.id);
      expect(await prisma.agentInvoiceStagingFile.count({ where: { createdById: admin.id } })).toBe(1);

      const activeKey = invoiceAdoptionRouteKey(admin.id, attachment.id);
      const route = await prisma.agentAttachmentRoute.findUnique({ where: { activeRouteKey: activeKey } });
      expect(route?.state).toBe("PROMOTED");
      expect(route?.targetId).toBe(first.invoiceStaging.id);

      expect(await resumePendingInvoiceRoutes()).toEqual({ promoted: 0, failed: 0 });
    });
  });
});

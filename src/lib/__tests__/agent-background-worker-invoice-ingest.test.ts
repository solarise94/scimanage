import { describe, expect, it, vi } from "vitest";
import { withTempSmokeDb } from "../../../scripts/lib/temp-smoke-db";

const analyzeMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/finance/application/analyze-invoice-file", () => ({
  analyzeInvoiceFileForActor: analyzeMock,
}));

/**
 * T6.7: invoice ingest worker delegates analysis to canonical facade.
 */
describe("T6.7 agent-background-worker invoice ingest", () => {
  it("runInvoiceIngestItem calls analyzeInvoiceFileForActor with real owner actor", async () => {
    await withTempSmokeDb(async () => {
      analyzeMock.mockReset();
      analyzeMock.mockResolvedValue({
        staging: { id: "stg", sha256: "abc", version: 1 },
        extracted: {
          invoiceNumber: "123",
          issuedAt: "2026-01-01",
          totalAmountCents: 100,
          invoiceType: "NORMAL",
          isRedInvoice: false,
        },
        match: { status: "NO_MATCH", candidates: [] },
      });

      const { prisma } = await import("@/lib/prisma");
      const { runInvoiceIngestItem } = await import("@/lib/agent-background-worker");

      const owner = await prisma.user.create({
        data: { email: "t67-worker@example.com", name: "Owner", password: "h", role: "USER" },
      });

      const staging = await prisma.agentInvoiceStagingFile.create({
        data: {
          createdById: owner.id,
          sha256: "deadbeef".repeat(8),
          version: 1,
          status: "UPLOADED",
          expiresAt: new Date(Date.now() + 86_400_000),
          originalFileName: "inv.pdf",
          mimeType: "application/pdf",
          fileSize: 128,
          storageKey: `${owner.id}/inv.pdf`,
        },
      });

      const job = await prisma.agentBackgroundJob.create({
        data: {
          ownerUserId: owner.id,
          kind: "INVOICE_INGEST",
          status: "RUNNING",
        },
      });

      const item = await prisma.agentBackgroundJobItem.create({
        data: {
          jobId: job.id,
          stagingType: "INVOICE",
          stagingId: staging.id,
          sequenceNo: 1,
          status: "RUNNING",
        },
      });

      await runInvoiceIngestItem(
        {
          id: job.id,
          ownerUserId: owner.id,
          status: "RUNNING",
          cancelRequestedAt: null,
        },
        {
          id: item.id,
          stagingType: "INVOICE",
          stagingId: staging.id,
          sequenceNo: 1,
          attemptCount: 0,
        },
      );

      expect(analyzeMock).toHaveBeenCalledTimes(1);
      expect(analyzeMock).toHaveBeenCalledWith(
        expect.objectContaining({ userId: owner.id, role: "USER" }),
        expect.objectContaining({
          stagingFileId: staging.id,
          expectedSha256: staging.sha256,
          expectedStagingVersion: staging.version,
        }),
        expect.objectContaining({ workerIngest: true }),
      );
    });
  });
});

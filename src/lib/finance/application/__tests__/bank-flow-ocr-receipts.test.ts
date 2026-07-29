import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTempSmokeDb } from "../../../../../scripts/lib/temp-smoke-db";

import type { AgentExecutionContext, BusinessActor } from "@/lib/application/actor";

const agentExecCtx = (actor: BusinessActor): AgentExecutionContext => ({
  actor,
  invocation: { channel: "agent" },
});

const ocrVoucherImage = vi.fn();
const isGlmOcrConfigured = vi.fn(() => true);

vi.mock("@/lib/finance/glm-ocr", () => ({
  isGlmOcrConfigured: () => isGlmOcrConfigured(),
  ocrVoucherImage: (...args: unknown[]) => ocrVoucherImage(...args),
}));

/** 1x1 PNG */
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/**
 * T7.5: canonical bank-flow OCR receipts shared by Agent
 * `finance.ocr_bank_flow_receipts` — prefill only, no match/confirm.
 */
describe("T7.5 bank-flow OCR receipts", () => {
  const origImportStaging = process.env.IMPORT_STAGING_DIR;
  const origWorkspace = process.env.AGENT_WORKSPACE_DIR;
  let tempStorageRoot: string | null = null;

  beforeEach(() => {
    ocrVoucherImage.mockReset();
    isGlmOcrConfigured.mockReset();
    isGlmOcrConfigured.mockReturnValue(true);
    ocrVoucherImage.mockResolvedValue({
      fields: {
        payerName: "OCR医院",
        amountYuan: 500,
        receivedAt: "2024-05-01",
        remark: "回单备注",
      },
      warnings: [],
    });
  });

  afterEach(async () => {
    if (origImportStaging === undefined) delete process.env.IMPORT_STAGING_DIR;
    else process.env.IMPORT_STAGING_DIR = origImportStaging;
    if (origWorkspace === undefined) delete process.env.AGENT_WORKSPACE_DIR;
    else process.env.AGENT_WORKSPACE_DIR = origWorkspace;
    if (tempStorageRoot) {
      await fs.rm(tempStorageRoot, { recursive: true, force: true }).catch(() => undefined);
      tempStorageRoot = null;
    }
  });

  async function useIsolatedStorageDirs(): Promise<void> {
    tempStorageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "scimanage-bankflow-t75-"));
    process.env.IMPORT_STAGING_DIR = path.join(tempStorageRoot, "import-staging");
    process.env.AGENT_WORKSPACE_DIR = path.join(tempStorageRoot, "workspace");
    await fs.mkdir(process.env.IMPORT_STAGING_DIR, { recursive: true });
    await fs.mkdir(process.env.AGENT_WORKSPACE_DIR, { recursive: true });
  }

  it("OCR prefill, reuse, gates, and never auto-matches", async () => {
    await withTempSmokeDb(async () => {
      await useIsolatedStorageDirs();
      const { prisma } = await import("@/lib/prisma");
      const { ConflictError, ForbiddenError, ValidationError } = await import(
        "@/lib/application/errors"
      );
      const { IMPORT_KIND, createImportStagingFile } = await import("@/lib/import-staging");
      const { executeAgentAction } = await import("@/lib/agent-actions/registry");
      const { ocrBankFlowReceiptsForActor } = await import(
        "@/lib/finance/application/ocr-bank-flow-receipts"
      );
      const { loadBankFlowWorkspaceForActor } = await import(
        "@/lib/finance/application/bank-flow-workspace-access"
      );

      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const owner = await prisma.user.create({
        data: {
          email: `t75-owner-${suffix}@example.com`,
          name: "Owner",
          password: "h",
          role: "USER",
        },
      });
      const rep = await prisma.user.create({
        data: {
          email: `t75-rep-${suffix}@example.com`,
          name: "Rep",
          password: "h",
          role: "REPRESENTATIVE",
        },
      });
      const ownerActor = { userId: owner.id, role: "USER" as const };
      const repActor = { userId: rep.id, role: "REPRESENTATIVE" as const };

      const imageStaging = await createImportStagingFile({
        ownerUserId: owner.id,
        originalName: "receipt.png",
        declaredMime: "image/png",
        buffer: TINY_PNG,
        importKind: IMPORT_KIND.BANK_FLOW,
      });

      await expect(
        ocrBankFlowReceiptsForActor(repActor, { stagingFileIds: [imageStaging.id] }),
      ).rejects.toBeInstanceOf(ForbiddenError);

      const csvStaging = await createImportStagingFile({
        ownerUserId: owner.id,
        originalName: "flow.csv",
        declaredMime: "text/csv",
        buffer: Buffer.from("付款单位,金额\nA,1\n", "utf8"),
        importKind: IMPORT_KIND.BANK_FLOW,
      });
      await expect(
        ocrBankFlowReceiptsForActor(ownerActor, { stagingFileIds: [csvStaging.id] }),
      ).rejects.toBeInstanceOf(ValidationError);

      isGlmOcrConfigured.mockReturnValue(false);
      await expect(
        ocrBankFlowReceiptsForActor(ownerActor, { stagingFileIds: [imageStaging.id] }),
      ).rejects.toBeInstanceOf(ConflictError);
      isGlmOcrConfigured.mockReturnValue(true);

      const first = await ocrBankFlowReceiptsForActor(ownerActor, {
        stagingFileIds: [imageStaging.id],
      });
      expect(first.source).toBe("ocr");
      expect(first.rowCount).toBe(1);
      expect(first.preview[0]?.payerName).toBe("OCR医院");
      expect(ocrVoucherImage).toHaveBeenCalledTimes(1);

      const loaded = await loadBankFlowWorkspaceForActor({
        workspaceId: first.workspaceId,
        actorUserId: owner.id,
      });
      expect(loaded.manifest.phase).toBe("MAPPED");
      expect(loaded.manifest.source).toBe("ocr");
      expect(loaded.manifest.rows[0]?.status).toBe("PENDING");
      expect(loaded.manifest.matchResults ?? []).toEqual([]);

      const second = await ocrBankFlowReceiptsForActor(ownerActor, {
        stagingFileIds: [imageStaging.id],
      });
      expect(second.workspaceId).toBe(first.workspaceId);
      expect(second.stats.reused).toBe(true);
      expect(ocrVoucherImage).toHaveBeenCalledTimes(1);

      const adapter = await executeAgentAction<{
        workspaceId: string;
        source: string;
        rowCount: number;
      }>(agentExecCtx(ownerActor), "finance.ocr_bank_flow_receipts", {
        stagingFileIds: [imageStaging.id],
      });
      expect(adapter.result.workspaceId).toBe(first.workspaceId);
      expect(adapter.result.source).toBe("ocr");
      expect(ocrVoucherImage).toHaveBeenCalledTimes(1);
    });
  });
});

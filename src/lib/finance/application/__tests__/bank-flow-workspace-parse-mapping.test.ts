import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { withTempSmokeDb } from "../../../../../scripts/lib/temp-smoke-db";

/**
 * T7.1: canonical bank-flow workspace parse/mapping shared by Agent
 * `finance.analyze_bank_flow_file` / `finance.apply_bank_flow_mapping`.
 */
describe("T7.1 bank-flow workspace parse/mapping", () => {
  const origImportStaging = process.env.IMPORT_STAGING_DIR;
  const origWorkspace = process.env.AGENT_WORKSPACE_DIR;
  let tempStorageRoot: string | null = null;

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
    tempStorageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "scimanage-bankflow-t71-"));
    process.env.IMPORT_STAGING_DIR = path.join(tempStorageRoot, "import-staging");
    process.env.AGENT_WORKSPACE_DIR = path.join(tempStorageRoot, "workspace");
    await fs.mkdir(process.env.IMPORT_STAGING_DIR, { recursive: true });
    await fs.mkdir(process.env.AGENT_WORKSPACE_DIR, { recursive: true });
  }

  const CSV = [
    "付款单位,金额,到款日期,备注",
    "测试公司A,1000.00,2024-05-01,第一笔",
    "测试公司B,2500.50,2024-05-02,",
  ].join("\n");

  it("analyzes staging, enforces capability/ownership, applies mapping with CAS", async () => {
    await withTempSmokeDb(async () => {
      await useIsolatedStorageDirs();
      const { prisma } = await import("@/lib/prisma");
      const { ForbiddenError, StaleStateError } = await import("@/lib/application/errors");
      const { IMPORT_KIND, createImportStagingFile } = await import("@/lib/import-staging");
      const { analyzeBankFlowFileForActor } = await import(
        "@/lib/finance/application/analyze-bank-flow-file"
      );
      const { applyBankFlowMappingForActor } = await import(
        "@/lib/finance/application/apply-bank-flow-mapping"
      );

      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const owner = await prisma.user.create({
        data: {
          email: `t71-owner-${suffix}@example.com`,
          name: "Owner",
          password: "h",
          role: "USER",
        },
      });
      const other = await prisma.user.create({
        data: {
          email: `t71-other-${suffix}@example.com`,
          name: "Other",
          password: "h",
          role: "USER",
        },
      });
      const rep = await prisma.user.create({
        data: {
          email: `t71-rep-${suffix}@example.com`,
          name: "Rep",
          password: "h",
          role: "REPRESENTATIVE",
        },
      });

      const ownerActor = { userId: owner.id, role: "USER" as const };
      const otherActor = { userId: other.id, role: "USER" as const };
      const repActor = { userId: rep.id, role: "REPRESENTATIVE" as const };

      const staging = await createImportStagingFile({
        ownerUserId: owner.id,
        originalName: "bank-flow.csv",
        declaredMime: "text/csv",
        buffer: Buffer.from(CSV, "utf8"),
        importKind: IMPORT_KIND.BANK_FLOW,
      });

      await expect(
        analyzeBankFlowFileForActor(repActor, { stagingFileId: staging.id }),
      ).rejects.toBeInstanceOf(ForbiddenError);

      await expect(
        analyzeBankFlowFileForActor(otherActor, { stagingFileId: staging.id }),
      ).rejects.toMatchObject({ httpStatus: 400 });

      const analyzed = await analyzeBankFlowFileForActor(ownerActor, {
        stagingFileId: staging.id,
      });
      expect(analyzed.stats.reused).toBe(false);
      expect(analyzed.rowCount).toBe(2);
      expect(analyzed.mapping.payerName).toBe("付款单位");
      expect(analyzed.mapping.amount).toBe("金额");
      expect(analyzed.preview[0]?.payerName).toBe("测试公司A");
      expect(analyzed.preview[0]?.amountCents).toBe(100000);

      const reused = await analyzeBankFlowFileForActor(ownerActor, {
        stagingFileId: staging.id,
      });
      expect(reused.stats.reused).toBe(true);
      expect(reused.workspaceId).toBe(analyzed.workspaceId);

      await expect(
        applyBankFlowMappingForActor(otherActor, {
          workspaceId: analyzed.workspaceId,
          mapping: {
            payerName: "付款单位",
            amount: "金额",
            date: "到款日期",
            remark: "备注",
          },
          expectedVersion: analyzed.version,
        }),
      ).rejects.toMatchObject({ httpStatus: 404 });

      const mapped = await applyBankFlowMappingForActor(ownerActor, {
        workspaceId: analyzed.workspaceId,
        mapping: {
          payerName: "付款单位",
          amount: "金额",
          date: "到款日期",
          remark: "备注",
        },
        expectedVersion: analyzed.version,
      });
      expect(mapped.newVersion).toBe(analyzed.version + 1);
      expect(mapped.preview[1]?.amountCents).toBe(250050);
      expect(mapped.preview[1]?.date).toBe("2024-05-02");

      await expect(
        applyBankFlowMappingForActor(ownerActor, {
          workspaceId: analyzed.workspaceId,
          mapping: {
            payerName: "付款单位",
            amount: "金额",
          },
          expectedVersion: analyzed.version,
        }),
      ).rejects.toBeInstanceOf(StaleStateError);

      await expect(
        applyBankFlowMappingForActor(ownerActor, {
          workspaceId: analyzed.workspaceId,
          mapping: {
            payerName: "不存在列",
            amount: "金额",
          },
          expectedVersion: mapped.newVersion,
        }),
      ).rejects.toMatchObject({ httpStatus: 400 });
    });
  });
});

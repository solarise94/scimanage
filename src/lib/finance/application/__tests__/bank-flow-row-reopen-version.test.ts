import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { withTempSmokeDb } from "../../../../../scripts/lib/temp-smoke-db";

import type { AgentExecutionContext, BusinessActor } from "@/lib/application/actor";

const agentExecCtx = (actor: BusinessActor): AgentExecutionContext => ({
  actor,
  invocation: { channel: "agent" },
});

/**
 * T7.3: canonical bank-flow reopen/version rules shared by Agent
 * `finance.reopen_bank_flow_rows`.
 */
describe("T7.3 bank-flow reopen/version rules", () => {
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
    tempStorageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "scimanage-bankflow-t73-"));
    process.env.IMPORT_STAGING_DIR = path.join(tempStorageRoot, "import-staging");
    process.env.AGENT_WORKSPACE_DIR = path.join(tempStorageRoot, "workspace");
    await fs.mkdir(process.env.IMPORT_STAGING_DIR, { recursive: true });
    await fs.mkdir(process.env.AGENT_WORKSPACE_DIR, { recursive: true });
  }

  const CSV = [
    "付款单位,金额,到款日期,备注",
    "测试医院,500.00,2024-05-01,第一笔",
    "测试医院,1000.00,2024-05-02,第二笔",
  ].join("\n");

  it("enforces ownership, phase gates, CAS conflict, and reopen row resets", async () => {
    await withTempSmokeDb(async () => {
      await useIsolatedStorageDirs();
      const { prisma } = await import("@/lib/prisma");
      const { ConflictError, ForbiddenError, NotFoundError, StaleStateError } = await import(
        "@/lib/application/errors"
      );
      const { IMPORT_KIND, createImportStagingFile } = await import("@/lib/import-staging");
      const { getOwnedWorkspace, updateWorkspaceManifestCAS } = await import(
        "@/lib/agent-task-workspace"
      );
      const { executeAgentAction } = await import("@/lib/agent-actions/registry");
      const { normalizeOrgName } = await import("@/lib/organization-normalize");
      const { analyzeBankFlowFileForActor } = await import(
        "@/lib/finance/application/analyze-bank-flow-file"
      );
      const { applyBankFlowMappingForActor } = await import(
        "@/lib/finance/application/apply-bank-flow-mapping"
      );
      const { loadBankFlowWorkspaceForActor } = await import(
        "@/lib/finance/application/bank-flow-workspace-access"
      );
      const { matchBankFlowRowsForActor } = await import(
        "@/lib/finance/application/match-bank-flow-rows"
      );
      const { reopenBankFlowRowsForActor } = await import(
        "@/lib/finance/application/reopen-bank-flow-rows"
      );

      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const owner = await prisma.user.create({
        data: { email: `t73-owner-${suffix}@example.com`, name: "Owner", password: "h", role: "USER" },
      });
      const other = await prisma.user.create({
        data: { email: `t73-other-${suffix}@example.com`, name: "Other", password: "h", role: "USER" },
      });
      const rep = await prisma.user.create({
        data: { email: `t73-rep-${suffix}@example.com`, name: "Rep", password: "h", role: "REPRESENTATIVE" },
      });

      const ownerActor = { userId: owner.id, role: "USER" as const };
      const otherActor = { userId: other.id, role: "USER" as const };
      const repActor = { userId: rep.id, role: "REPRESENTATIVE" as const };

      const profileOwner = await prisma.crmCustomerProfile.create({
        data: { ownerUserId: owner.id, name: "Owner Customer", assignmentStatus: "ASSIGNED" },
      });

      const org = await prisma.organization.create({
        data: {
          orgCode: `T73-${suffix}`,
          canonicalName: "测试医院",
          normalizedName: normalizeOrgName("测试医院"),
        },
      });

      await prisma.crmCustomerProfile.update({
        where: { id: profileOwner.id },
        data: { organizationId: org.id },
      });

      const orderOwner = await prisma.order.create({
        data: {
          orderNo: `T73-O-${suffix}`,
          source: "MANUAL",
          profileId: profileOwner.id,
          title: "Owner order",
          createdById: owner.id,
          totalAmount: 50_000,
          status: "CONFIRMED",
        },
      });

      await prisma.externalOrderInvoiceRequest.create({
        data: {
          orderId: orderOwner.id,
          buyerOrganizationId: org.id,
          buyerOrganizationName: org.canonicalName,
          totalAmount: 50_000,
          status: "ISSUED",
          actualIssuedAt: new Date(),
          actualInvoiceNo: "INV-T73",
          createdById: owner.id,
        },
      });

      const staging = await createImportStagingFile({
        ownerUserId: owner.id,
        originalName: "bank-flow.csv",
        declaredMime: "text/csv",
        buffer: Buffer.from(CSV, "utf8"),
        importKind: IMPORT_KIND.BANK_FLOW,
      });

      const analyzed = await analyzeBankFlowFileForActor(ownerActor, {
        stagingFileId: staging.id,
      });
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
      const matched = await matchBankFlowRowsForActor(ownerActor, {
        workspaceId: analyzed.workspaceId,
        expectedVersion: mapped.newVersion,
      });
      expect(matched.mode).toBe("sync");

      const loaded = await loadBankFlowWorkspaceForActor({
        workspaceId: analyzed.workspaceId,
        actorUserId: owner.id,
      });
      const row0 = loaded.manifest.rows[0];
      const row1 = loaded.manifest.rows[1];
      const match0 = loaded.manifest.matchResults?.find((m) => m.rowIndex === row0.index);
      const match1 = loaded.manifest.matchResults?.find((m) => m.rowIndex === row1.index);
      expect(match0).toBeTruthy();
      expect(match1).toBeTruthy();

      const partialCas = await updateWorkspaceManifestCAS({
        workspaceId: analyzed.workspaceId,
        userId: owner.id,
        expectedVersion: matched.newVersion,
        expectedBoundProposalId: null,
        nextBoundProposalId: "proposal-stale",
        manifest: {
          ...loaded.manifest,
          phase: "PARTIAL_FAILED",
          boundProposalId: "proposal-stale",
          rows: [
            { ...row0, status: "CONFIRMED" },
            { ...row1, status: "FAILED" },
          ],
          executionResults: [
            { rowIndex: row0.index, receiptId: "receipt-1" },
            { rowIndex: row1.index, error: "mock failure" },
          ],
        } as unknown as Record<string, unknown>,
      });
      expect(partialCas.ok).toBe(true);

      await expect(
        reopenBankFlowRowsForActor(repActor, {
          workspaceId: analyzed.workspaceId,
          rowIndices: [row1.index],
          expectedVersion: partialCas.newVersion,
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);

      await expect(
        reopenBankFlowRowsForActor(otherActor, {
          workspaceId: analyzed.workspaceId,
          rowIndices: [row1.index],
          expectedVersion: partialCas.newVersion,
        }),
      ).rejects.toBeInstanceOf(NotFoundError);

      await expect(
        reopenBankFlowRowsForActor(ownerActor, {
          workspaceId: analyzed.workspaceId,
          rowIndices: [row1.index],
          expectedVersion: partialCas.newVersion - 1,
        }),
      ).rejects.toBeInstanceOf(StaleStateError);

      const matchedLoaded = await loadBankFlowWorkspaceForActor({
        workspaceId: analyzed.workspaceId,
        actorUserId: owner.id,
      });
      const matchedCas = await updateWorkspaceManifestCAS({
        workspaceId: analyzed.workspaceId,
        userId: owner.id,
        expectedVersion: partialCas.newVersion,
        manifest: {
          ...matchedLoaded.manifest,
          phase: "MATCHED",
          boundProposalId: undefined,
        } as unknown as Record<string, unknown>,
      });
      expect(matchedCas.ok).toBe(true);

      await expect(
        reopenBankFlowRowsForActor(ownerActor, {
          workspaceId: analyzed.workspaceId,
          rowIndices: [row1.index],
          expectedVersion: matchedCas.newVersion,
        }),
      ).rejects.toBeInstanceOf(ConflictError);

      const partialAgain = await updateWorkspaceManifestCAS({
        workspaceId: analyzed.workspaceId,
        userId: owner.id,
        expectedVersion: matchedCas.newVersion,
        nextBoundProposalId: "proposal-stale-2",
        manifest: {
          ...matchedLoaded.manifest,
          phase: "PARTIAL_FAILED",
          boundProposalId: "proposal-stale-2",
          rows: [
            { ...row0, status: "CONFIRMED" },
            { ...row1, status: "FAILED" },
          ],
          matchResults: [match0!, match1!],
          executionResults: [
            { rowIndex: row0.index, receiptId: "receipt-1" },
            { rowIndex: row1.index, error: "mock failure" },
          ],
        } as unknown as Record<string, unknown>,
      });
      expect(partialAgain.ok).toBe(true);

      const reopened = await executeAgentAction<{
        reopened: number;
        newVersion: number;
      }>(agentExecCtx(ownerActor), "finance.reopen_bank_flow_rows", {
        workspaceId: analyzed.workspaceId,
        rowIndices: [row0.index, row1.index],
        expectedVersion: partialAgain.newVersion,
      });
      expect(reopened.result.reopened).toBe(1);
      expect(reopened.result.newVersion).toBeGreaterThan(partialAgain.newVersion);

      const after = await loadBankFlowWorkspaceForActor({
        workspaceId: analyzed.workspaceId,
        actorUserId: owner.id,
      });
      expect(after.manifest.phase).toBe("MATCHED");
      expect(after.manifest.boundProposalId).toBeUndefined();
      expect(after.version).toBe(reopened.result.newVersion);

      const row0After = after.manifest.rows.find((r) => r.index === row0.index);
      const row1After = after.manifest.rows.find((r) => r.index === row1.index);
      expect(row0After?.status).toBe("CONFIRMED");
      expect(row1After?.status).toBe("PENDING");
      expect(after.manifest.matchResults?.some((m) => m.rowIndex === row1.index)).toBe(false);
      expect(after.manifest.matchResults?.some((m) => m.rowIndex === row0.index)).toBe(true);

      const wsEntity = await getOwnedWorkspace({
        workspaceId: analyzed.workspaceId,
        userId: owner.id,
      });
      expect(wsEntity?.boundProposalId).toBeNull();

      const matchingCas = await updateWorkspaceManifestCAS({
        workspaceId: analyzed.workspaceId,
        userId: owner.id,
        expectedVersion: reopened.result.newVersion,
        expectedBoundProposalId: null,
        manifest: {
          ...after.manifest,
          phase: "MATCHING",
          matchJobId: "job-mock",
        } as unknown as Record<string, unknown>,
      });
      expect(matchingCas.ok).toBe(true);

      await expect(
        reopenBankFlowRowsForActor(ownerActor, {
          workspaceId: analyzed.workspaceId,
          rowIndices: [row1.index],
          expectedVersion: matchingCas.newVersion,
        }),
      ).rejects.toBeInstanceOf(ConflictError);
    });
  });
});

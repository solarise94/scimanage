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
 * T7.4: canonical bank-flow batch confirm shared by Agent
 * `finance.confirm_bank_flow_batch` via T6.5 createReceiptForActor.
 *
 * Note: bank-flow matcher uses subset-sum of invoice outstanding == row amount,
 * so seed invoices at 50_000 / 100_000 to match the CSV rows.
 * All scenarios share one withTempSmokeDb (Prisma singleton).
 */
describe("T7.4 bank-flow batch confirm", () => {
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
    tempStorageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "scimanage-bankflow-t74-"));
    process.env.IMPORT_STAGING_DIR = path.join(tempStorageRoot, "import-staging");
    process.env.AGENT_WORKSPACE_DIR = path.join(tempStorageRoot, "workspace");
    await fs.mkdir(process.env.IMPORT_STAGING_DIR, { recursive: true });
    await fs.mkdir(process.env.AGENT_WORKSPACE_DIR, { recursive: true });
  }

  function buildCsv(payerName: string): string {
    return [
      "付款单位,金额,到款日期,备注",
      `${payerName},500.00,2024-05-01,第一笔`,
      `${payerName},1000.00,2024-05-02,第二笔`,
    ].join("\n");
  }

  it("confirms, retries partial failure without duplicates, and enforces gates", async () => {
    await withTempSmokeDb(async () => {
      await useIsolatedStorageDirs();
      const { prisma } = await import("@/lib/prisma");
      const { ConflictError, ForbiddenError, NotFoundError, StaleStateError } = await import(
        "@/lib/application/errors"
      );
      const { IMPORT_KIND, createImportStagingFile } = await import("@/lib/import-staging");
      const { normalizeOrgName } = await import("@/lib/organization-normalize");
      const { executeAgentAction } = await import("@/lib/agent-actions/registry");
      const { analyzeBankFlowFileForActor } = await import(
        "@/lib/finance/application/analyze-bank-flow-file"
      );
      const { applyBankFlowMappingForActor } = await import(
        "@/lib/finance/application/apply-bank-flow-mapping"
      );
      const { matchBankFlowRowsForActor } = await import(
        "@/lib/finance/application/match-bank-flow-rows"
      );
      const { loadBankFlowWorkspaceForActor } = await import(
        "@/lib/finance/application/bank-flow-workspace-access"
      );
      const {
        confirmBankFlowBatchForActor,
        previewConfirmBankFlowBatchForActor,
      } = await import("@/lib/finance/application/confirm-bank-flow-batch");

      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      async function seedMatchedWorkspace(tag: string) {
        const payerName = `测试医院-${tag}-${suffix}`;
        const owner = await prisma.user.create({
          data: {
            email: `t74-owner-${tag}-${suffix}@example.com`,
            name: "Owner",
            password: "h",
            role: "USER",
          },
        });
        const profileOwner = await prisma.crmCustomerProfile.create({
          data: {
            ownerUserId: owner.id,
            name: "Owner Customer",
            assignmentStatus: "ASSIGNED",
          },
        });
        const org = await prisma.organization.create({
          data: {
            orgCode: `T74-${tag}-${suffix}`,
            canonicalName: payerName,
            normalizedName: normalizeOrgName(payerName),
          },
        });
        await prisma.crmCustomerProfile.update({
          where: { id: profileOwner.id },
          data: { organizationId: org.id },
        });

        // 部门隔离 Phase 4：可见性以部门 CLAIMED state 为准；raw fixture 需回填 state
        // （ASSIGNED+owner → FIELD_SALES CLAIMED，可见范围与旧语义等价）。
        const { backfillDepartmentStates } = await import("../../../../../scripts/lib/department-states");
        await backfillDepartmentStates(prisma, { apply: true });

        const orderOwner = await prisma.order.create({
          data: {
            orderNo: `T74-O-${tag}-${suffix}`,
            source: "MANUAL",
            profileId: profileOwner.id,
            title: "Owner order",
            createdById: owner.id,
            technicalOwnerUserId: owner.id,
            totalAmount: 150_000,
            status: "CONFIRMED",
          },
        });

        const inv50 = await prisma.externalOrderInvoiceRequest.create({
          data: {
            orderId: orderOwner.id,
            buyerOrganizationId: org.id,
            buyerOrganizationName: org.canonicalName,
            totalAmount: 50_000,
            status: "ISSUED",
            actualIssuedAt: new Date(),
            actualInvoiceNo: `INV-T74-50-${tag}-${suffix}`,
            createdById: owner.id,
          },
        });
        const inv100 = await prisma.externalOrderInvoiceRequest.create({
          data: {
            orderId: orderOwner.id,
            buyerOrganizationId: org.id,
            buyerOrganizationName: org.canonicalName,
            totalAmount: 100_000,
            status: "ISSUED",
            actualIssuedAt: new Date(),
            actualInvoiceNo: `INV-T74-100-${tag}-${suffix}`,
            createdById: owner.id,
          },
        });

        const staging = await createImportStagingFile({
          ownerUserId: owner.id,
          originalName: "bank-flow.csv",
          declaredMime: "text/csv",
          buffer: Buffer.from(buildCsv(payerName), "utf8"),
          importKind: IMPORT_KIND.BANK_FLOW,
        });

        const ownerActor = { userId: owner.id, role: "USER" as const };
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
        expect(loaded.manifest.phase).toBe("MATCHED");
        expect(loaded.manifest.rows.every((r) => r.status === "MATCHED")).toBe(true);

        return {
          owner,
          ownerActor,
          workspaceId: analyzed.workspaceId,
          version: matched.newVersion,
          inv50Id: inv50.id,
          inv100Id: inv100.id,
          rowIndices: loaded.manifest.rows.map((r) => r.index),
        };
      }

      // ── success path + gates ─────────────────────────────────
      const ok = await seedMatchedWorkspace("ok");

      const other = await prisma.user.create({
        data: {
          email: `t74-other-${suffix}@example.com`,
          name: "Other",
          password: "h",
          role: "USER",
        },
      });
      const rep = await prisma.user.create({
        data: {
          email: `t74-rep-${suffix}@example.com`,
          name: "Rep",
          password: "h",
          role: "REPRESENTATIVE",
        },
      });
      const otherActor = { userId: other.id, role: "USER" as const };
      const repActor = { userId: rep.id, role: "REPRESENTATIVE" as const };

      const preview = await previewConfirmBankFlowBatchForActor(ok.ownerActor, {
        workspaceId: ok.workspaceId,
        expectedVersion: ok.version,
      });
      expect(preview.title).toContain("确认银行流水核销");
      expect(preview.displayProps.rowCount).toBe("2");

      await expect(
        confirmBankFlowBatchForActor(repActor, {
          workspaceId: ok.workspaceId,
          expectedVersion: ok.version,
          proposalId: "prop-t74-rep",
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);

      await expect(
        confirmBankFlowBatchForActor(otherActor, {
          workspaceId: ok.workspaceId,
          expectedVersion: ok.version,
          proposalId: "prop-t74-other",
        }),
      ).rejects.toBeInstanceOf(NotFoundError);

      await expect(
        confirmBankFlowBatchForActor(ok.ownerActor, {
          workspaceId: ok.workspaceId,
          expectedVersion: ok.version - 1,
          proposalId: "prop-t74-stale",
        }),
      ).rejects.toBeInstanceOf(StaleStateError);

      const adapterResult = await executeAgentAction<{
        created: number;
        failed: number;
        totalAmountCents: number;
      }>(
        agentExecCtx(ok.ownerActor),
        "finance.confirm_bank_flow_batch",
        { workspaceId: ok.workspaceId, expectedVersion: ok.version },
        { allowConfirm: true, proposalId: "prop-t74-adapter" },
      );
      expect(adapterResult.result.created).toBe(2);
      expect(adapterResult.result.failed).toBe(0);
      expect(adapterResult.result.totalAmountCents).toBe(150_000);

      const afterSuccess = await loadBankFlowWorkspaceForActor({
        workspaceId: ok.workspaceId,
        actorUserId: ok.owner.id,
      });
      expect(afterSuccess.manifest.phase).toBe("CONFIRMED");
      expect(
        await prisma.financeReceipt.count({
          where: { sourceWorkspaceId: ok.workspaceId, deleted: false },
        }),
      ).toBe(2);

      // ── partial failure + retry without duplicate ────────────
      const partial = await seedMatchedWorkspace("partial");
      await prisma.externalOrderInvoiceRequest.update({
        where: { id: partial.inv100Id },
        data: { status: "CANCELLED" },
      });

      const partialResult = await confirmBankFlowBatchForActor(partial.ownerActor, {
        workspaceId: partial.workspaceId,
        expectedVersion: partial.version,
        proposalId: "prop-t74-partial-1",
      });
      expect(partialResult.created).toBe(1);
      expect(partialResult.failed).toBe(1);

      const afterPartial = await loadBankFlowWorkspaceForActor({
        workspaceId: partial.workspaceId,
        actorUserId: partial.owner.id,
      });
      expect(afterPartial.manifest.phase).toBe("PARTIAL_FAILED");
      expect(
        await prisma.financeReceipt.count({
          where: { sourceWorkspaceId: partial.workspaceId, deleted: false },
        }),
      ).toBe(1);

      const retry = await confirmBankFlowBatchForActor(partial.ownerActor, {
        workspaceId: partial.workspaceId,
        expectedVersion: afterPartial.version,
        proposalId: "prop-t74-partial-2",
      });
      expect(retry.created).toBe(0);
      expect(retry.failed).toBe(1);
      expect(
        await prisma.financeReceipt.count({
          where: { sourceWorkspaceId: partial.workspaceId, deleted: false },
        }),
      ).toBe(1);

      const succeededRowIndex = partial.rowIndices.find((idx) => {
        const row = afterPartial.manifest.rows.find((r) => r.index === idx);
        return row?.status === "CONFIRMED";
      });
      expect(succeededRowIndex).toBeDefined();
      expect(
        await prisma.financeReceipt.findFirst({
          where: {
            sourceWorkspaceId: partial.workspaceId,
            sourceRowIndex: succeededRowIndex!,
            deleted: false,
          },
        }),
      ).toBeTruthy();

      // ── phase gate (MAPPED, not MATCHED) ──────────────────────
      const phaseOwner = await prisma.user.create({
        data: {
          email: `t74-phase-${suffix}@example.com`,
          name: "Phase",
          password: "h",
          role: "USER",
        },
      });
      const phaseActor = { userId: phaseOwner.id, role: "USER" as const };
      const phaseStaging = await createImportStagingFile({
        ownerUserId: phaseOwner.id,
        originalName: "bank-flow.csv",
        declaredMime: "text/csv",
        buffer: Buffer.from(buildCsv(`相位门控医院-${suffix}`), "utf8"),
        importKind: IMPORT_KIND.BANK_FLOW,
      });
      const analyzed = await analyzeBankFlowFileForActor(phaseActor, {
        stagingFileId: phaseStaging.id,
      });
      const mapped = await applyBankFlowMappingForActor(phaseActor, {
        workspaceId: analyzed.workspaceId,
        mapping: {
          payerName: "付款单位",
          amount: "金额",
          date: "到款日期",
          remark: "备注",
        },
        expectedVersion: analyzed.version,
      });
      await expect(
        confirmBankFlowBatchForActor(phaseActor, {
          workspaceId: analyzed.workspaceId,
          expectedVersion: mapped.newVersion,
          proposalId: "prop-t74-bad-phase",
        }),
      ).rejects.toBeInstanceOf(ConflictError);
    });
  });
});

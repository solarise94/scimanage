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
 * T7.2: canonical bank-flow row match/detail/selection shared by Agent
 * `finance.match_bank_flow_rows` / `get_bank_flow_row` / `update_bank_flow_selection`.
 */
describe("T7.2 bank-flow row match/detail/selection", () => {
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
    tempStorageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "scimanage-bankflow-t72-"));
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

  it("enforces ownership, phase gates, match/selection, and scope disclosure", async () => {
    await withTempSmokeDb(async () => {
      await useIsolatedStorageDirs();
      const { prisma } = await import("@/lib/prisma");
      const { ConflictError, ForbiddenError, NotFoundError, StaleStateError } = await import(
        "@/lib/application/errors"
      );
      const { IMPORT_KIND, createImportStagingFile } = await import("@/lib/import-staging");
      const { updateWorkspaceManifestCAS } = await import("@/lib/agent-task-workspace");
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
      const { getBankFlowRowForActor } = await import(
        "@/lib/finance/application/get-bank-flow-row"
      );
      const { updateBankFlowSelectionForActor } = await import(
        "@/lib/finance/application/update-bank-flow-selection"
      );

      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const admin = await prisma.user.create({
        data: { email: `t72-admin-${suffix}@example.com`, name: "Admin", password: "h", role: "ADMIN" },
      });
      const owner = await prisma.user.create({
        data: { email: `t72-owner-${suffix}@example.com`, name: "Owner", password: "h", role: "USER" },
      });
      const other = await prisma.user.create({
        data: { email: `t72-other-${suffix}@example.com`, name: "Other", password: "h", role: "USER" },
      });
      const rep = await prisma.user.create({
        data: { email: `t72-rep-${suffix}@example.com`, name: "Rep", password: "h", role: "REPRESENTATIVE" },
      });

      const ownerActor = { userId: owner.id, role: "USER" as const };
      const otherActor = { userId: other.id, role: "USER" as const };
      const repActor = { userId: rep.id, role: "REPRESENTATIVE" as const };

      const profileOwner = await prisma.crmCustomerProfile.create({
        data: { ownerUserId: owner.id, name: "Owner Customer", assignmentStatus: "ASSIGNED" },
      });
      const profileOther = await prisma.crmCustomerProfile.create({
        data: { ownerUserId: other.id, name: "Other Customer", assignmentStatus: "ASSIGNED" },
      });

      // 部门隔离 Phase 4：可见性以部门 CLAIMED state 为准；raw fixture 需回填 state
      // （ASSIGNED+owner → FIELD_SALES CLAIMED，可见范围与旧语义等价）。
      const { backfillDepartmentStates } = await import("../../../../../scripts/lib/department-states");
      await backfillDepartmentStates(prisma, { apply: true });

      const org = await prisma.organization.create({
        data: {
          orgCode: `T72-${suffix}`,
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
          orderNo: `T72-O-${suffix}`,
          source: "MANUAL",
          profileId: profileOwner.id,
          title: "Owner order",
          createdById: admin.id,
          totalAmount: 50_000,
          status: "CONFIRMED",
        },
      });
      const orderOther = await prisma.order.create({
        data: {
          orderNo: `T72-X-${suffix}`,
          source: "MANUAL",
          profileId: profileOther.id,
          title: "Other order",
          createdById: admin.id,
          totalAmount: 50_000,
          status: "CONFIRMED",
        },
      });

      const invoiceSingle = await prisma.externalOrderInvoiceRequest.create({
        data: {
          orderId: orderOwner.id,
          buyerOrganizationId: org.id,
          buyerOrganizationName: org.canonicalName,
          totalAmount: 50_000,
          status: "ISSUED",
          actualIssuedAt: new Date(),
          actualInvoiceNo: "INV-SINGLE",
          createdById: admin.id,
        },
      });

      const invoicePartial = await prisma.externalOrderInvoiceRequest.create({
        data: {
          orderId: orderOwner.id,
          buyerOrganizationId: org.id,
          buyerOrganizationName: org.canonicalName,
          totalAmount: 100_000,
          status: "ISSUED",
          actualIssuedAt: new Date(),
          actualInvoiceNo: "INV-PARTIAL",
          createdById: admin.id,
          orderCoverage: {
            create: [
              { orderId: orderOwner.id, amount: 50_000 },
              { orderId: orderOther.id, amount: 50_000 },
            ],
          },
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

      await expect(
        matchBankFlowRowsForActor(repActor, {
          workspaceId: analyzed.workspaceId,
          expectedVersion: mapped.newVersion,
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);

      await expect(
        matchBankFlowRowsForActor(otherActor, {
          workspaceId: analyzed.workspaceId,
          expectedVersion: mapped.newVersion,
        }),
      ).rejects.toBeInstanceOf(NotFoundError);

      const mappedLoaded = await loadBankFlowWorkspaceForActor({
        workspaceId: analyzed.workspaceId,
        actorUserId: owner.id,
      });
      const row0Index = mappedLoaded.manifest.rows[0]!.index;
      const row1Index = mappedLoaded.manifest.rows[1]!.index;

      const matchedRow0 = await matchBankFlowRowsForActor(ownerActor, {
        workspaceId: analyzed.workspaceId,
        expectedVersion: mapped.newVersion,
        rowIndices: [row0Index],
      });
      expect(matchedRow0.mode).toBe("sync");
      if (matchedRow0.mode !== "sync") throw new Error("expected sync match");

      const rawAfterMatch = await prisma.agentTaskWorkspace.findUnique({
        where: { id: analyzed.workspaceId },
        select: { manifestJson: true, version: true },
      });
      const manifestAfterMatch = JSON.parse(rawAfterMatch!.manifestJson!) as {
        rows?: Array<{ index: number }>;
      };
      expect(manifestAfterMatch.rows?.length).toBe(2);

      const loadedAfterMap = await loadBankFlowWorkspaceForActor({
        workspaceId: analyzed.workspaceId,
        actorUserId: owner.id,
      });
      expect(loadedAfterMap.manifest.rows.length).toBe(2);

      const row0AfterMatch = await getBankFlowRowForActor(ownerActor, {
        workspaceId: analyzed.workspaceId,
        rowIndex: row0Index,
      });
      expect(row0AfterMatch.row.payerName).toBe("测试医院");
      expect(row0AfterMatch.row.status).not.toBe("ORG_NOT_FOUND");

      const row0Match = matchedRow0.results.find((r) => r.rowIndex === row0Index);
      expect(row0Match?.organization?.id).toBe(org.id);
      const leakedInvoiceIds = (row0Match?.combinations ?? []).flatMap((c) =>
        c.invoices.map((i) => i.invoiceId),
      );
      expect(leakedInvoiceIds).toContain(invoiceSingle.id);
      expect(leakedInvoiceIds).not.toContain(invoicePartial.id);

      const ownerRow1Match = await matchBankFlowRowsForActor(ownerActor, {
        workspaceId: analyzed.workspaceId,
        expectedVersion: matchedRow0.newVersion,
        rowIndices: [row1Index],
      });
      expect(ownerRow1Match.mode).toBe("sync");
      if (ownerRow1Match.mode !== "sync") throw new Error("expected sync");
      const ownerRow1 = ownerRow1Match.results.find((r) => r.rowIndex === row1Index);
      const ownerRow1Leaked = (ownerRow1?.combinations ?? []).flatMap((c) =>
        c.invoices.map((i) => i.invoiceId),
      );
      expect(ownerRow1Leaked).not.toContain(invoicePartial.id);

      const detail = await getBankFlowRowForActor(ownerActor, {
        workspaceId: analyzed.workspaceId,
        rowIndex: row0Index,
      });
      expect(detail.row.status).toBe("MATCHED");
      expect(detail.match?.organization?.id).toBe(org.id);

      await expect(
        getBankFlowRowForActor(otherActor, {
          workspaceId: analyzed.workspaceId,
          rowIndex: row0Index,
        }),
      ).rejects.toBeInstanceOf(NotFoundError);

      const skipped = await updateBankFlowSelectionForActor(ownerActor, {
        workspaceId: analyzed.workspaceId,
        rowIndex: row1Index,
        skip: true,
        expectedVersion: ownerRow1Match.newVersion,
      });
      expect(skipped.row.status).toBe("SKIPPED");
      expect(skipped.row.match).toBeNull();

      await expect(
        updateBankFlowSelectionForActor(ownerActor, {
          workspaceId: analyzed.workspaceId,
          rowIndex: row0Index,
          combinationIndex: 0,
          expectedVersion: ownerRow1Match.newVersion,
        }),
      ).rejects.toBeInstanceOf(StaleStateError);

      const selected = await updateBankFlowSelectionForActor(ownerActor, {
        workspaceId: analyzed.workspaceId,
        rowIndex: row0Index,
        combinationIndex: 0,
        expectedVersion: skipped.newVersion,
      });
      expect(selected.row.status).toBe("MATCHED");
      expect(selected.row.match?.selectedCombinationIndex).toBe(0);

      const agentRow = await executeAgentAction<{
        version: number;
        match: { organization?: { id: string } } | null;
      }>(agentExecCtx(ownerActor), "finance.get_bank_flow_row", {
        workspaceId: analyzed.workspaceId,
        rowIndex: row0Index,
      });
      expect(agentRow.result.version).toBe(selected.newVersion);
      expect(agentRow.result.match?.organization?.id).toBe(org.id);

      const loaded = await loadBankFlowWorkspaceForActor({
        workspaceId: analyzed.workspaceId,
        actorUserId: owner.id,
      });
      const frozenCas = await updateWorkspaceManifestCAS({
        workspaceId: analyzed.workspaceId,
        userId: owner.id,
        expectedVersion: selected.newVersion,
        manifest: {
          ...loaded.manifest,
          phase: "MATCHING",
          matchJobId: null,
        } as unknown as Record<string, unknown>,
      });
      expect(frozenCas.ok).toBe(true);

      await expect(
        matchBankFlowRowsForActor(ownerActor, {
          workspaceId: analyzed.workspaceId,
          expectedVersion: frozenCas.newVersion,
        }),
      ).rejects.toBeInstanceOf(ConflictError);

      await expect(
        updateBankFlowSelectionForActor(ownerActor, {
          workspaceId: analyzed.workspaceId,
          rowIndex: row0Index,
          skip: true,
          expectedVersion: frozenCas.newVersion,
        }),
      ).rejects.toBeInstanceOf(ConflictError);
    });
  });
});

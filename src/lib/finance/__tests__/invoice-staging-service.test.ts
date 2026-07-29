import { describe, expect, it } from "vitest";
import { withTempSmokeDb } from "../../../../scripts/lib/temp-smoke-db";

/**
 * T1.3: attachment/invoice/import staging routes are now Prisma-free adapters.
 * This characterizes the application/domain services the routes collapsed onto:
 *  - `deleteOwnedInvoiceStaging` (owner scope, state machine, expired resource)
 *  - `listPendingInvoiceRegisterProposals` (owner/run scoped proposal map)
 *  - `writeAgentActionLog` (raw-field audit writer, single Prisma entry, T1.2)
 *  - `ensureAgentRunBelongsToSession` (owner/run gate reused by every staging route)
 *
 * All scenarios share one temporary SQLite database (never dev/demo/prod). The
 * temp-db helper caches a single prisma client per module, so everything runs
 * inside one `withTempSmokeDb` callback.
 */
describe("T1.3 staging route service collapse", () => {
  it("enforces owner scope, staging state machine, run gate and ad-hoc audit", async () => {
    await withTempSmokeDb(async () => {
      const { prisma } = await import("@/lib/prisma");
      const {
        deleteOwnedInvoiceStaging,
        listPendingInvoiceRegisterProposals,
        InvoiceStagingError,
      } = await import("@/lib/finance/invoice-staging");
      const { writeAgentActionLog } = await import("@/lib/application/agent-action-logs");
      const { ensureAgentRunBelongsToSession } = await import(
        "@/lib/agent-actions/run-context"
      );
      const { AgentActionForbiddenError } = await import("@/lib/agent-actions/errors");

      const owner = await prisma.user.create({
        data: { email: "t13-owner@example.com", name: "Owner", password: "h", role: "ADMIN" },
      });
      const other = await prisma.user.create({
        data: { email: "t13-other@example.com", name: "Other", password: "h", role: "ADMIN" },
      });

      const createStagingRow = (opts: {
        createdById: string;
        status: string;
        suffix: string;
        expiresAt?: Date;
      }) =>
        prisma.agentInvoiceStagingFile.create({
          data: {
            createdById: opts.createdById,
            originalFileName: "invoice.pdf",
            storageKey: `${opts.createdById}/${opts.suffix}.pdf`,
            mimeType: "application/pdf",
            fileSize: 1234,
            sha256: `sha-${opts.suffix}`,
            status: opts.status,
            version: 1,
            expiresAt: opts.expiresAt ?? new Date(Date.now() + 60 * 60 * 1000),
          },
        });

      // ---- deleteOwnedInvoiceStaging: cross-owner access rejected -------------
      const ownerRow = await createStagingRow({
        createdById: owner.id,
        status: "UPLOADED",
        suffix: "owned",
      });
      await expect(
        deleteOwnedInvoiceStaging({ stagingFileId: ownerRow.id, userId: other.id }),
      ).rejects.toMatchObject({ code: "INVOICE_STAGING_NOT_FOUND", httpStatus: 404 });

      // ---- UPLOADED → ok, row flipped to SKIPPED -----------------------------
      expect(
        await deleteOwnedInvoiceStaging({ stagingFileId: ownerRow.id, userId: owner.id }),
      ).toEqual({ ok: true });
      expect(
        (await prisma.agentInvoiceStagingFile.findUnique({ where: { id: ownerRow.id } }))?.status,
      ).toBe("SKIPPED");

      // ---- REGISTERED → only the staging copy cleaned; row stays REGISTERED ---
      const registered = await createStagingRow({
        createdById: owner.id,
        status: "REGISTERED",
        suffix: "registered",
      });
      expect(
        await deleteOwnedInvoiceStaging({ stagingFileId: registered.id, userId: owner.id }),
      ).toEqual({ ok: true, cleaned: "staging_copy" });
      expect(
        (await prisma.agentInvoiceStagingFile.findUnique({ where: { id: registered.id } }))?.status,
      ).toBe("REGISTERED");

      // ---- expired resource is still deletable (requireActive:false) ---------
      const expired = await createStagingRow({
        createdById: owner.id,
        status: "EXPIRED",
        suffix: "expired",
        expiresAt: new Date(Date.now() - 60_000),
      });
      expect(
        await deleteOwnedInvoiceStaging({ stagingFileId: expired.id, userId: owner.id }),
      ).toEqual({ ok: true });

      // ---- non-deletable state (PENDING_FILE) → conflict ---------------------
      const pending = await createStagingRow({
        createdById: owner.id,
        status: "PENDING_FILE",
        suffix: "pending",
      });
      const delErr = await deleteOwnedInvoiceStaging({
        stagingFileId: pending.id,
        userId: owner.id,
      }).catch((e) => e);
      expect(delErr).toBeInstanceOf(InvoiceStagingError);
      expect(delErr.code).toBe("INVOICE_STAGING_CHANGED");
      expect(delErr.httpStatus).toBe(409);

      // ---- listPendingInvoiceRegisterProposals: owner/run/action scoped ------
      const run = await prisma.agentRun.create({
        data: { userId: owner.id, role: "ADMIN", status: "ACTIVE", source: "CHAT" },
      });
      const mkProposal = (data: {
        userId: string;
        agentRunId?: string | null;
        status: string;
        actionKey: string;
        stagingFileId?: string | null;
      }) =>
        prisma.agentProposal.create({
          data: {
            userId: data.userId,
            agentRunId: data.agentRunId ?? null,
            actionKey: data.actionKey,
            title: "t",
            summary: "s",
            riskLevel: "confirm",
            status: data.status,
            inputJson: JSON.stringify(
              data.stagingFileId ? { stagingFileId: data.stagingFileId } : {},
            ),
          },
        });

      await mkProposal({
        userId: owner.id,
        agentRunId: run.id,
        status: "PENDING",
        actionKey: "finance.register_issued_invoice",
        stagingFileId: "staging-a",
      });
      const processing = await mkProposal({
        userId: owner.id,
        agentRunId: run.id,
        status: "PROCESSING",
        actionKey: "finance.register_issued_invoice",
        stagingFileId: "staging-b",
      });
      await mkProposal({
        userId: other.id, // wrong owner → not leaked
        status: "PENDING",
        actionKey: "finance.register_issued_invoice",
        stagingFileId: "staging-c",
      });
      await mkProposal({
        userId: owner.id, // wrong action key → ignored
        status: "PENDING",
        actionKey: "finance.create_receipt",
        stagingFileId: "staging-d",
      });
      await mkProposal({
        userId: owner.id, // terminal status → ignored
        status: "CONFIRMED",
        actionKey: "finance.register_issued_invoice",
        stagingFileId: "staging-e",
      });

      const all = await listPendingInvoiceRegisterProposals({ userId: owner.id });
      expect([...all.keys()].sort()).toEqual(["staging-a", "staging-b"]);
      expect(all.get("staging-b")).toBe(processing.id);

      const byRun = await listPendingInvoiceRegisterProposals({
        userId: owner.id,
        agentRunId: run.id,
      });
      expect([...byRun.keys()].sort()).toEqual(["staging-a", "staging-b"]);
      const byOtherRun = await listPendingInvoiceRegisterProposals({
        userId: owner.id,
        agentRunId: "run-does-not-exist",
      });
      expect(byOtherRun.size).toBe(0);

      // ---- ensureAgentRunBelongsToSession: owner/run gate shared by routes ----
      const otherSession = {
        user: { id: other.id, role: "ADMIN", name: "Other", email: other.email },
        expires: new Date(Date.now() + 60_000).toISOString(),
      } as unknown as import("next-auth").Session;
      await expect(
        ensureAgentRunBelongsToSession(run.id, otherSession),
      ).rejects.toBeInstanceOf(AgentActionForbiddenError);

      // ---- writeAgentActionLog: raw-field audit through the single entry ------
      const log = await writeAgentActionLog({
        userId: owner.id,
        agentRunId: run.id,
        actionKey: "finance.invoice_staging_upload",
        riskLevel: "safe",
        status: "INVOICE_STAGING_UPLOADED",
        input: { stagingFileId: "abc", sha256Prefix: "deadbeef" },
        target: { type: "invoice_staging", id: "abc" },
      });
      const persisted = await prisma.agentActionLog.findUnique({ where: { id: log.id } });
      expect(persisted?.userId).toBe(owner.id);
      expect(persisted?.agentRunId).toBe(run.id);
      expect(persisted?.actionKey).toBe("finance.invoice_staging_upload");
      expect(persisted?.status).toBe("INVOICE_STAGING_UPLOADED");
      expect(persisted?.targetType).toBe("invoice_staging");
      expect(persisted?.targetId).toBe("abc");
      expect(persisted?.inputJson).toBe(
        JSON.stringify({ stagingFileId: "abc", sha256Prefix: "deadbeef" }),
      );

      const bare = await writeAgentActionLog({
        userId: owner.id,
        actionKey: "agent.attachment_delete",
        riskLevel: "safe",
        status: "ATTACHMENT_DELETED",
        input: null,
      });
      const bareRow = await prisma.agentActionLog.findUnique({ where: { id: bare.id } });
      expect(bareRow?.agentRunId).toBeNull();
      expect(bareRow?.targetType).toBeNull();
      expect(bareRow?.inputJson).toBe("{}");
    });
  }, 120_000);
});

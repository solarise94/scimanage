import { describe, expect, it } from "vitest";
import { withTempSmokeDb } from "../../../../scripts/lib/temp-smoke-db";

/**
 * T1.4: chat / chat-stream / background-job routes are now Prisma-free adapters.
 * This characterizes the services the routes collapsed onto:
 *  - `commitAgentChatUserMessage` (atomic session+attachment+message tx; rollback)
 *  - `assertOwnedInvoiceStagingFiles` (owner gate for create-invoice-ingest w/o run)
 *  - `executeAgentToolForRun` (in-process tool exec replacing internal /api fetch:
 *    run→actor resolution + chat-session isolation before dispatch)
 *
 * All scenarios share one temporary SQLite database (never dev/demo/prod). The
 * temp-db helper caches a single prisma client per module, so everything runs
 * inside one `withTempSmokeDb` callback.
 */
describe("T1.4 chat / background-job route service collapse", () => {
  it("covers chat tx rollback, background-job owner gate and in-process tool exec", async () => {
    await withTempSmokeDb(async () => {
      const { prisma } = await import("@/lib/prisma");
      const { commitAgentChatUserMessage } = await import(
        "@/lib/agent-runtime/chat-sessions"
      );
      const { StagingError } = await import("@/lib/staging-common");
      const { assertOwnedInvoiceStagingFiles, InvoiceStagingError } = await import(
        "@/lib/finance/invoice-staging"
      );
      const { executeAgentToolForRun } = await import(
        "@/lib/agent-actions/execute-tool-for-run"
      );
      const { AgentActionInputError, AgentActionForbiddenError } = await import(
        "@/lib/agent-actions/errors"
      );

      const owner = await prisma.user.create({
        data: { email: "t14-owner@example.com", name: "Owner", password: "h", role: "ADMIN" },
      });
      const other = await prisma.user.create({
        data: { email: "t14-other@example.com", name: "Other", password: "h", role: "ADMIN" },
      });
      const run = await prisma.agentRun.create({
        data: { userId: owner.id, role: "ADMIN", status: "ACTIVE", source: "CHAT" },
      });
      const actor = { userId: owner.id, role: "ADMIN", agentRunId: run.id };

      // ── commitAgentChatUserMessage: new session + user message together ─────
      const sessionId = await commitAgentChatUserMessage(actor, {
        needsNewSession: true,
        existingSessionId: null,
        agentRunId: run.id,
        newSessionTitle: "首个问题",
        message: "你好，帮我查一下",
        inputMode: "text",
        attachmentStagingIds: [],
      });
      const session = await prisma.agentChatSession.findUnique({ where: { id: sessionId } });
      expect(session?.userId).toBe(owner.id);
      const firstMessages = await prisma.agentChatMessage.findMany({ where: { sessionId } });
      expect(firstMessages).toHaveLength(1);
      expect(firstMessages[0].role).toBe("user");
      expect(firstMessages[0].content).toBe("你好，帮我查一下");

      // ── existing session path appends without creating a session ────────────
      const sessionCountBefore = await prisma.agentChatSession.count({ where: { userId: owner.id } });
      const sameSessionId = await commitAgentChatUserMessage(actor, {
        needsNewSession: false,
        existingSessionId: sessionId,
        agentRunId: run.id,
        newSessionTitle: "ignored",
        message: "再补充一句",
        attachmentStagingIds: [],
      });
      expect(sameSessionId).toBe(sessionId);
      expect(await prisma.agentChatSession.count({ where: { userId: owner.id } })).toBe(sessionCountBefore);
      expect(await prisma.agentChatMessage.count({ where: { sessionId } })).toBe(2);

      // ── rollback: attachment bind fails → no orphan session / message ───────
      const sessionsBefore = await prisma.agentChatSession.count({ where: { userId: owner.id } });
      const messagesBefore = await prisma.agentChatMessage.count();
      const rollbackErr = await commitAgentChatUserMessage(actor, {
        needsNewSession: true,
        existingSessionId: null,
        agentRunId: run.id,
        newSessionTitle: "带无效附件的回合",
        message: "看看这个附件",
        attachmentStagingIds: ["does-not-exist"],
      }).catch((e) => e);
      expect(rollbackErr).toBeInstanceOf(StagingError);
      expect(await prisma.agentChatSession.count({ where: { userId: owner.id } })).toBe(sessionsBefore);
      expect(await prisma.agentChatMessage.count()).toBe(messagesBefore);

      // ── assertOwnedInvoiceStagingFiles: background-job owner gate ───────────
      const mkStaging = (createdById: string, suffix: string) =>
        prisma.agentInvoiceStagingFile.create({
          data: {
            createdById,
            originalFileName: "invoice.pdf",
            storageKey: `${createdById}/${suffix}.pdf`,
            mimeType: "application/pdf",
            fileSize: 1000,
            sha256: `sha-${suffix}`,
            status: "UPLOADED",
            version: 1,
            expiresAt: new Date(Date.now() + 60 * 60 * 1000),
          },
        });
      const ownedA = await mkStaging(owner.id, "a");
      const ownedB = await mkStaging(owner.id, "b");
      const foreign = await mkStaging(other.id, "c");

      await expect(
        assertOwnedInvoiceStagingFiles({ stagingFileIds: [ownedA.id, ownedB.id], userId: owner.id }),
      ).resolves.toBeUndefined();

      const foreignErr = await assertOwnedInvoiceStagingFiles({
        stagingFileIds: [ownedA.id, foreign.id],
        userId: owner.id,
      }).catch((e) => e);
      expect(foreignErr).toBeInstanceOf(InvoiceStagingError);
      expect(foreignErr.code).toBe("INVOICE_STAGING_CHANGED");
      expect(foreignErr.httpStatus).toBe(409);

      await expect(
        assertOwnedInvoiceStagingFiles({ stagingFileIds: [ownedA.id, "missing"], userId: owner.id }),
      ).rejects.toMatchObject({ code: "INVOICE_STAGING_CHANGED", httpStatus: 409 });

      await expect(
        assertOwnedInvoiceStagingFiles({ stagingFileIds: [], userId: owner.id }),
      ).resolves.toBeUndefined();

      // ── executeAgentToolForRun: guards + run→actor + session isolation ──────
      const endedRun = await prisma.agentRun.create({
        data: { userId: owner.id, role: "ADMIN", status: "ENDED", source: "CHAT" },
      });

      await expect(
        executeAgentToolForRun({ agentRunId: run.id, actionKey: "  ", input: {} }),
      ).rejects.toBeInstanceOf(AgentActionInputError);
      await expect(
        executeAgentToolForRun({ agentRunId: "", actionKey: "crm.get_customer_context", input: {} }),
      ).rejects.toBeInstanceOf(AgentActionInputError);

      // nonexistent run rejected
      await expect(
        executeAgentToolForRun({
          agentRunId: "run-missing",
          actionKey: "crm.get_customer_context",
          input: {},
        }),
      ).rejects.toBeInstanceOf(AgentActionInputError);

      // inactive run rejected (not ACTIVE)
      await expect(
        executeAgentToolForRun({
          agentRunId: endedRun.id,
          actionKey: "crm.get_customer_context",
          input: {},
        }),
      ).rejects.toBeInstanceOf(AgentActionForbiddenError);

      // valid run but unknown action rejected
      await expect(
        executeAgentToolForRun({
          agentRunId: run.id,
          actionKey: "does.not_exist",
          input: {},
        }),
      ).rejects.toBeInstanceOf(AgentActionInputError);

      // chat-session isolation enforced before action dispatch: a foreign chat
      // session must be rejected even with a valid run + actor.
      const foreignSession = await prisma.agentChatSession.create({
        data: { userId: other.id, status: "ACTIVE", source: "CHAT" },
      });
      await expect(
        executeAgentToolForRun({
          agentRunId: run.id,
          actionKey: "does.not_exist",
          input: {},
          chatSessionId: foreignSession.id,
        }),
      ).rejects.toBeInstanceOf(AgentActionForbiddenError);
    });
  }, 120_000);
});

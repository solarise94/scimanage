import type { Session } from "next-auth";
import { describe, expect, it } from "vitest";
import { withTempSmokeDb } from "../../../../scripts/lib/temp-smoke-db";

/**
 * T1.2: AgentRun / AgentActionLog runtime persistence service.
 * The adapters (`run-context.ts` / `logs.ts`) are prisma-free re-exports of
 * `@/lib/application/agent-runs` + `@/lib/application/agent-action-logs`.
 * Covers run→actor refresh, ownership/active checks, chat-session isolation and
 * action-log write. All against a temp SQLite db.
 */
function fakeSession(user: {
  id: string;
  role: string;
  name?: string | null;
  email?: string | null;
}): Session {
  return {
    user: {
      id: user.id,
      role: user.role,
      name: user.name ?? null,
      email: user.email ?? null,
    },
    expires: new Date(Date.now() + 60_000).toISOString(),
  } as unknown as Session;
}

describe("agent run-context / action-log runtime service", () => {
  it("resolves live actor, enforces ownership/active and isolates chat sessions", async () => {
    await withTempSmokeDb(async () => {
      const { prisma } = await import("@/lib/prisma");
      // Exercise the prisma-free adapter surface to prove the re-exports work.
      const {
        createAgentRunFromSession,
        getOrCreateAgentRunFromSession,
        getExecutionContextFromAgentRun,
        listAgentRunsForUser,
        ensureAgentRunBelongsToSession,
        verifyChatSessionForActor,
      } = await import("@/lib/agent-actions/run-context");
      const { createAgentActionLog } = await import("@/lib/agent-actions/logs");
      const { AgentActionForbiddenError, AgentActionInputError } = await import(
        "@/lib/agent-actions/errors"
      );

      const owner = await prisma.user.create({
        data: {
          email: "t12-owner@example.com",
          name: "Owner",
          password: "test-password-hash",
          role: "USER",
        },
      });
      const other = await prisma.user.create({
        data: {
          email: "t12-other@example.com",
          name: "Other",
          password: "test-password-hash",
          role: "USER",
        },
      });

      // createAgentRunFromSession persists an ACTIVE run for the owner.
      const created = await createAgentRunFromSession(fakeSession(owner));
      expect(created.userId).toBe(owner.id);
      expect(created.status).toBe("ACTIVE");

      // getOrCreate re-uses the same run when owned; touches lastUsedAt.
      const reused = await getOrCreateAgentRunFromSession(fakeSession(owner), created.id);
      expect(reused.id).toBe(created.id);

      // Role snapshot on the run is stale (USER); User.role is bumped to ADMIN.
      await prisma.user.update({ where: { id: owner.id }, data: { role: "ADMIN" } });
      const execCtx = await getExecutionContextFromAgentRun(created.id);
      expect(execCtx.actor.userId).toBe(owner.id);
      expect(execCtx.actor.role).toBe("ADMIN"); // live User.role, not run snapshot
      expect(execCtx.invocation.agentRunId).toBe(created.id);

      // Ownership: other user cannot claim owner's run.
      await expect(
        ensureAgentRunBelongsToSession(created.id, fakeSession(other)),
      ).rejects.toBeInstanceOf(AgentActionForbiddenError);
      // Owner can.
      const ensured = await ensureAgentRunBelongsToSession(created.id, fakeSession(owner));
      expect(ensured.userId).toBe(owner.id);

      // Inactive run is rejected everywhere.
      await prisma.agentRun.update({ where: { id: created.id }, data: { status: "CLOSED" } });
      await expect(getExecutionContextFromAgentRun(created.id)).rejects.toBeInstanceOf(
        AgentActionForbiddenError,
      );
      await expect(
        ensureAgentRunBelongsToSession(created.id, fakeSession(owner)),
      ).rejects.toBeInstanceOf(AgentActionForbiddenError);

      // Missing run → input error.
      await expect(getExecutionContextFromAgentRun("missing-run")).rejects.toBeInstanceOf(
        AgentActionInputError,
      );

      // listAgentRunsForUser is scoped to the user.
      const ownerRuns = await listAgentRunsForUser(owner.id);
      expect(ownerRuns.map((r) => r.id)).toContain(created.id);
      const otherRuns = await listAgentRunsForUser(other.id);
      expect(otherRuns).toHaveLength(0);

      // Chat-session ownership isolation.
      const activeRun = await prisma.agentRun.create({
        data: { userId: owner.id, role: "USER", status: "ACTIVE", source: "CHAT" },
      });
      const chatSession = await prisma.agentChatSession.create({
        data: { userId: owner.id, agentRunId: activeRun.id, title: "s" },
      });
      await expect(
        verifyChatSessionForActor({
          chatSessionId: chatSession.id,
          userId: owner.id,
          agentRunId: activeRun.id,
        }),
      ).resolves.toBe(chatSession.id);
      // Wrong user.
      await expect(
        verifyChatSessionForActor({ chatSessionId: chatSession.id, userId: other.id }),
      ).rejects.toBeInstanceOf(AgentActionForbiddenError);
      // Bound to a different run.
      await expect(
        verifyChatSessionForActor({
          chatSessionId: chatSession.id,
          userId: owner.id,
          agentRunId: "another-run",
        }),
      ).rejects.toBeInstanceOf(AgentActionForbiddenError);

      // Action-log write goes through the runtime service.
      const action = {
        key: "test.action",
        riskLevel: "safe" as const,
      };
      const log = await createAgentActionLog(
        {
          actor: { userId: owner.id, role: "ADMIN" },
          invocation: { channel: "agent", agentRunId: activeRun.id },
        },
        action as never,
        { status: "SUCCESS", input: { a: 1 }, output: { ok: true }, proposalId: null },
      );
      const persisted = await prisma.agentActionLog.findUnique({ where: { id: log.id } });
      expect(persisted?.userId).toBe(owner.id);
      expect(persisted?.agentRunId).toBe(activeRun.id);
      expect(persisted?.actionKey).toBe("test.action");
      expect(persisted?.inputJson).toBe(JSON.stringify({ a: 1 }));
    });
  }, 120_000);
});

import { describe, expect, it } from "vitest";
import { withTempSmokeDb } from "../../../../scripts/lib/temp-smoke-db";

describe("resolveCurrentBusinessActor", () => {
  it("refreshes identity from User for web and agent-run paths", async () => {
    await withTempSmokeDb(async () => {
      const { prisma } = await import("@/lib/prisma");
      const { resolveCurrentBusinessActor } = await import("@/lib/application/actor");
      const { getExecutionContextFromAgentRun } = await import("@/lib/agent-actions/run-context");
      const {
        ForbiddenError,
        UnauthenticatedError,
      } = await import("@/lib/application/errors");

      const webUser = await prisma.user.create({
        data: {
          email: "t0-actor-web@example.com",
          name: "Web Actor",
          password: "test-password-hash",
          role: "ADMIN",
        },
      });

      const webActor = await resolveCurrentBusinessActor({
        userId: webUser.id,
        channel: "web",
        sessionActor: { role: "USER", name: "stale", email: "stale@example.com" },
      });
      expect(webActor).toEqual({
        userId: webUser.id,
        role: "ADMIN",
        department: "FIELD_SALES",
        name: "Web Actor",
        email: "t0-actor-web@example.com",
      });

      const runUser = await prisma.user.create({
        data: {
          email: "t0-actor-run@example.com",
          name: "Run Actor",
          password: "test-password-hash",
          role: "ADMIN",
        },
      });
      const run = await prisma.agentRun.create({
        data: {
          userId: runUser.id,
          role: "USER",
          name: "snapshot-name",
          email: "snapshot@example.com",
          status: "ACTIVE",
          source: "CHAT",
        },
      });

      const refreshed = await resolveCurrentBusinessActor({
        userId: runUser.id,
        channel: "agent",
        agentRunId: run.id,
      });
      expect(refreshed.role).toBe("ADMIN");
      expect(refreshed.name).toBe("Run Actor");

      const execCtx = await getExecutionContextFromAgentRun(run.id);
      expect(execCtx.actor.role).toBe("ADMIN");
      expect(execCtx.actor.userId).toBe(runUser.id);
      expect(execCtx.invocation.channel).toBe("agent");
      expect(execCtx.invocation.agentRunId).toBe(run.id);

      const owner = await prisma.user.create({
        data: {
          email: "t0-owner@example.com",
          name: "Owner",
          password: "test-password-hash",
          role: "USER",
        },
      });
      const other = await prisma.user.create({
        data: {
          email: "t0-other@example.com",
          name: "Other",
          password: "test-password-hash",
          role: "USER",
        },
      });
      const activeRun = await prisma.agentRun.create({
        data: {
          userId: owner.id,
          role: "USER",
          status: "ACTIVE",
          source: "CHAT",
        },
      });
      const inactiveRun = await prisma.agentRun.create({
        data: {
          userId: owner.id,
          role: "USER",
          status: "CLOSED",
          source: "CHAT",
        },
      });

      await expect(
        resolveCurrentBusinessActor({
          userId: "missing-user",
          channel: "web",
        }),
      ).rejects.toBeInstanceOf(UnauthenticatedError);

      await expect(
        resolveCurrentBusinessActor({
          userId: owner.id,
          channel: "agent",
          agentRunId: inactiveRun.id,
          touchAgentRun: false,
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);

      await expect(
        resolveCurrentBusinessActor({
          userId: other.id,
          channel: "agent",
          agentRunId: activeRun.id,
          touchAgentRun: false,
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  }, 120_000);
});

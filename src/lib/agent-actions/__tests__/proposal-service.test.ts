import { describe, expect, it } from "vitest";
import { withTempSmokeDb } from "../../../../scripts/lib/temp-smoke-db";

import type { AgentExecutionContext, BusinessActor } from "@/lib/application/actor";

const agentExecCtx = (actor: BusinessActor): AgentExecutionContext => ({
  actor,
  invocation: { channel: "agent" },
});

/**
 * T1.1: proposal claim/confirm/reject runtime service.
 * Covers ownership (越权), duplicate confirm, confirm/reject race, and the
 * server-side lifecycle-registry revert hook on reject / confirm failure.
 */
describe("agent proposal confirm/reject service", () => {
  it("enforces ownership, single confirm, race safety and lifecycle revert", async () => {
    await withTempSmokeDb(async () => {
      const { prisma } = await import("@/lib/prisma");
      const { registerAgentAction } = await import("@/lib/agent-actions/registry");
      const { registerProposalLifecycle } = await import(
        "@/lib/application/proposal-lifecycle"
      );
      const { confirmAgentProposal, rejectAgentProposal } = await import(
        "@/lib/agent-actions/proposals"
      );
      const { AgentActionConflictError, AgentActionForbiddenError } = await import(
        "@/lib/agent-actions/errors"
      );

      // Test-only lifecycle handler + actions (registered into the shared registry).
      let revertCalls = 0;
      registerProposalLifecycle({
        key: "test.lifecycle",
        async revert() {
          revertCalls += 1;
        },
      });

      registerAgentAction({
        key: "test.echo",
        title: "Test Echo",
        description: "",
        domain: "agent",
        riskLevel: "confirm",
        readOnly: false,
        inputSchema: {},
        outputSchema: {},
        parseInput: (raw) => (raw ?? {}) as Record<string, unknown>,
        availability: async () => true,
        execute: async (_actor, input) => ({ echoed: true, input }),
      });

      registerAgentAction({
        key: "test.fail",
        title: "Test Fail",
        description: "",
        domain: "agent",
        riskLevel: "confirm",
        readOnly: false,
        inputSchema: {},
        outputSchema: {},
        proposalLifecycleKey: "test.lifecycle",
        parseInput: (raw) => (raw ?? {}) as Record<string, unknown>,
        availability: async () => true,
        execute: async () => {
          throw new Error("boom");
        },
      });

      const owner = await prisma.user.create({
        data: {
          email: "t11-owner@example.com",
          name: "Owner",
          password: "test-password-hash",
          role: "ADMIN",
        },
      });
      const other = await prisma.user.create({
        data: {
          email: "t11-other@example.com",
          name: "Other",
          password: "test-password-hash",
          role: "ADMIN",
        },
      });

      const ownerActor = { userId: owner.id, role: "ADMIN", name: "Owner", email: owner.email };
      const otherActor = { userId: other.id, role: "ADMIN", name: "Other", email: other.email };

      const makeProposal = (actionKey: string) =>
        prisma.agentProposal.create({
          data: {
            userId: owner.id,
            actionKey,
            title: "t",
            summary: "s",
            riskLevel: "confirm",
            inputJson: JSON.stringify({ hello: "world" }),
            status: "PENDING",
          },
        });

      // ── 越权：非 owner 不能 confirm / reject ──
      const foreign = await makeProposal("test.echo");
      await expect(confirmAgentProposal(agentExecCtx(otherActor), foreign.id)).rejects.toBeInstanceOf(
        AgentActionForbiddenError,
      );
      await expect(rejectAgentProposal(agentExecCtx(otherActor), foreign.id)).rejects.toBeInstanceOf(
        AgentActionForbiddenError,
      );
      const foreignAfter = await prisma.agentProposal.findUnique({ where: { id: foreign.id } });
      expect(foreignAfter?.status).toBe("PENDING");

      // ── 重复 confirm：第一次成功，第二次 409 ──
      const echo = await makeProposal("test.echo");
      const first = await confirmAgentProposal(agentExecCtx(ownerActor), echo.id);
      expect(first.proposal.status).toBe("CONFIRMED");
      expect(first.result).toEqual({ echoed: true, input: { hello: "world" } });
      await expect(confirmAgentProposal(agentExecCtx(ownerActor), echo.id)).rejects.toBeInstanceOf(
        AgentActionConflictError,
      );

      // ── confirm/reject 竞争：恰好一个成功，另一个 409 ──
      const race = await makeProposal("test.echo");
      const settled = await Promise.allSettled([
        confirmAgentProposal(agentExecCtx(ownerActor), race.id),
        rejectAgentProposal(agentExecCtx(ownerActor), race.id),
      ]);
      const fulfilled = settled.filter((s) => s.status === "fulfilled");
      const rejected = settled.filter((s) => s.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
        AgentActionConflictError,
      );
      const raceAfter = await prisma.agentProposal.findUnique({ where: { id: race.id } });
      expect(["CONFIRMED", "REJECTED"]).toContain(raceAfter?.status);

      // ── reject 触发领域生命周期 revert ──
      const rejectLc = await makeProposal("test.fail");
      await rejectAgentProposal(agentExecCtx(ownerActor), rejectLc.id);
      expect(revertCalls).toBe(1);
      const rejectLcAfter = await prisma.agentProposal.findUnique({ where: { id: rejectLc.id } });
      expect(rejectLcAfter?.status).toBe("REJECTED");

      // ── confirm 失败 → FAILED + 生命周期 revert ──
      const failLc = await makeProposal("test.fail");
      await expect(confirmAgentProposal(agentExecCtx(ownerActor), failLc.id)).rejects.toThrow("boom");
      expect(revertCalls).toBe(2);
      const failLcAfter = await prisma.agentProposal.findUnique({ where: { id: failLc.id } });
      expect(failLcAfter?.status).toBe("FAILED");
    });
  }, 120_000);
});

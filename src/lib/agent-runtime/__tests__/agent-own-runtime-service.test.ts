import { describe, expect, it } from "vitest";
import { withTempSmokeDb } from "../../../../scripts/lib/temp-smoke-db";

/**
 * T1.5: Agent-own-model runtime services that agent.ts / finance-bank-flow.ts
 * were converged onto (previously direct Prisma in the action adapters).
 *
 * Covers:
 *  - memory#listRecallCandidates (scope-first: current userId only, ACTIVE|STALE
 *    entity + ACTIVE memory, embedding required, entityType filter)
 *  - staging#getAttachmentStatusVersion (raw status/version read)
 *  - proposals#getAgentProposalStatus (raw status read / null when missing)
 *  - agent-task-workspace#listActiveWorkspacesByKind (owner + kind + ACTIVE scope)
 *
 * All against a temp SQLite db; no real dev/demo/prod data touched.
 */
describe("agent-own-model runtime services (T1.5 convergence)", () => {
  it("scopes recall candidates / status reads / workspace listing to the owner", async () => {
    await withTempSmokeDb(async () => {
      const { prisma } = await import("@/lib/prisma");
      const { listRecallCandidates } = await import("@/lib/agent-runtime/memory");
      const { getAttachmentStatusVersion } = await import(
        "@/lib/agent-attachments/staging"
      );
      const { getAgentProposalStatus } = await import("@/lib/agent-actions/proposals");
      const { listActiveWorkspacesByKind } = await import("@/lib/agent-task-workspace");

      const owner = await prisma.user.create({
        data: {
          email: "t15-owner@example.com",
          name: "Owner",
          password: "test-password-hash",
          role: "USER",
        },
      });
      const other = await prisma.user.create({
        data: {
          email: "t15-other@example.com",
          name: "Other",
          password: "test-password-hash",
          role: "USER",
        },
      });

      const embedding = Buffer.from(new Float32Array([0.1, 0.2, 0.3]).buffer);

      // ── entity memory candidates ──────────────────────────────────────────
      await prisma.agentEntityMemory.createMany({
        data: [
          {
            userId: owner.id,
            entityType: "project",
            entityId: "p-active",
            name: "Active project",
            summary: "active",
            status: "ACTIVE",
            embeddingBytes: embedding,
          },
          {
            userId: owner.id,
            entityType: "customer",
            entityId: "c-stale",
            name: "Stale customer",
            summary: "stale",
            status: "STALE",
            embeddingBytes: embedding,
          },
          // ARCHIVED must not be recalled.
          {
            userId: owner.id,
            entityType: "project",
            entityId: "p-archived",
            name: "Archived",
            summary: "archived",
            status: "ARCHIVED",
            embeddingBytes: embedding,
          },
          // No embedding → excluded.
          {
            userId: owner.id,
            entityType: "project",
            entityId: "p-noembed",
            name: "No embed",
            summary: "no embed",
            status: "ACTIVE",
            embeddingBytes: null,
          },
          // Different user → never leaks into owner's pool.
          {
            userId: other.id,
            entityType: "project",
            entityId: "p-other",
            name: "Other user",
            summary: "other",
            status: "ACTIVE",
            embeddingBytes: embedding,
          },
        ],
      });

      await prisma.agentMemory.createMany({
        data: [
          {
            userId: owner.id,
            kind: "preference",
            content: "prefers excel",
            status: "ACTIVE",
            embeddingBytes: embedding,
          },
          // ARCHIVED memory → excluded.
          {
            userId: owner.id,
            kind: "note",
            content: "archived note",
            status: "ARCHIVED",
            embeddingBytes: embedding,
          },
          // Other user memory → excluded.
          {
            userId: other.id,
            kind: "preference",
            content: "other pref",
            status: "ACTIVE",
            embeddingBytes: embedding,
          },
        ],
      });

      const all = await listRecallCandidates(owner.id);
      expect(all.entityRows.map((r) => r.entityId).sort()).toEqual([
        "c-stale",
        "p-active",
      ]);
      expect(all.memoryRows.map((r) => r.content)).toEqual(["prefers excel"]);

      // entityType filter narrows to projects only.
      const projectsOnly = await listRecallCandidates(owner.id, { entityType: "project" });
      expect(projectsOnly.entityRows.map((r) => r.entityId)).toEqual(["p-active"]);

      // ── attachment status/version read ────────────────────────────────────
      const staging = await prisma.agentAttachmentStagingFile.create({
        data: {
          ownerUserId: owner.id,
          storageKey: "k/owner/x.pdf",
          originalName: "x.pdf",
          mimeType: "application/pdf",
          sizeBytes: 10,
          sha256: "abc",
          status: "ANALYZED",
          version: 3,
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
      const sv = await getAttachmentStatusVersion(staging.id);
      expect(sv).toEqual({ status: "ANALYZED", version: 3 });
      expect(await getAttachmentStatusVersion("missing")).toBeNull();

      // ── proposal status read ──────────────────────────────────────────────
      const proposal = await prisma.agentProposal.create({
        data: {
          userId: owner.id,
          actionKey: "finance.confirm_bank_flow_batch",
          title: "t",
          summary: "s",
          riskLevel: "confirm",
          inputJson: "{}",
          status: "PROCESSING",
        },
      });
      expect(await getAgentProposalStatus(proposal.id)).toBe("PROCESSING");
      expect(await getAgentProposalStatus("missing")).toBeNull();

      // ── active workspace listing (owner + kind + ACTIVE) ──────────────────
      await prisma.agentTaskWorkspace.createMany({
        data: [
          {
            ownerUserId: owner.id,
            kind: "BANK_FLOW",
            storagePrefix: "a",
            status: "ACTIVE",
            expiresAt: new Date(Date.now() + 60_000),
          },
          // wrong status
          {
            ownerUserId: owner.id,
            kind: "BANK_FLOW",
            storagePrefix: "b",
            status: "COMPLETED",
            expiresAt: new Date(Date.now() + 60_000),
          },
          // wrong kind
          {
            ownerUserId: owner.id,
            kind: "ORDER_IMPORT",
            storagePrefix: "c",
            status: "ACTIVE",
            expiresAt: new Date(Date.now() + 60_000),
          },
          // other owner
          {
            ownerUserId: other.id,
            kind: "BANK_FLOW",
            storagePrefix: "d",
            status: "ACTIVE",
            expiresAt: new Date(Date.now() + 60_000),
          },
        ],
      });
      const active = await listActiveWorkspacesByKind({
        ownerUserId: owner.id,
        kind: "BANK_FLOW",
        limit: 30,
      });
      expect(active.map((w) => w.storagePrefix)).toEqual(["a"]);
    });
  }, 120_000);
});

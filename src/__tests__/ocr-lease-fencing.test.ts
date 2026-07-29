/**
 * OCR lease fencing / 逐文件恢复核心场景。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { STAGING_ANALYZING_LEASE_MS } from "@/lib/staging-common";
import { stagingIdsNeedingOcr } from "@/lib/agent-actions/actions/finance-bank-flow";

const { updateMany, findFirst, transaction } = vi.hoisted(() => ({
  updateMany: vi.fn(),
  findFirst: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: transaction,
    agentImportStagingFile: {
      updateMany,
      findFirst,
    },
    agentChatSession: {
      findFirst,
    },
  },
}));

import {
  acquireImportStagingAnalyzingLeaseIfStale,
  heartbeatImportStagingLease,
  completeImportStagingBatchAnalysis,
  StagingError,
} from "@/lib/import-staging";
import { resolveChatSessionForProposal } from "@/lib/agent-runtime/proposal-chat-events";

describe("stagingIdsNeedingOcr (逐文件崩溃恢复)", () => {
  it("skips staging files already persisted in ocrProgress", () => {
    expect(
      stagingIdsNeedingOcr(["a", "b", "c"], [
        { stagingFileId: "a" },
        { stagingFileId: "c" },
      ]),
    ).toEqual(["b"]);
  });

  it("returns all ids when no progress yet", () => {
    expect(stagingIdsNeedingOcr(["a", "b"], undefined)).toEqual(["a", "b"]);
    expect(stagingIdsNeedingOcr(["a", "b"], [])).toEqual(["a", "b"]);
  });
});

describe("acquireImportStagingAnalyzingLeaseIfStale (fresh vs stale)", () => {
  beforeEach(() => {
    updateMany.mockReset();
  });

  it("refuses to steal a fresh ANALYZING lease", async () => {
    const now = new Date("2026-07-23T12:00:00.000Z");
    updateMany.mockResolvedValue({ count: 0 });

    const result = await acquireImportStagingAnalyzingLeaseIfStale({
      userId: "u1",
      leaseOwner: "new-worker",
      now,
      items: [{ stagingFileId: "s1", expectedSha256: "hash" }],
    });

    expect(result.ok).toBe(false);
    expect(updateMany).toHaveBeenCalledTimes(1);
    const where = updateMany.mock.calls[0][0].where;
    expect(where.status).toBe("ANALYZING");
    expect(where.OR).toEqual([
      { leaseStartedAt: null },
      { leaseStartedAt: { lte: new Date(now.getTime() - STAGING_ANALYZING_LEASE_MS) } },
    ]);
  });

  it("takes over only when leaseStartedAt is past the analyzing window", async () => {
    const now = new Date("2026-07-23T12:00:00.000Z");
    updateMany.mockResolvedValue({ count: 1 });

    const result = await acquireImportStagingAnalyzingLeaseIfStale({
      userId: "u1",
      leaseOwner: "new-worker",
      now,
      items: [
        { stagingFileId: "s1", expectedSha256: "h1" },
        { stagingFileId: "s2", expectedSha256: "h2" },
      ],
    });

    expect(result.ok).toBe(true);
    expect(updateMany).toHaveBeenCalledTimes(2);
    expect(updateMany.mock.calls[0][0].data).toEqual({
      leaseOwner: "new-worker",
      leaseStartedAt: now,
    });
  });
});

describe("old worker fencing", () => {
  beforeEach(() => {
    updateMany.mockReset();
    transaction.mockReset();
    transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
      fn({ agentImportStagingFile: { updateMany } }),
    );
  });

  it("heartbeat fails after leaseOwner is taken over", async () => {
    updateMany.mockResolvedValue({ count: 0 });

    const beat = await heartbeatImportStagingLease({
      stagingFileId: "s1",
      userId: "u1",
      expectedSha256: "hash",
      leaseOwner: "old-worker",
    });

    expect(beat.ok).toBe(false);
    expect(updateMany.mock.calls[0][0].where.leaseOwner).toBe("old-worker");
  });

  it("complete batch write-back rejects mismatched leaseOwner", async () => {
    updateMany.mockResolvedValue({ count: 0 });

    await expect(
      completeImportStagingBatchAnalysis({
        userId: "u1",
        sessionId: "ws1",
        parserKey: "BANK_FLOW",
        leaseOwner: "old-worker",
        items: [{ stagingFileId: "s1", expectedSha256: "hash" }],
      }),
    ).rejects.toBeInstanceOf(StagingError);

    expect(updateMany.mock.calls[0][0].where.leaseOwner).toBe("old-worker");
  });
});

describe("resolveChatSessionForProposal", () => {
  beforeEach(() => {
    findFirst.mockReset();
  });

  it("does not fall back to latest session when agentRunId misses", async () => {
    findFirst.mockResolvedValue(null);

    const session = await resolveChatSessionForProposal(
      { userId: "u1", role: "ADMIN" },
      { agentRunId: "run-missing" },
    );

    expect(session).toBeNull();
    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(findFirst.mock.calls[0][0].where).toMatchObject({
      agentRunId: "run-missing",
      userId: "u1",
    });
  });

  it("falls back to latest active session only when agentRunId is null", async () => {
    findFirst.mockResolvedValue({ id: "sess-latest", agentRunId: null });

    const session = await resolveChatSessionForProposal(
      { userId: "u1", role: "ADMIN" },
      { agentRunId: null },
    );

    expect(session?.id).toBe("sess-latest");
    expect(findFirst.mock.calls[0][0].where).toEqual({
      userId: "u1",
      status: "ACTIVE",
    });
  });
});

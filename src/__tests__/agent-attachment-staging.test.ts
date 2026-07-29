/**
 * 通用附件 staging 生命周期 / 绑定 / 路由幂等核心场景（docs §4/§5/§6）。
 * 直接导入生产模块 src/lib/agent-attachments/*，mock prisma。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STAGING_ANALYZING_LEASE_MS } from "@/lib/staging-common";

const { findFirst, findMany, updateMany, findUnique, findUniqueOrThrow } = vi.hoisted(() => ({
  findFirst: vi.fn(),
  findMany: vi.fn(),
  updateMany: vi.fn(),
  findUnique: vi.fn(),
  findUniqueOrThrow: vi.fn(),
}));

// routeFindMany / invoiceFindUnique 专用于 resumePendingInvoiceRoutes 测试（不与其他用例共享 mock 状态）。
const { routeFindMany, invoiceFindUnique } = vi.hoisted(() => ({
  routeFindMany: vi.fn(),
  invoiceFindUnique: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    agentAttachmentStagingFile: { findFirst, findMany, updateMany, findUnique, findUniqueOrThrow },
    agentAttachmentRoute: { updateMany, findFirst, findUnique, findMany: routeFindMany },
    agentInvoiceStagingFile: { findUnique: invoiceFindUnique },
  },
}));

import {
  assertAttachmentInCurrentRun,
  claimAttachmentForAnalysis,
  completeAttachmentAnalysis,
  bindAttachmentsToSessionAndRun,
  validateVerifiedAgentAttachmentContext,
} from "@/lib/agent-attachments/staging";
import {
  casMarkRouteStale,
  invoiceAdoptionRouteKey,
  markRouteTargetBound,
  projectNoteItemRouteKey,
  resumePendingInvoiceRoutes,
} from "@/lib/agent-attachments/routes";
import { StagingError } from "@/lib/staging-common";

const NOW = new Date("2026-07-24T12:00:00.000Z");

describe("claimAttachmentForAnalysis（10 分钟 lease / fencing / 3 次上限）", () => {
  beforeEach(() => {
    findFirst.mockReset();
    updateMany.mockReset();
  });

  it("从 UPLOADED 成功 claim", async () => {
    findFirst.mockResolvedValue({
      status: "UPLOADED",
      version: 1,
      analysisAttempts: 0,
      leaseStartedAt: null,
      expiresAt: new Date(NOW.getTime() + 60_000),
    });
    updateMany.mockResolvedValue({ count: 1 });

    const result = await claimAttachmentForAnalysis({
      stagingId: "s1",
      userId: "u1",
      leaseOwner: "w1",
      expectedSha256: "h",
      expectedVersion: 1,
      now: NOW,
    });

    expect(result.claimed).toBe(true);
    expect(updateMany.mock.calls[0][0].data).toMatchObject({
      status: "ANALYZING",
      leaseOwner: "w1",
      analysisAttempts: { increment: 1 },
    });
  });

  it("不抢占 fresh ANALYZING lease", async () => {
    findFirst.mockResolvedValue({
      status: "ANALYZING",
      version: 1,
      analysisAttempts: 1,
      // fresh：leaseStartedAt 在 10 分钟窗口内
      leaseStartedAt: new Date(NOW.getTime() - 1_000),
      expiresAt: new Date(NOW.getTime() + 60_000),
    });

    const result = await claimAttachmentForAnalysis({
      stagingId: "s1",
      userId: "u1",
      leaseOwner: "w2",
      expectedSha256: "h",
      expectedVersion: 1,
      now: NOW,
    });

    expect(result.claimed).toBe(false);
    expect(result.reason).toBe("FRESH_LEASE");
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("仅在 lease 过期后接管 ANALYZING", async () => {
    findFirst.mockResolvedValue({
      status: "ANALYZING",
      version: 1,
      analysisAttempts: 1,
      leaseStartedAt: new Date(NOW.getTime() - STAGING_ANALYZING_LEASE_MS - 1_000),
      expiresAt: new Date(NOW.getTime() + 60_000),
    });
    updateMany.mockResolvedValue({ count: 1 });

    const result = await claimAttachmentForAnalysis({
      stagingId: "s1",
      userId: "u1",
      leaseOwner: "w2",
      expectedSha256: "h",
      expectedVersion: 1,
      now: NOW,
    });

    expect(result.claimed).toBe(true);
    expect(updateMany.mock.calls[0][0].where.OR).toEqual([
      { leaseStartedAt: null },
      { leaseStartedAt: { lte: new Date(NOW.getTime() - STAGING_ANALYZING_LEASE_MS) } },
    ]);
  });

  it("达到 3 次解析上限后拒绝自动 retry", async () => {
    findFirst.mockResolvedValue({
      status: "FAILED",
      version: 1,
      analysisAttempts: 3,
      leaseStartedAt: null,
      expiresAt: new Date(NOW.getTime() + 60_000),
    });

    const result = await claimAttachmentForAnalysis({
      stagingId: "s1",
      userId: "u1",
      leaseOwner: "w1",
      expectedSha256: "h",
      expectedVersion: 1,
      now: NOW,
    });

    expect(result.claimed).toBe(false);
    expect(result.reason).toBe("ATTEMPTS_EXCEEDED");
  });

  it("版本不一致拒绝 claim", async () => {
    findFirst.mockResolvedValue({
      status: "UPLOADED",
      version: 2,
      analysisAttempts: 0,
      leaseStartedAt: null,
      expiresAt: new Date(NOW.getTime() + 60_000),
    });

    const result = await claimAttachmentForAnalysis({
      stagingId: "s1",
      userId: "u1",
      leaseOwner: "w1",
      expectedSha256: "h",
      expectedVersion: 1,
      now: NOW,
    });

    expect(result.claimed).toBe(false);
    expect(result.reason).toBe("VERSION_CONFLICT");
  });
});

describe("bindAttachmentsToSessionAndRun（全量原子绑定，任一失败即整体拒绝）", () => {
  beforeEach(() => {
    findMany.mockReset();
    updateMany.mockReset();
  });

  it("全部合法时全量绑定；WHERE 用 OR 表达 null-or-match", async () => {
    // P1#3: 先 findMany 全量校验，再逐条 updateMany 写绑定。
    findMany.mockResolvedValue([
      { id: "s1", status: "UPLOADED", expiresAt: new Date(NOW.getTime() + 60_000), chatSessionId: null, agentRunId: null },
      { id: "s2", status: "ANALYZED", expiresAt: new Date(NOW.getTime() + 60_000), chatSessionId: null, agentRunId: null },
    ]);
    updateMany.mockResolvedValue({ count: 1 }); // 两条都成功

    const result = await bindAttachmentsToSessionAndRun({
      stagingIds: ["s1", "s2"],
      userId: "u1",
      chatSessionId: "sess-1",
      agentRunId: "run-1",
      now: NOW,
    });

    expect(result.bound).toBe(2);
    // WHERE 使用 OR 表达 null-or-match，绝不覆盖不同值。
    const where = updateMany.mock.calls[0][0].where;
    expect(where.AND).toEqual([
      { OR: [{ chatSessionId: null }, { chatSessionId: "sess-1" }] },
      { OR: [{ agentRunId: null }, { agentRunId: "run-1" }] },
    ]);
  });

  it("任一附件已绑定他 session → 整体抛 409，零副作用（不写任何绑定）", async () => {
    // s2 已绑定到其他 session：findMany 读取后校验即发现，updateMany 不应被调用。
    findMany.mockResolvedValue([
      { id: "s1", status: "UPLOADED", expiresAt: new Date(NOW.getTime() + 60_000), chatSessionId: null, agentRunId: null },
      { id: "s2", status: "UPLOADED", expiresAt: new Date(NOW.getTime() + 60_000), chatSessionId: "other-sess", agentRunId: null },
    ]);

    await expect(
      bindAttachmentsToSessionAndRun({
        stagingIds: ["s1", "s2"],
        userId: "u1",
        chatSessionId: "sess-1",
        agentRunId: "run-1",
        now: NOW,
      }),
    ).rejects.toThrow(StagingError);
    // 校验阶段就拒绝，updateMany 从未被调用（零写入）。
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("findMany 通过但写入 0 行（并发竞争）→ 抛 409", async () => {
    findMany.mockResolvedValue([
      { id: "s1", status: "UPLOADED", expiresAt: new Date(NOW.getTime() + 60_000), chatSessionId: null, agentRunId: null },
    ]);
    updateMany.mockResolvedValue({ count: 0 }); // 并发改了

    await expect(
      bindAttachmentsToSessionAndRun({
        stagingIds: ["s1"],
        userId: "u1",
        chatSessionId: "sess-1",
        agentRunId: "run-1",
        now: NOW,
      }),
    ).rejects.toThrow(StagingError);
  });
});

describe("completeAttachmentAnalysis（解析写回递增 version）", () => {
  beforeEach(() => {
    updateMany.mockReset();
    findUnique.mockReset();
    findUniqueOrThrow.mockReset();
  });

  it("P1#1: 成功写回后返回递增后的 version（调用方须接住用作后续 expectedVersion）", async () => {
    // updateMany 成功（count=1），findUniqueOrThrow 读回 version=2（原 1 + 1）。
    updateMany.mockResolvedValue({ count: 1 });
    findUniqueOrThrow.mockResolvedValue({ id: "s1", version: 2, status: "ANALYZED" });

    const result = await completeAttachmentAnalysis({
      stagingId: "s1",
      userId: "u1",
      leaseOwner: "w1",
      expectedSha256: "h",
      analysisJson: "{}",
      warningsJson: "[]",
    });

    expect(result.version).toBe(2);
    expect(result.status).toBe("ANALYZED");
    // updateMany 确实把 version 递增。
    expect(updateMany.mock.calls[0][0].data.version).toEqual({ increment: 1 });
  });

  it("P1#1: lease 失效（count=0）抛 ATTACHMENT_CHANGED", async () => {
    updateMany.mockResolvedValue({ count: 0 });

    await expect(
      completeAttachmentAnalysis({
        stagingId: "s1",
        userId: "u1",
        leaseOwner: "stale-owner",
        expectedSha256: "h",
        analysisJson: "{}",
        warningsJson: "[]",
      }),
    ).rejects.toThrow(StagingError);
  });
});

describe("assertAttachmentInCurrentRun（P1#2 层 A：跨 run 拒绝，fail-closed）", () => {
  it("agentRunId 为 null（未绑定）→ 允许", () => {
    expect(() => assertAttachmentInCurrentRun({ agentRunId: null }, "run-1")).not.toThrow();
  });

  it("agentRunId 匹配当前 run → 允许", () => {
    expect(() => assertAttachmentInCurrentRun({ agentRunId: "run-1" }, "run-1")).not.toThrow();
  });

  it("agentRunId 绑定到其他 run → 抛 409", () => {
    expect(() => assertAttachmentInCurrentRun({ agentRunId: "run-other" }, "run-1")).toThrow(StagingError);
  });

  it("fail-closed：staging 已绑定但 actor 无 run 上下文 → 拒绝（防绕过）", () => {
    expect(() => assertAttachmentInCurrentRun({ agentRunId: "run-1" }, null)).toThrow(StagingError);
    expect(() => assertAttachmentInCurrentRun({ agentRunId: "run-1" }, undefined)).toThrow(StagingError);
  });

  it("staging 未绑定且 actor 无 run → 允许（合法的未绑定附件）", () => {
    expect(() => assertAttachmentInCurrentRun({ agentRunId: null }, null)).not.toThrow();
    expect(() => assertAttachmentInCurrentRun({ agentRunId: null }, undefined)).not.toThrow();
  });
});

describe("validateVerifiedAgentAttachmentContext（注入 runtime 前的服务端校验）", () => {
  beforeEach(() => {
    findUnique.mockReset();
  });

  it("跨用户访问返回 null（不伪装可用）", async () => {
    // findUnique 返回属于其他用户的 staging。
    findUnique.mockResolvedValue({
      id: "s1",
      ownerUserId: "someone-else",
      status: "UPLOADED",
      expiresAt: new Date(NOW.getTime() + 60_000),
    });

    const result = await validateVerifiedAgentAttachmentContext({
      userId: "u1",
      stagingFileId: "s1",
    });

    expect(result).toBeNull();
  });

  it("不存在的 staging 返回 null", async () => {
    findUnique.mockResolvedValue(null);
    const result = await validateVerifiedAgentAttachmentContext({
      userId: "u1",
      stagingFileId: "missing",
    });
    expect(result).toBeNull();
  });
});

describe("路由幂等键与 STALE CAS（§5.1）", () => {
  beforeEach(() => {
    updateMany.mockReset();
  });

  it("幂等键格式稳定（不含随机值）", () => {
    expect(invoiceAdoptionRouteKey("u1", "s1")).toBe("INVOICE_STAGING:u1:s1");
    expect(projectNoteItemRouteKey("p1", "s1")).toBe("PROJECT_NOTE:p1:s1");
  });

  it("casMarkRouteStale 以 id+activeRouteKey+state 为 where", async () => {
    updateMany.mockResolvedValue({ count: 1 });
    const ok = await casMarkRouteStale({
      routeId: "r1",
      activeRouteKey: "INVOICE_STAGING:u1:s1",
      expectedStates: ["PROMOTED", "FAILED"],
    });
    expect(ok).toBe(true);
    expect(updateMany.mock.calls[0][0].where).toMatchObject({
      id: "r1",
      activeRouteKey: "INVOICE_STAGING:u1:s1",
      state: { in: ["PROMOTED", "FAILED"] },
    });
    expect(updateMany.mock.calls[0][0].data).toEqual({ state: "STALE", activeRouteKey: null });
  });

  it("markRouteTargetBound fencing：CAS 带 activeRouteKey+state=PENDING，恢复清键后旧 worker 写 0 行", async () => {
    // 恢复任务已把 route 标 FAILED 并清空 activeRouteKey → 旧 worker 的 CAS 写 0 行 → claimed=false。
    updateMany.mockResolvedValueOnce({ count: 0 });

    const claimed = await markRouteTargetBound({
      routeId: "r1",
      activeRouteKey: "INVOICE_STAGING:u1:s1",
      targetId: "invoice-id-1",
    });
    expect(claimed).toBe(false);
    // WHERE 必须含 activeRouteKey + state=PENDING（fencing 条件）。
    expect(updateMany.mock.calls[0][0].where).toMatchObject({
      id: "r1",
      activeRouteKey: "INVOICE_STAGING:u1:s1",
      state: "PENDING",
    });
  });

  it("markRouteTargetBound 正常认领：count=1 → claimed=true，写 PROCESSING+targetId", async () => {
    updateMany.mockResolvedValueOnce({ count: 1 });
    const claimed = await markRouteTargetBound({
      routeId: "r1",
      activeRouteKey: "INVOICE_STAGING:u1:s1",
      targetId: "invoice-id-1",
    });
    expect(claimed).toBe(true);
    expect(updateMany.mock.calls[0][0].data).toEqual({ state: "PROCESSING", targetId: "invoice-id-1" });
  });
});

describe("resumePendingInvoiceRoutes（宽限 + PENDING_FILE 门控）", () => {
  beforeEach(() => {
    routeFindMany.mockReset();
    invoiceFindUnique.mockReset();
    updateMany.mockReset();
  });

  it("宽限内活跃 PROCESSING route（updatedAt 近）→ 跳过，不抢占活跃 worker", async () => {
    const recent = new Date(Date.now() - 30_000); // 30 秒前（宽限 5 分钟内）
    routeFindMany.mockResolvedValue([
      { id: "r1", targetId: "inv-1", activeRouteKey: "k1", state: "PROCESSING", updatedAt: recent },
    ]);
    const result = await resumePendingInvoiceRoutes();
    // 宽限内不接管：不查 invoice、不写 route。
    expect(invoiceFindUnique).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
    expect(result).toEqual({ promoted: 0, failed: 0 });
  });

  it("过期 PROCESSING + 无 targetId → CAS 标 FAILED 清键", async () => {
    const stale = new Date(Date.now() - 10 * 60 * 1000); // 10 分钟前（过宽限）
    routeFindMany.mockResolvedValue([
      { id: "r1", targetId: null, activeRouteKey: "k1", state: "PROCESSING", updatedAt: stale },
    ]);
    updateMany.mockResolvedValue({ count: 1 });
    const result = await resumePendingInvoiceRoutes();
    expect(result.failed).toBe(1);
    expect(updateMany.mock.calls[0][0].data).toMatchObject({ state: "FAILED", activeRouteKey: null });
  });

  it("过期 PROCESSING + staging 为 PENDING_FILE（文件未落盘）→ 标 FAILED，不 PROMOTE", async () => {
    const stale = new Date(Date.now() - 10 * 60 * 1000);
    routeFindMany.mockResolvedValue([
      { id: "r1", targetId: "inv-1", activeRouteKey: "k1", state: "PROCESSING", updatedAt: stale },
    ]);
    invoiceFindUnique.mockResolvedValue({
      id: "inv-1", status: "PENDING_FILE", expiresAt: new Date(Date.now() + 60_000),
    });
    updateMany.mockResolvedValue({ count: 1 });
    const result = await resumePendingInvoiceRoutes();
    expect(result.promoted).toBe(0);
    expect(result.failed).toBe(1);
    expect(updateMany.mock.calls[0][0].data.state).toBe("FAILED");
  });

  it("过期 PROCESSING + staging UPLOADED 且未过期 → CAS 标 PROMOTED（复用）", async () => {
    const stale = new Date(Date.now() - 10 * 60 * 1000);
    routeFindMany.mockResolvedValue([
      { id: "r1", targetId: "inv-1", activeRouteKey: "k1", state: "PROCESSING", updatedAt: stale },
    ]);
    invoiceFindUnique.mockResolvedValue({
      id: "inv-1", status: "UPLOADED", expiresAt: new Date(Date.now() + 60_000),
    });
    updateMany.mockResolvedValue({ count: 1 });
    const result = await resumePendingInvoiceRoutes();
    expect(result.promoted).toBe(1);
    expect(updateMany.mock.calls[0][0].data).toMatchObject({ state: "PROMOTED", targetId: "inv-1" });
  });
});

describe("StagingError 携带 httpStatus（API 映射）", () => {
  it("409/410/400 可被路由层映射", () => {
    expect(new StagingError("ATTACHMENT_CHANGED", "x", 409).httpStatus).toBe(409);
    expect(new StagingError("ATTACHMENT_EXPIRED", "x", 410).httpStatus).toBe(410);
  });
});

describe("P2#1: 私有附件目录不得落入 public/（防静态泄露）", () => {
  const ORIG_STAGING = process.env.AGENT_ATTACHMENT_STAGING_DIR;
  const ORIG_PROJECT = process.env.AGENT_PROJECT_ATTACHMENT_DIR;

  afterEach(() => {
    if (ORIG_STAGING === undefined) delete process.env.AGENT_ATTACHMENT_STAGING_DIR;
    else process.env.AGENT_ATTACHMENT_STAGING_DIR = ORIG_STAGING;
    if (ORIG_PROJECT === undefined) delete process.env.AGENT_PROJECT_ATTACHMENT_DIR;
    else process.env.AGENT_PROJECT_ATTACHMENT_DIR = ORIG_PROJECT;
  });

  it("AGENT_ATTACHMENT_STAGING_DIR 误配为 public/ 子路径 → 抛 ATTACHMENT_STORAGE_INVALID", async () => {
    process.env.AGENT_ATTACHMENT_STAGING_DIR = "public/leak";
    const { getAgentAttachmentStagingRoot } = await import("@/lib/agent-attachments/storage");
    expect(() => getAgentAttachmentStagingRoot()).toThrow(StagingError);
  });

  it("AGENT_PROJECT_ATTACHMENT_DIR 误配为 public/ → 抛 ATTACHMENT_STORAGE_INVALID", async () => {
    process.env.AGENT_PROJECT_ATTACHMENT_DIR = "public/uploads";
    const { getAgentProjectAttachmentRoot } = await import("@/lib/agent-attachments/storage");
    expect(() => getAgentProjectAttachmentRoot()).toThrow(StagingError);
  });

  it("默认目录（.agent-attachments）不受影响", async () => {
    delete process.env.AGENT_ATTACHMENT_STAGING_DIR;
    const { getAgentAttachmentStagingRoot } = await import("@/lib/agent-attachments/storage");
    expect(() => getAgentAttachmentStagingRoot()).not.toThrow();
  });
});

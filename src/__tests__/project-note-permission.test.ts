/**
 * P0 回归：projects.add_note 必须用 canContributeProject（写权限），
 * "可读但不可写"的用户不能创建无附件或有附件备注。
 *
 * 通过把 canReadProject=true 而 canContributeProject=false 来构造"可读不可写"，
 * 断言 buildProposal / execute 都抛 AgentActionForbiddenError——证明 action 门控在
 * contribute（写）而非 read（读）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { canContributeProject, canReadProject } = vi.hoisted(() => ({
  canContributeProject: vi.fn(),
  canReadProject: vi.fn(),
}));

vi.mock("@/lib/permissions", () => ({
  canContributeProject,
  canReadProject,
  getReadableProjectIds: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    project: { findFirst: vi.fn(), findUnique: vi.fn() },
    projectNote: { create: vi.fn(), findUnique: vi.fn() },
    activityLog: { create: vi.fn() },
    $transaction: vi.fn(async (fn: unknown) =>
      typeof fn === "function"
        ? await (fn as (tx: unknown) => unknown)({
            projectNote: { create: vi.fn() },
            activityLog: { create: vi.fn() },
          })
        : fn,
    ),
  },
}));

// 避免触发全部 builtin action 的重型导入链；只直接导入 projects action 做副作用注册。
vi.mock("@/lib/agent-actions/actions", () => ({
  registerBuiltinAgentActions: vi.fn(),
  // registry.ensureBuiltinAgentActionsRegistered 会 fire-and-forget 调 parity 断言；
  // mock 为空实现避免触发 manifest/facade 真实校验链。
  assertBuiltinAgentActionsParity: vi.fn(async () => {}),
}));

import { getAgentAction } from "@/lib/agent-actions/registry";
import { AgentActionForbiddenError } from "@/lib/agent-actions/errors";
import { registerProjectActions } from "@/lib/agent-actions/actions/projects";

import type { AgentExecutionContext, BusinessActor } from "@/lib/application/actor";

const agentExecCtx = (actor: BusinessActor): AgentExecutionContext => ({
  actor,
  invocation: { channel: "agent" },
});

// projects action 不在导入时自注册；显式注册（mock 已隔离 prisma/permissions/重型 builtin 链）。
registerProjectActions();

const actor = { userId: "user-1", role: "USER", name: "可读不可写用户" };
const input = { projectId: "proj-1", content: "一条备注", category: "GENERAL" };

describe("projects.add_note 写权限门控（P0 回归）", () => {
  beforeEach(() => {
    canContributeProject.mockReset();
    canReadProject.mockReset();
  });

  it("action 已注册且为 confirm 级", () => {
    const action = getAgentAction("projects.add_note");
    expect(action).toBeDefined();
    expect(action!.riskLevel).toBe("confirm");
  });

  it("可读但不可写：buildProposal 抛 Forbidden", async () => {
    canReadProject.mockResolvedValue(true);
    canContributeProject.mockResolvedValue(false);
    const action = getAgentAction("projects.add_note")!;
    await expect(action.buildProposal!(agentExecCtx(actor), input)).rejects.toBeInstanceOf(AgentActionForbiddenError);
    // 证明门控走的是 contribute 检查，而非 read。
    expect(canContributeProject).toHaveBeenCalledWith("proj-1", "user-1", "USER");
  });

  it("可读但不可写：execute 抛 Forbidden", async () => {
    canReadProject.mockResolvedValue(true);
    canContributeProject.mockResolvedValue(false);
    const action = getAgentAction("projects.add_note")!;
    await expect(action.execute(agentExecCtx(actor), input)).rejects.toBeInstanceOf(AgentActionForbiddenError);
    expect(canContributeProject).toHaveBeenCalledWith("proj-1", "user-1", "USER");
  });

  it("availability 排除 REPRESENTATIVE", async () => {
    const action = getAgentAction("projects.add_note")!;
    expect(await action.availability({ userId: "r", role: "REPRESENTATIVE" })).toBe(false);
    expect(await action.availability({ userId: "u", role: "USER" })).toBe(true);
    expect(await action.availability({ userId: "a", role: "ADMIN" })).toBe(true);
  });
});

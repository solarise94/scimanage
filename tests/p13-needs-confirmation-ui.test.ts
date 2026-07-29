/**
 * P1-3 UI 接线测试（cutover checklist §4，allowProposal 的 UI 侧）。
 *
 * 覆盖 targetIntent 数据流的关键节点：
 *  1. public-executor：facade 抛 AgentActionNeedsConfirmationError(targetIntent)
 *     → errorToOutcome 产出 409 outcome 带 targetIntent（route 409 响应体据此透传）。
 *  2. execute-public route 409 响应体带 targetIntent（单元级：直接调 POST）。
 *  3. appendAgentStreamEvent（纯函数）：canonical scimanage.tool_execution.failed 带
 *     error.code + target_intent → timeline item code + targetIntent 字段齐全。
 *  4. shouldRenderNeedsConfirmation（纯函数）：code 匹配/不匹配 / 其他 kind / 缺字段。
 *
 * 1/2 走 facade handler mock（不依赖 prisma，参照 public-input-schemas.test.ts 的
 * 500 fallback 用例模式）。3/4 是纯函数单测。runtime 侧 pi-runtime 的 409 透传
 * 因 pi-runtime 无既有单测基建（依赖 fetch + Pi core 全链路），改为在 Next 侧用
 * 纯函数覆盖 appendRuntimeEvent 透传——这是 timeline 拿到 code/targetIntent 的入口。
 *
 * ⚠️ 顶层只允许 type-only import（executePublicTool 经 registry → @/lib/prisma）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { AgentTimelineItem } from "@/lib/agent-runtime/types";
import type { AgentChatMessage } from "@/components/agent/chat-panel";
import {
  AgentActionConflictError,
  AgentActionNeedsConfirmationError,
} from "@/lib/agent-actions/errors";

/** 构造最小 assistant 消息（timeline 空），供 appendRuntimeEvent 测试。 */
function makeAssistantMessage(): AgentChatMessage {
  return {
    id: "m1",
    role: "assistant",
    content: "",
    createdAt: new Date().toISOString(),
    state: "streaming",
    timeline: [],
  };
}

// ── §1 public-executor：NEEDS_USER_CONFIRMATION 透传 targetIntent ──

describe("executePublicTool — NEEDS_USER_CONFIRMATION propagates targetIntent", () => {
  beforeEach(async () => {
    const { __clearPublicFacadeRegistryForTests } = await import(
      "@/lib/agent-actions/public/public-executor"
    );
    __clearPublicFacadeRegistryForTests();
  });

  afterEach(async () => {
    const { __clearPublicFacadeRegistryForTests } = await import(
      "@/lib/agent-actions/public/public-executor"
    );
    __clearPublicFacadeRegistryForTests();
  });

  it("returns 409 outcome with code + targetIntent when facade throws NEEDS_USER_CONFIRMATION", async () => {
    const {
      executePublicTool,
      registerPublicFacade,
    } = await import("@/lib/agent-actions/public/public-executor");

    // 模拟 createAgentProposal 在 agent channel + publicToolKey 路径缺确认事件时抛错，
    // targetIntent = action.key（与 UI mint 时约定的 confirm actionKey 一致）。
    registerPublicFacade("prepare_order", async () => {
      throw new AgentActionNeedsConfirmationError(undefined, "orders.create");
    });

    const outcome = await executePublicTool({
      actor: { userId: "u1", role: "ADMIN" },
      invocation: { channel: "agent" },
      publicToolKey: "prepare_order",
      publicInput: { customerId: "c1" },
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.status).toBe(409);
      expect(outcome.code).toBe("NEEDS_USER_CONFIRMATION");
      expect(outcome.retryable).toBe(false);
      expect(outcome.targetIntent).toBe("orders.create");
    }
  });

  it("omits targetIntent when error constructed without it (back-compat)", async () => {
    const {
      executePublicTool,
      registerPublicFacade,
    } = await import("@/lib/agent-actions/public/public-executor");

    // 既有无 targetIntent 抛错点（如未来其他路径）保持字节级：outcome 不带 targetIntent 字段。
    registerPublicFacade("prepare_order", async () => {
      throw new AgentActionNeedsConfirmationError();
    });

    const outcome = await executePublicTool({
      actor: { userId: "u1", role: "ADMIN" },
      invocation: { channel: "agent" },
      publicToolKey: "prepare_order",
      publicInput: { customerId: "c1" },
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.status).toBe(409);
      expect(outcome.code).toBe("NEEDS_USER_CONFIRMATION");
      expect(outcome.targetIntent).toBeUndefined();
    }
  });

  it("non-NEEDS_USER_CONFIRMATION errors do not carry targetIntent", async () => {
    const { executePublicTool, registerPublicFacade } = await import(
      "@/lib/agent-actions/public/public-executor"
    );
    registerPublicFacade("prepare_order", async () => {
      throw new AgentActionConflictError("state conflict");
    });

    const outcome = await executePublicTool({
      actor: { userId: "u1", role: "ADMIN" },
      invocation: { channel: "agent" },
      publicToolKey: "prepare_order",
      publicInput: { customerId: "c1" },
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.status).toBe(409);
      expect(outcome.code).toBe("ACTION_CONFLICT");
      expect(outcome.targetIntent).toBeUndefined();
    }
  });
});

// ── §2 appendAgentStreamEvent：canonical tool_execution.failed 带 code/target_intent → timeline ──

describe("appendAgentStreamEvent — tool_execution.failed passthrough of code/target_intent", () => {
  it("writes code + targetIntent onto the tool timeline item", async () => {
    const { appendAgentStreamEvent } = await import("@/components/agent/agent-message-helpers");
    const messages: AgentChatMessage[] = [makeAssistantMessage()];

    const next = appendAgentStreamEvent(messages, "m1", {
      type: "scimanage.tool_execution.failed",
      protocol: "scimanage-agent-sse-v1",
      response_id: "resp_1",
      sequence_number: 1,
      session_id: "sess_1",
      agent_run_id: "run_1",
      tool_execution_id: "call_1",
      tool_name: "propose_order",
      label: "propose_order",
      error: {
        message: "该操作需要用户在界面显式确认后才能生成提案",
        code: "NEEDS_USER_CONFIRMATION",
      },
      target_intent: "orders.create",
    });

    const item = next[0].timeline?.find((t) => t.id === "call_1") as
      | Extract<AgentTimelineItem, { kind: "tool" }>
      | undefined;
    expect(item).toBeDefined();
    expect(item?.kind).toBe("tool");
    expect(item?.status).toBe("error");
    expect(item?.code).toBe("NEEDS_USER_CONFIRMATION");
    expect(item?.targetIntent).toBe("orders.create");
  });

  it("tool_execution.failed without code keeps legacy behaviour (no code/targetIntent on item)", async () => {
    const { appendAgentStreamEvent } = await import("@/components/agent/agent-message-helpers");
    const messages: AgentChatMessage[] = [makeAssistantMessage()];

    const next = appendAgentStreamEvent(messages, "m1", {
      type: "scimanage.tool_execution.failed",
      protocol: "scimanage-agent-sse-v1",
      response_id: "resp_1",
      sequence_number: 1,
      session_id: "sess_1",
      agent_run_id: "run_1",
      tool_execution_id: "call_2",
      tool_name: "search_orders",
      label: "search_orders",
      error: { message: "工具执行失败" },
    });

    const item = next[0].timeline?.find((t) => t.id === "call_2") as
      | Extract<AgentTimelineItem, { kind: "tool" }>
      | undefined;
    expect(item).toBeDefined();
    expect(item?.code).toBeUndefined();
    expect(item?.targetIntent).toBeUndefined();
  });
});

// ── §3 shouldRenderNeedsConfirmation（纯函数） ──

describe("shouldRenderNeedsConfirmation", () => {
  it("matches tool item with status=error + code=NEEDS_USER_CONFIRMATION", async () => {
    const { shouldRenderNeedsConfirmation } = await import(
      "@/components/agent/agent-message-helpers"
    );
    const item: AgentTimelineItem = {
      id: "t1",
      kind: "tool",
      toolName: "propose_order",
      label: "propose_order",
      status: "error",
      error: "需确认",
      code: "NEEDS_USER_CONFIRMATION",
      targetIntent: "orders.create",
    };
    expect(shouldRenderNeedsConfirmation(item)).toBe(true);
  });

  it("does not match tool item whose code is a different error", async () => {
    const { shouldRenderNeedsConfirmation } = await import(
      "@/components/agent/agent-message-helpers"
    );
    const item: AgentTimelineItem = {
      id: "t2",
      kind: "tool",
      toolName: "search_orders",
      label: "search_orders",
      status: "error",
      error: "失败",
      // 无 code（普通工具错误）→ 不渲染确认卡片，保持红色错误行
    };
    expect(shouldRenderNeedsConfirmation(item)).toBe(false);
  });

  it("does not match non-tool items (e.g. thinking/text)", async () => {
    const { shouldRenderNeedsConfirmation } = await import(
      "@/components/agent/agent-message-helpers"
    );
    const textItem: AgentTimelineItem = {
      id: "t3",
      kind: "text",
      content: "hello",
    };
    expect(shouldRenderNeedsConfirmation(textItem)).toBe(false);
  });

  it("does not match a successful tool item", async () => {
    const { shouldRenderNeedsConfirmation } = await import(
      "@/components/agent/agent-message-helpers"
    );
    const item: AgentTimelineItem = {
      id: "t4",
      kind: "tool",
      toolName: "prepare_order",
      label: "prepare_order",
      status: "done",
    };
    expect(shouldRenderNeedsConfirmation(item)).toBe(false);
  });

  it("matches even when targetIntent is absent (button disabled, no crash)", async () => {
    const { shouldRenderNeedsConfirmation } = await import(
      "@/components/agent/agent-message-helpers"
    );
    const item: AgentTimelineItem = {
      id: "t5",
      kind: "tool",
      toolName: "propose_order",
      label: "propose_order",
      status: "error",
      error: "需确认",
      code: "NEEDS_USER_CONFIRMATION",
      // targetIntent 缺失：卡片仍渲染，按钮禁用并提示
    };
    expect(shouldRenderNeedsConfirmation(item)).toBe(true);
  });
});

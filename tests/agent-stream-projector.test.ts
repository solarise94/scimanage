/**
 * Phase 3 persistence projector tests (plan §5.3 / design §7.4).
 *
 * Pure-fixture tests — no DB, no I/O. Verifies the projector folds canonical
 * AgentStreamEvents into an aggregate whose timeline is shape-compatible with
 * the session persistence DTO (AgentTimelineItem), so a page refresh can fully
 * reconstruct the turn — including the needs-user-confirmation card.
 *
 * Coverage (plan §5.3 1–10):
 *  1.  text delta aggregation
 *  2.  activity start/completed
 *  3.  tool started → running timeline
 *  4.  tool completed → done + input/output
 *  5.  tool failed → error
 *  6.  needs-confirmation: error.code persisted, target_intent persisted,
 *      session DTO recovers as `targetIntent`, refresh-recoverable
 *  7.  compact summary/token
 *  8.  usage
 *  9.  event order
 *  10. response.failed
 */
import { describe, it, expect } from "vitest";
import type { AgentStreamEvent } from "../agent-runtime/src/stream-protocol";
import {
  createAgentTurnAggregate,
  normalizeTimelineForPersistence,
  projectAgentStreamEvent,
  setCompactSummary,
} from "@/lib/agent-runtime/agent-stream-projector";
import type { AgentTimelineItem } from "@/lib/agent-runtime/types";

const META = { response_id: "resp_1", session_id: "sess_1", agent_run_id: "run_1" };

/** Build a canonical event with envelope stamped, sequence assigned by caller. */
function ev(sequence_number: number, partial: Record<string, unknown>): AgentStreamEvent {
  return {
    protocol: "scimanage-agent-sse-v1",
    response_id: META.response_id,
    sequence_number,
    session_id: META.session_id,
    agent_run_id: META.agent_run_id,
    created_at: 1_700_000_000_000 + sequence_number,
    ...partial,
  } as unknown as AgentStreamEvent;
}

function foldAll(events: AgentStreamEvent[]) {
  const agg = createAgentTurnAggregate();
  for (const e of events) projectAgentStreamEvent(agg, e);
  return agg;
}

function tool(agg: ReturnType<typeof createAgentTurnAggregate>, id: string) {
  return agg.assistantTimeline.find(
    (t): t is Extract<AgentTimelineItem, { kind: "tool" }> => t.kind === "tool" && t.id === id,
  );
}

// ── 1. text delta aggregation ────────────────────────────────────────────────

describe("projector: text delta aggregation", () => {
  it("concatenates consecutive text deltas into one timeline text segment", () => {
    const agg = foldAll([
      ev(1, { type: "response.output_text.delta", delta: "Hello" }),
      ev(2, { type: "response.output_text.delta", delta: ", " }),
      ev(3, { type: "response.output_text.delta", delta: "world!" }),
    ]);
    expect(agg.assistantContent).toBe("Hello, world!");
    const texts = agg.assistantTimeline.filter((t) => t.kind === "text");
    expect(texts).toHaveLength(1);
    expect(texts[0].kind).toBe("text");
    if (texts[0].kind === "text") expect(texts[0].content).toBe("Hello, world!");
  });

  it("response.output_text.done overrides concatenated deltas (final calibration)", () => {
    const agg = foldAll([
      ev(1, { type: "response.output_text.delta", delta: "Hello" }),
      ev(2, { type: "response.output_text.done", text: "Hello (calibrated)" }),
    ]);
    expect(agg.assistantContent).toBe("Hello (calibrated)");
  });
});

// ── 2. activity start/completed (thinking without leaking raw text) ─────────

describe("projector: activity → thinking timeline", () => {
  it("activity.started creates a running thinking row; completed marks it done", () => {
    const agg = foldAll([
      ev(1, { type: "scimanage.activity.started", activity_id: "act_1", label: "正在思考" }),
      ev(2, { type: "scimanage.activity.completed", activity_id: "act_1" }),
    ]);
    const thinking = agg.assistantTimeline.find(
      (t) => t.kind === "thinking" && t.id === "act_1",
    );
    expect(thinking).toBeDefined();
    expect(thinking!.kind).toBe("thinking");
    if (thinking!.kind === "thinking") {
      expect(thinking!.status).toBe("done");
      // label is stored as content placeholder (NOT raw reasoning text — design §5.2).
      expect(thinking!.content).toBe("正在思考");
    }
  });
});

// ── 3. tool started → running timeline ───────────────────────────────────────

describe("projector: tool started → running", () => {
  it("records a running tool item with input", () => {
    const agg = foldAll([
      ev(1, {
        type: "scimanage.tool_execution.started",
        tool_execution_id: "call_1",
        tool_name: "crm.search_customers",
        label: "搜索客户",
        input: { keyword: "ACME" },
      }),
    ]);
    const item = tool(agg, "call_1");
    expect(item).toBeDefined();
    expect(item!.status).toBe("running");
    expect(item!.toolName).toBe("crm.search_customers");
    expect(item!.input).toEqual({ keyword: "ACME" });
  });
});

// ── 4. tool completed → done + output ────────────────────────────────────────

describe("projector: tool completed → done + output", () => {
  it("marks the existing tool item done with output", () => {
    const agg = foldAll([
      ev(1, {
        type: "scimanage.tool_execution.started",
        tool_execution_id: "call_1",
        tool_name: "crm.get_customer_context",
        label: "查看客户详情",
        input: { profileId: "p1" },
      }),
      ev(2, {
        type: "scimanage.tool_execution.completed",
        tool_execution_id: "call_1",
        tool_name: "crm.get_customer_context",
        label: "查看客户详情",
        output: { profileId: "p1", name: "ACME" },
      }),
    ]);
    const item = tool(agg, "call_1");
    expect(item!.status).toBe("done");
    expect(item!.output).toEqual({ profileId: "p1", name: "ACME" });
    // input preserved from started.
    expect(item!.input).toEqual({ profileId: "p1" });
  });
});

// ── 5. tool failed → error ───────────────────────────────────────────────────

describe("projector: tool failed → error", () => {
  it("marks the tool item error with error.message (does NOT flip whole turn)", () => {
    const agg = foldAll([
      ev(1, {
        type: "scimanage.tool_execution.started",
        tool_execution_id: "call_1",
        tool_name: "crm.search_customers",
        label: "搜索客户",
      }),
      ev(2, {
        type: "scimanage.tool_execution.failed",
        tool_execution_id: "call_1",
        tool_name: "crm.search_customers",
        label: "搜索客户",
        error: { message: "网络错误", retryable: true },
      }),
    ]);
    const item = tool(agg, "call_1");
    expect(item!.status).toBe("error");
    expect(item!.error).toBe("网络错误");
    // A single tool failure must not mark the whole turn as error (design §5.7).
    expect(agg.assistantState).toBe("done");
    // Plain failures do NOT carry code/targetIntent.
    expect(item!.code).toBeUndefined();
    expect(item!.targetIntent).toBeUndefined();
  });
});

// ── 6. needs-confirmation: code + target_intent persisted, refresh-recoverable

describe("projector: needs-confirmation parity (§7.4 one-shot fix)", () => {
  it("persists error.code + target_intent; session DTO recovers as targetIntent", () => {
    const agg = foldAll([
      ev(1, {
        type: "scimanage.tool_execution.started",
        tool_execution_id: "call_2",
        tool_name: "propose_order",
        label: "propose_order",
        input: { items: [] },
      }),
      ev(2, {
        type: "scimanage.tool_execution.failed",
        tool_execution_id: "call_2",
        tool_name: "propose_order",
        label: "propose_order",
        error: {
          message: "该操作需要用户在界面显式确认后才能生成提案",
          code: "NEEDS_USER_CONFIRMATION",
          retryable: false,
        },
        target_intent: "orders.create",
      }),
    ]);
    const item = tool(agg, "call_2")!;
    expect(item.status).toBe("error");
    expect(item.code).toBe("NEEDS_USER_CONFIRMATION");
    // wire snake_case `target_intent` recovered as timeline camelCase `targetIntent`.
    expect(item.targetIntent).toBe("orders.create");
  });

  it("after normalize + reload, the confirmation card is still mintable", () => {
    // Simulate the full persistence round-trip: project → normalize → re-read
    // as if from the session DTO. The UI's shouldRenderNeedsConfirmation
    // matches on { kind: tool, status: error, code: NEEDS_USER_CONFIRMATION }.
    const agg = foldAll([
      ev(1, {
        type: "scimanage.tool_execution.failed",
        tool_execution_id: "call_3",
        tool_name: "propose_order",
        label: "propose_order",
        error: { message: "需确认", code: "NEEDS_USER_CONFIRMATION" },
        target_intent: "orders.create",
      }),
    ]);
    const persisted = normalizeTimelineForPersistence(agg.assistantTimeline);
    // Re-read simulation: find the tool item as the session DTO would expose it.
    const recovered = persisted.find(
      (t): t is Extract<AgentTimelineItem, { kind: "tool" }> =>
        t.kind === "tool" && t.id === "call_3",
    )!;
    expect(recovered.code).toBe("NEEDS_USER_CONFIRMATION");
    expect(recovered.targetIntent).toBe("orders.create");
    // The mint actionKey the UI uses equals targetIntent (p13 contract).
    expect(recovered.targetIntent).toBe("orders.create");
    // The match predicate the UI uses for rendering the card holds:
    const matches = recovered.kind === "tool" &&
      recovered.status === "error" &&
      recovered.code === "NEEDS_USER_CONFIRMATION";
    expect(matches).toBe(true);
  });
});

// ── 7. compact summary/token ─────────────────────────────────────────────────

describe("projector: compaction", () => {
  it("records started → completed with token info", () => {
    const agg = foldAll([
      ev(1, { type: "scimanage.context_compaction.started" }),
      ev(2, {
        type: "scimanage.context_compaction.completed",
        tokens_before: 50000,
        tokens_after: 12000,
      }),
    ]);
    const compact = agg.assistantTimeline.find((t) => t.kind === "compact");
    expect(compact).toBeDefined();
    if (compact!.kind === "compact") {
      expect(compact!.status).toBe("done");
      expect(compact!.tokensBefore).toBe(50000);
      expect(compact!.tokensAfter).toBe(12000);
    }
  });

  it("setCompactSummary captures summary for persistence (not for wire)", () => {
    const agg = createAgentTurnAggregate();
    setCompactSummary(agg, "  历史摘要正文  ");
    expect(agg.compactSummaryUpdate).toBe("历史摘要正文");
    // Summary must NOT land on the wire timeline (design §5.4).
    expect(agg.assistantTimeline.find((t) => t.kind === "compact")?.kind === "compact").toBe(false);
  });
});

// ── 8. usage ─────────────────────────────────────────────────────────────────

describe("projector: usage", () => {
  it("stores scimanage.usage.updated payload", () => {
    const agg = foldAll([
      ev(1, {
        type: "scimanage.usage.updated",
        usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
      }),
    ]);
    expect(agg.tokenUsage).toEqual({ input_tokens: 100, output_tokens: 50, total_tokens: 150 });
  });
});

// ── 9. event order ───────────────────────────────────────────────────────────

describe("projector: event order preserves chronological timeline", () => {
  it("text after tool opens a NEW text segment (not merged into pre-tool text)", () => {
    const agg = foldAll([
      ev(1, { type: "response.output_text.delta", delta: "搜索中：" }),
      ev(2, {
        type: "scimanage.tool_execution.started",
        tool_execution_id: "call_1",
        tool_name: "search",
        label: "search",
      }),
      ev(3, {
        type: "scimanage.tool_execution.completed",
        tool_execution_id: "call_1",
        tool_name: "search",
        label: "search",
        output: { hits: 1 },
      }),
      ev(4, { type: "response.output_text.delta", delta: "找到了。" }),
    ]);
    const kinds = agg.assistantTimeline.map((t) => t.kind);
    expect(kinds).toEqual(["text", "tool", "text"]);
  });
});

// ── 10. response.failed ──────────────────────────────────────────────────────

describe("projector: response.failed", () => {
  it("flips assistantState to error (whole-turn failure)", () => {
    const agg = foldAll([
      ev(1, { type: "response.output_text.delta", delta: "部分回复" }),
      ev(2, { type: "response.failed", error: { message: "persistence failed" } }),
    ]);
    expect(agg.assistantState).toBe("error");
  });

  it("error event also flips assistantState to error", () => {
    const agg = foldAll([
      ev(1, { type: "error", error: { message: "boom" } }),
    ]);
    expect(agg.assistantState).toBe("error");
  });

  it("response.completed folds optional usage", () => {
    const agg = foldAll([
      ev(1, {
        type: "response.completed",
        status: "completed",
        usage: { total_tokens: 999 },
      }),
    ]);
    expect(agg.tokenUsage).toEqual({ total_tokens: 999 });
    // completed is a success terminal — does NOT flip to error.
    expect(agg.assistantState).toBe("done");
  });
});

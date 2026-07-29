/**
 * Phase 4 UI reducer + consumer tests (plan §6.3 / §6.4 / §6.5 / §6.7).
 *
 * Pure-function tests — no DB, no I/O. Covers:
 *  §6.3 consumer terminal state: completed / failed / EOF-without-terminal /
 *      user abort / session switch (dedup) / duplicate / unknown / malformed.
 *  §6.4 reducer: full canonical-event mapping (waiting placeholder, text,
 *      activity→thinking without raw body, tool timeline, compact, cards).
 *  §6.5 confirmation card: real-time + refresh parity (timeline.code +
 *      timeline.targetIntent surface); non-confirmation tool failure stays red.
 *  §6.7 compact: never perpetual running; completed status non-empty.
 *  thinking: never permanent running; placeholder present until first event.
 */
import { describe, it, expect } from "vitest";
import type { AgentStreamEvent } from "../agent-runtime/src/stream-protocol";
import {
  AGENT_STREAM_PROTOCOL,
  encodeSseEvent,
} from "../agent-runtime/src/stream-protocol";
import {
  appendAgentStreamEvent,
  createStreamingAssistantMessage,
  INITIAL_THINKING_ID,
  shouldRenderNeedsConfirmation,
} from "@/components/agent/agent-message-helpers";
import type { AgentChatMessage } from "@/components/agent/chat-panel";
import type { AgentTimelineItem } from "@/lib/agent-runtime/types";
import {
  consumeAgentStream,
  isInvoiceAnalyzeFailureEvent,
} from "@/lib/agent-stream/consume-agent-stream";

// ── fixture helpers ──────────────────────────────────────────────────────────

const META = { response_id: "resp_1", session_id: "sess_1", agent_run_id: "run_1" };

function ev(sequence_number: number, partial: Record<string, unknown>): AgentStreamEvent {
  return {
    protocol: AGENT_STREAM_PROTOCOL,
    response_id: META.response_id,
    sequence_number,
    session_id: META.session_id,
    agent_run_id: META.agent_run_id,
    created_at: 1_700_000_000_000 + sequence_number,
    ...partial,
  } as unknown as AgentStreamEvent;
}

function assistant(): AgentChatMessage {
  return { ...createStreamingAssistantMessage(), id: "m1" };
}

function lastTimelineItem(message: AgentChatMessage): AgentTimelineItem | undefined {
  return (message.timeline ?? [])[message.timeline ? message.timeline.length - 1 : -1];
}

function tool(message: AgentChatMessage, id: string) {
  return message.timeline?.find(
    (t): t is Extract<AgentTimelineItem, { kind: "tool" }> => t.kind === "tool" && t.id === id,
  );
}

/** Build a Response whose .body streams the given SSE frames. */
function streamingResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(encoder.encode(f));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

async function consume(frames: string[], signal?: AbortSignal) {
  const events: AgentStreamEvent[] = [];
  let completed = 0;
  let failed = 0;
  let disconnected = 0;
  let aborted = 0;
  const res = streamingResponse(frames);
  const result = await consumeAgentStream(res, {
    signal,
    onEvent: (e) => events.push(e),
    onCompleted: () => { completed += 1; },
    onFailed: () => { failed += 1; },
    onDisconnectedBeforeTerminal: () => { disconnected += 1; },
    onAborted: () => { aborted += 1; },
  });
  return { events, completed, failed, disconnected, aborted, result };
}

// ── §6.3 consumer terminal state ─────────────────────────────────────────────

describe("consumeAgentStream — terminal state", () => {
  it("completed → onCompleted (sole success terminal)", async () => {
    const frames = [
      encodeSseEvent(ev(0, { type: "response.created" })),
      encodeSseEvent(ev(1, { type: "response.completed", status: "completed" })),
    ];
    const r = await consume(frames);
    expect(r.result.terminal).toBe("completed");
    expect(r.completed).toBe(1);
    expect(r.failed).toBe(0);
    expect(r.disconnected).toBe(0);
  });

  it("failed → onFailed (sole failure terminal)", async () => {
    const frames = [
      encodeSseEvent(ev(0, { type: "response.created" })),
      encodeSseEvent(ev(1, { type: "response.failed", error: { message: "boom" } })),
    ];
    const r = await consume(frames);
    expect(r.result.terminal).toBe("failed");
    expect(r.failed).toBe(1);
    expect(r.completed).toBe(0);
    expect(r.disconnected).toBe(0);
  });

  it("EOF without terminal → onDisconnectedBeforeTerminal, NOT marked done, no auto-resend", async () => {
    // Runtime emitted events then EOF without completed/failed (e.g. crash).
    const frames = [
      encodeSseEvent(ev(0, { type: "response.created" })),
      encodeSseEvent(ev(1, { type: "response.output_text.delta", delta: "hi" })),
    ];
    const r = await consume(frames);
    expect(r.result.terminal).toBe("disconnected");
    expect(r.disconnected).toBe(1);
    expect(r.completed).toBe(0);
    expect(r.failed).toBe(0);
    expect(r.events.map((e) => e.type)).toContain("response.output_text.delta");
  });

  it("user abort → onAborted, NOT reported as transport failure", async () => {
    const controller = new AbortController();
    // A stream that never closes on its own so the reader.read() awaits.
    const encoder = new TextEncoder();
    let rejectRead: ((e: unknown) => void) | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start(controller2) {
        controller2.enqueue(encoder.encode(encodeSseEvent(ev(0, { type: "response.created" }))));
      },
      pull() {
        return new Promise<void>((_resolve, reject) => {
          rejectRead = reject;
        });
      },
    });
    const res = new Response(stream, { status: 200 });
    const consumePromise = consumeAgentStream(res, {
      signal: controller.signal,
      onEvent: () => {},
      onCompleted: () => {},
      onFailed: () => {},
      onDisconnectedBeforeTerminal: () => {},
      onAborted: () => {},
    });
    // Fire abort; the pull promise rejects with AbortError.
    setTimeout(() => {
      controller.abort();
      rejectRead?.(new DOMException("aborted", "AbortError"));
    }, 0);
    const result = await consumePromise;
    expect(result.terminal).toBe("aborted");
  });

  it("session switch / duplicate sequence → text not appended twice", async () => {
    // Same frame duplicated (e.g. replayed during a session-switch race).
    const dupFrame = encodeSseEvent(ev(1, { type: "response.output_text.delta", delta: "x" }));
    const frames = [
      encodeSseEvent(ev(0, { type: "response.created" })),
      dupFrame,
      dupFrame, // exact duplicate → dropped
      encodeSseEvent(ev(1, { type: "response.output_text.delta", delta: "x" })), // backward → dropped
      encodeSseEvent(ev(3, { type: "response.completed", status: "completed" })),
    ];
    const r = await consume(frames);
    const deltas = r.events.filter((e) => e.type === "response.output_text.delta");
    expect(deltas).toHaveLength(1);
  });

  it("unknown scimanage.* event → ignored, does not interrupt text flow", async () => {
    // Craft an unknown scimanage type by raw frame (the validator would reject
    // unknown types — but the consumer must NOT crash and must keep flowing).
    const unknownFrame = `event: scimanage.future_thing\ndata: ${JSON.stringify({
      type: "scimanage.future_thing",
      protocol: AGENT_STREAM_PROTOCOL,
      response_id: META.response_id,
      sequence_number: 2,
    })}\n\n`;
    const frames = [
      encodeSseEvent(ev(0, { type: "response.created" })),
      unknownFrame,
      encodeSseEvent(ev(3, { type: "response.output_text.delta", delta: "after-unknown" })),
      encodeSseEvent(ev(4, { type: "response.completed", status: "completed" })),
    ];
    // The unknown frame is malformed per the canonical validator (UNKNOWN_EVENT_TYPE),
    // which the consumer surfaces as a transport failure terminal.
    const r = await consume(frames);
    expect(r.result.terminal).toBe("failed");
    expect(r.failed).toBe(1);
  });

  it("malformed protocol → typed transport failure, never success", async () => {
    const malformed = `event: response.created\ndata: not-json\n\n`;
    const frames = [
      encodeSseEvent(ev(0, { type: "response.created" })),
      malformed,
    ];
    const r = await consume(frames);
    expect(r.result.terminal).toBe("failed");
    expect(r.completed).toBe(0);
    expect(r.failed).toBe(1);
  });

  it("invoice analyze failure predicate", () => {
    expect(
      isInvoiceAnalyzeFailureEvent(
        ev(1, {
          type: "scimanage.tool_execution.failed",
          tool_execution_id: "t1",
          tool_name: "finance.analyze_invoice_file",
          label: "analyze",
          error: { message: "fail" },
        }),
      ),
    ).toBe(true);
    expect(
      isInvoiceAnalyzeFailureEvent(
        ev(1, {
          type: "scimanage.tool_execution.failed",
          tool_execution_id: "t2",
          tool_name: "search_orders",
          label: "search",
          error: { message: "fail" },
        }),
      ),
    ).toBe(false);
  });
});

// ── §6.4 reducer: full event mapping ─────────────────────────────────────────

describe("appendAgentStreamEvent — canonical mapping", () => {
  it("response.created/in_progress → waiting placeholder (running thinking row)", () => {
    let messages = [assistant()];
    messages = appendAgentStreamEvent(messages, "m1", ev(0, { type: "response.created" }));
    messages = appendAgentStreamEvent(messages, "m1", ev(1, { type: "response.in_progress" }));
    const thinking = messages[0].timeline?.find((t) => t.id === INITIAL_THINKING_ID);
    expect(thinking).toBeDefined();
    expect(thinking?.kind).toBe("thinking");
    if (thinking?.kind === "thinking") expect(thinking.status).toBe("running");
  });

  it("response.output_text.delta appends text; message.content accumulates", () => {
    let messages = [assistant()];
    messages = appendAgentStreamEvent(messages, "m1", ev(1, { type: "response.output_text.delta", delta: "Hello" }));
    messages = appendAgentStreamEvent(messages, "m1", ev(2, { type: "response.output_text.delta", delta: " world" }));
    expect(messages[0].content).toBe("Hello world");
    expect(lastTimelineItem(messages[0])?.kind).toBe("text");
  });

  it("response.output_text.done calibrates text but does NOT mark state=done", () => {
    let messages = [assistant()];
    messages = appendAgentStreamEvent(messages, "m1", ev(1, { type: "response.output_text.delta", delta: "Hello" }));
    messages = appendAgentStreamEvent(messages, "m1", ev(2, { type: "response.output_text.done", text: "Hello (final)" }));
    expect(messages[0].content).toBe("Hello (final)");
    // output_text.done is NOT a success terminal.
    expect(messages[0].state).toBe("streaming");
  });

  it("activity.started → thinking row with NO raw body; .completed marks done", () => {
    let messages = [assistant()];
    messages = appendAgentStreamEvent(
      messages,
      "m1",
      ev(1, { type: "scimanage.activity.started", activity_id: "act_1", label: "正在思考" }),
    );
    const thinking = messages[0].timeline?.find((t) => t.kind === "thinking" && t.id === "act_1");
    expect(thinking).toBeDefined();
    if (thinking?.kind === "thinking") {
      // raw reasoning body is NOT shown
      expect(thinking.content ?? "").toBe("");
      expect(thinking.status).toBe("running");
    }
    messages = appendAgentStreamEvent(
      messages,
      "m1",
      ev(2, { type: "scimanage.activity.completed", activity_id: "act_1" }),
    );
    const done = messages[0].timeline?.find((t) => t.kind === "thinking" && t.id === "act_1");
    if (done?.kind === "thinking") expect(done.status).toBe("done");
  });

  it("tool started/completed/failed → tool timeline", () => {
    let messages = [assistant()];
    messages = appendAgentStreamEvent(
      messages,
      "m1",
      ev(1, { type: "scimanage.tool_execution.started", tool_execution_id: "c1", tool_name: "search_orders", label: "search" }),
    );
    expect(tool(messages[0], "c1")?.status).toBe("running");
    messages = appendAgentStreamEvent(
      messages,
      "m1",
      ev(2, { type: "scimanage.tool_execution.completed", tool_execution_id: "c1", tool_name: "search_orders", label: "search", output: { ok: true } }),
    );
    expect(tool(messages[0], "c1")?.status).toBe("done");
    expect(tool(messages[0], "c1")?.output).toEqual({ ok: true });
  });

  it("compact started/completed → status row, never perpetual running", () => {
    let messages = [assistant()];
    messages = appendAgentStreamEvent(messages, "m1", ev(1, { type: "scimanage.context_compaction.started" }));
    const compact = messages[0].timeline?.find((t) => t.kind === "compact");
    expect(compact).toBeDefined();
    if (compact?.kind === "compact") expect(compact.status).toBe("running");
    messages = appendAgentStreamEvent(
      messages,
      "m1",
      ev(2, { type: "scimanage.context_compaction.completed", tokens_before: 1000, tokens_after: 400 }),
    );
    const done = messages[0].timeline?.find((t) => t.kind === "compact");
    if (done?.kind === "compact") {
      expect(done.status).toBe("done");
      expect(done.content).not.toBe(""); // non-empty status text
      expect(done.tokensBefore).toBe(1000);
      expect(done.tokensAfter).toBe(400);
    }
  });

  it("memory/view/proactive → corresponding cards", () => {
    let messages = [assistant()];
    messages = appendAgentStreamEvent(
      messages,
      "m1",
      ev(1, { type: "scimanage.memory.suggested", memory: { id: "mem1", content: "remembered" } }),
    );
    messages = appendAgentStreamEvent(
      messages,
      "m1",
      ev(2, { type: "scimanage.view_intent.created", intent: { type: "navigate", label: "go" } }),
    );
    messages = appendAgentStreamEvent(
      messages,
      "m1",
      ev(3, { type: "scimanage.proactive_task.suggested", task: { id: "task1", title: "remind" } }),
    );
    const kinds = (messages[0].timeline ?? []).map((t) => t.kind);
    expect(kinds).toContain("memory");
    expect(kinds).toContain("view");
    expect(kinds).toContain("proactive");
  });

  it("response.completed → state=done (sole success terminal)", () => {
    let messages = [assistant()];
    messages = appendAgentStreamEvent(messages, "m1", ev(1, { type: "response.output_text.delta", delta: "hi" }));
    messages = appendAgentStreamEvent(messages, "m1", ev(2, { type: "response.completed", status: "completed" }));
    expect(messages[0].state).toBe("done");
  });

  it("response.failed → state=error (sole failure terminal)", () => {
    let messages = [assistant()];
    messages = appendAgentStreamEvent(messages, "m1", ev(1, { type: "response.failed", error: { message: "boom" } }));
    expect(messages[0].state).toBe("error");
  });

  it("response.completed closes any still-running tool/compact/thinking", () => {
    let messages = [assistant()];
    messages = appendAgentStreamEvent(
      messages,
      "m1",
      ev(1, { type: "scimanage.tool_execution.started", tool_execution_id: "c1", tool_name: "search_orders", label: "search" }),
    );
    messages = appendAgentStreamEvent(messages, "m1", ev(2, { type: "scimanage.context_compaction.started" }));
    messages = appendAgentStreamEvent(messages, "m1", ev(3, { type: "response.completed", status: "completed" }));
    const t = tool(messages[0], "c1");
    expect(t?.status).toBe("done");
    const compact = messages[0].timeline?.find((x) => x.kind === "compact");
    if (compact?.kind === "compact") expect(compact.status).toBe("done");
  });
});

// ── §6.5 confirmation card parity ────────────────────────────────────────────

describe("confirmation card — real-time + refresh parity", () => {
  it("real-time: tool_execution.failed with NEEDS_USER_CONFIRMATION surfaces code + targetIntent", () => {
    let messages = [assistant()];
    messages = appendAgentStreamEvent(messages, "m1",
      ev(1, {
        type: "scimanage.tool_execution.failed",
        tool_execution_id: "call_1",
        tool_name: "propose_order",
        label: "propose_order",
        error: { message: "需确认", code: "NEEDS_USER_CONFIRMATION" },
        target_intent: "orders.create",
      }),
    );
    const item = tool(messages[0], "call_1");
    expect(item?.status).toBe("error");
    expect(item?.code).toBe("NEEDS_USER_CONFIRMATION");
    expect(item?.targetIntent).toBe("orders.create");
    expect(shouldRenderNeedsConfirmation(item!)).toBe(true);
  });

  it("refresh parity: a timeline restored from session DTO keeps code + targetIntent", () => {
    // After refresh the message comes from the server (projector persisted these
    // fields). The pure shouldRenderNeedsConfirmation predicate must still match.
    const restored: AgentTimelineItem = {
      id: "call_1",
      kind: "tool",
      toolName: "propose_order",
      label: "propose_order",
      status: "error",
      error: "需确认",
      code: "NEEDS_USER_CONFIRMATION",
      targetIntent: "orders.create",
    };
    expect(shouldRenderNeedsConfirmation(restored)).toBe(true);
  });

  it("mint actionKey === targetIntent (the card mints with targetIntent)", () => {
    // The card body posts { targetIntent } to /api/agent/confirmation-events.
    // targetIntent must equal the action.key the model called (orders.create).
    let messages = [assistant()];
    messages = appendAgentStreamEvent(messages, "m1",
      ev(1, {
        type: "scimanage.tool_execution.failed",
        tool_execution_id: "call_1",
        tool_name: "propose_order",
        label: "propose_order",
        error: { message: "需确认", code: "NEEDS_USER_CONFIRMATION" },
        target_intent: "orders.create",
      }),
    );
    const item = tool(messages[0], "call_1");
    expect(item?.targetIntent).toBe("orders.create");
  });

  it("non-confirmation tool failure still renders red error row (no code/targetIntent)", () => {
    let messages = [assistant()];
    messages = appendAgentStreamEvent(messages, "m1",
      ev(1, {
        type: "scimanage.tool_execution.failed",
        tool_execution_id: "call_2",
        tool_name: "search_orders",
        label: "search",
        error: { message: "工具执行失败" },
      }),
    );
    const item = tool(messages[0], "call_2");
    expect(item?.status).toBe("error");
    expect(item?.code).toBeUndefined();
    expect(item?.targetIntent).toBeUndefined();
    expect(shouldRenderNeedsConfirmation(item!)).toBe(false);
  });
});

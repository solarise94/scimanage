/**
 * Phase 1 codec + event-contract tests.
 *
 * Covers execution-plan §3.3:
 *  1. canonical event type union / validator (every event type: valid + invalid)
 *  2. SSE encode (event line == data.type, id == response_id:sequence_number,
 *     JSON escaping, blank-line termination)
 *  3. SSE decode (single frame, multi-frame same chunk, frame across chunks,
 *     UTF-8 split, \n\n, \r\n\r\n, multi-line data:, malformed JSON,
 *     event/data.type mismatch, EOF residual frame)
 *  4. sequence (response.created == 0, strictly monotonic, duplicate/backward/gap)
 */

import { describe, expect, it } from "vitest";
import {
  AGENT_STREAM_EVENT_TYPES,
  AGENT_STREAM_PROTOCOL,
  AgentStreamProtocolError,
  agentStreamEventId,
  createSequenceTracker,
  encodeSseEvent,
  isAgentStreamEventType,
  parseAgentStreamEvent,
  tryParseAgentStreamEvent,
  type AgentStreamEvent,
} from "../agent-runtime/src/stream-protocol";
import { createSseEventDecoder } from "../src/lib/agent-stream/decode-sse";

// ── helpers ────────────────────────────────────────────────────────────────

const RESPONSE_ID = "resp_test_001";
const SESSION_ID = "sess_test_001";
const RUN_ID = "run_test_001";

function baseEvent(
  type: AgentStreamEvent["type"],
  sequenceNumber: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type,
    protocol: AGENT_STREAM_PROTOCOL,
    response_id: RESPONSE_ID,
    sequence_number: sequenceNumber,
    ...extra,
  };
}

/** Build a minimal VALID payload for each event type (used for positive cases). */
function validPayload(type: AgentStreamEvent["type"], seq: number): Record<string, unknown> {
  switch (type) {
    case "response.created":
      return baseEvent(type, 0, { session_id: SESSION_ID, agent_run_id: RUN_ID });
    case "response.in_progress":
      return baseEvent(type, seq);
    case "response.output_text.delta":
      return baseEvent(type, seq, { delta: "hi" });
    case "response.output_text.done":
      return baseEvent(type, seq, { text: "hi" });
    case "response.completed":
      return baseEvent(type, seq, { status: "completed", usage: { total_tokens: 10 } });
    case "response.failed":
      return baseEvent(type, seq, { error: { message: "boom", code: "X", retryable: false } });
    case "error":
      return baseEvent(type, seq, { error: { message: "err" } });
    case "scimanage.activity.started":
      return baseEvent(type, seq, { activity_id: "act_1", label: "正在思考" });
    case "scimanage.activity.completed":
      return baseEvent(type, seq, { activity_id: "act_1" });
    case "scimanage.tool_execution.started":
      return baseEvent(type, seq, {
        tool_execution_id: "te_1",
        tool_name: "find_customers",
        label: "查找客户",
        input: { q: "x" },
      });
    case "scimanage.tool_execution.completed":
      return baseEvent(type, seq, {
        tool_execution_id: "te_1",
        tool_name: "find_customers",
        label: "查找客户",
        output: { items: [] },
      });
    case "scimanage.tool_execution.failed":
      return baseEvent(type, seq, {
        tool_execution_id: "te_1",
        tool_name: "propose_order",
        label: "创建订单",
        error: { message: "需要确认", code: "NEEDS_USER_CONFIRMATION", retryable: true },
        target_intent: "orders.confirm_create",
      });
    case "scimanage.context_compaction.started":
      return baseEvent(type, seq);
    case "scimanage.context_compaction.completed":
      return baseEvent(type, seq, { tokens_before: 1000, tokens_after: 500 });
    case "scimanage.context_compaction.warning":
      return baseEvent(type, seq, { message: "still over" });
    case "scimanage.memory.suggested":
      return baseEvent(type, seq, { memory: { id: "m1", content: "pref" } });
    case "scimanage.view_intent.created":
      return baseEvent(type, seq, { intent: { type: "navigate", label: "go" } });
    case "scimanage.proactive_task.suggested":
      return baseEvent(type, seq, { task: { id: "t1", title: "remind" } });
    case "scimanage.usage.updated":
      return baseEvent(type, seq, { usage: { total_tokens: 42, input_tokens: 10, output_tokens: 32 } });
    default: {
      const _exhaustive: never = type;
      throw new Error(`unhandled type ${String(_exhaustive)}`);
    }
  }
}

// ── 1. canonical event union / validator ───────────────────────────────────

describe("canonical event type union / validator", () => {
  it("exports exactly the expected set of event types", () => {
    expect(AGENT_STREAM_EVENT_TYPES).toMatchInlineSnapshot(`
      [
        "response.created",
        "response.in_progress",
        "response.output_text.delta",
        "response.output_text.done",
        "response.completed",
        "response.failed",
        "error",
        "scimanage.activity.started",
        "scimanage.activity.completed",
        "scimanage.tool_execution.started",
        "scimanage.tool_execution.completed",
        "scimanage.tool_execution.failed",
        "scimanage.context_compaction.started",
        "scimanage.context_compaction.completed",
        "scimanage.context_compaction.warning",
        "scimanage.memory.suggested",
        "scimanage.view_intent.created",
        "scimanage.proactive_task.suggested",
        "scimanage.usage.updated",
      ]
    `);
  });

  it.each(AGENT_STREAM_EVENT_TYPES.map((t) => [t] as const))(
    "accepts a valid %s event",
    (type) => {
      const seq = type === "response.created" ? 0 : 1;
      const event = parseAgentStreamEvent(validPayload(type, seq));
      expect(event.type).toBe(type);
      expect(event.protocol).toBe(AGENT_STREAM_PROTOCOL);
      expect(event.response_id).toBe(RESPONSE_ID);
    },
  );

  it("rejects unknown event type", () => {
    expect(() => parseAgentStreamEvent(baseEvent("bogus.type" as never, 1))).toThrowError(
      /UNKNOWN_EVENT_TYPE|unknown event type/,
    );
    expect(() => parseAgentStreamEvent(baseEvent("bogus.type" as never, 1))).toThrow(AgentStreamProtocolError);
  });

  it("rejects wrong protocol version", () => {
    const p = baseEvent("response.in_progress", 1);
    p.protocol = "something-else";
    expect(() => parseAgentStreamEvent(p)).toThrowError(/PROTOCOL_VERSION_MISMATCH/);
  });

  it("rejects non-object input", () => {
    expect(() => parseAgentStreamEvent("nope")).toThrow(AgentStreamProtocolError);
    expect(() => parseAgentStreamEvent(null)).toThrow(AgentStreamProtocolError);
    expect(() => parseAgentStreamEvent([1, 2, 3])).toThrow(AgentStreamProtocolError);
  });

  it("rejects response.created with sequence_number != 0", () => {
    const p = validPayload("response.created", 0);
    p.sequence_number = 1;
    expect(() => parseAgentStreamEvent(p)).toThrowError(/response.created must have sequence_number 0/);
  });

  it("rejects response.created without session_id/agent_run_id", () => {
    const p = validPayload("response.created", 0);
    delete p.session_id;
    expect(() => parseAgentStreamEvent(p)).toThrowError(/session_id/);
  });

  it("rejects tool_execution.failed without error object", () => {
    const p = validPayload("scimanage.tool_execution.failed", 1);
    delete p.error;
    expect(() => parseAgentStreamEvent(p)).toThrowError(/error/);
  });

  it("rejects tool_execution.failed with non-string target_intent", () => {
    const p = validPayload("scimanage.tool_execution.failed", 1);
    p.target_intent = 123;
    expect(() => parseAgentStreamEvent(p)).toThrowError(/target_intent/);
  });

  it("rejects malformed error (missing message)", () => {
    const p = validPayload("error", 1);
    p.error = { code: "X" }; // no message
    expect(() => parseAgentStreamEvent(p)).toThrowError(/error/);
  });

  it("rejects response.completed with wrong status", () => {
    const p = validPayload("response.completed", 1);
    p.status = "failed";
    expect(() => parseAgentStreamEvent(p)).toThrowError(/status/);
  });

  it("rejects usage with non-numeric field", () => {
    const p = validPayload("scimanage.usage.updated", 1);
    (p.usage as Record<string, unknown>).total_tokens = "many";
    expect(() => parseAgentStreamEvent(p)).toThrowError(/usage malformed/);
  });

  it("rejects memory.suggested without memory object", () => {
    const p = validPayload("scimanage.memory.suggested", 1);
    delete p.memory;
    expect(() => parseAgentStreamEvent(p)).toThrowError(/memory/);
  });

  it("isAgentStreamEventType narrows correctly", () => {
    expect(isAgentStreamEventType("response.created")).toBe(true);
    expect(isAgentStreamEventType("scimanage.usage.updated")).toBe(true);
    expect(isAgentStreamEventType("not.a.type")).toBe(false);
    expect(isAgentStreamEventType(42)).toBe(false);
  });

  it("tryParseAgentStreamEvent returns null on invalid without throwing", () => {
    expect(tryParseAgentStreamEvent(baseEvent("nope" as never, 1))).toBeNull();
    expect(tryParseAgentStreamEvent(validPayload("response.in_progress", 1))?.type).toBe(
      "response.in_progress",
    );
  });
});

// ── 2. SSE encode ──────────────────────────────────────────────────────────

describe("encodeSseEvent", () => {
  it("event line equals data.type", () => {
    const ev = parseAgentStreamEvent(validPayload("response.output_text.delta", 7));
    const frame = encodeSseEvent(ev);
    expect(frame.startsWith("event: response.output_text.delta\n")).toBe(true);
  });

  it("id is response_id:sequence_number", () => {
    const ev = parseAgentStreamEvent(validPayload("response.output_text.delta", 7));
    const frame = encodeSseEvent(ev);
    expect(frame).toContain(`id: ${RESPONSE_ID}:7\n`);
  });

  it("agentStreamEventId helper matches", () => {
    const ev = parseAgentStreamEvent(validPayload("response.output_text.delta", 7));
    expect(agentStreamEventId(ev)).toBe(`${RESPONSE_ID}:7`);
  });

  it("data is a single JSON line terminated by blank line", () => {
    const ev = parseAgentStreamEvent(validPayload("response.in_progress", 1));
    const frame = encodeSseEvent(ev);
    expect(frame.endsWith("\n\n")).toBe(true);
    const dataLine = frame
      .split("\n")
      .find((l) => l.startsWith("data: "))!
      .slice("data: ".length);
    expect(JSON.parse(dataLine).type).toBe("response.in_progress");
  });

  it("JSON-escapes delta with quotes / newlines / unicode", () => {
    const payload = validPayload("response.output_text.delta", 1);
    payload.delta = 'he said "hi"\n中文😀';
    const ev = parseAgentStreamEvent(payload);
    const frame = encodeSseEvent(ev);
    // data: must be a single line — no embedded raw newline in the frame body
    const lines = frame.slice(0, -2).split("\n"); // strip trailing blank
    const dataLines = lines.filter((l) => l.startsWith("data: "));
    expect(dataLines).toHaveLength(1);
    const parsed = JSON.parse(dataLines[0].slice("data: ".length));
    expect(parsed.delta).toBe('he said "hi"\n中文😀');
  });

  it("throws on wrong protocol when encoding", () => {
    const ev = parseAgentStreamEvent(validPayload("response.in_progress", 1));
    // Bypass the literal-typed `protocol` field to simulate a drifted payload.
    const tampered = { ...ev, protocol: "wrong" } as unknown as AgentStreamEvent;
    expect(() => encodeSseEvent(tampered)).toThrow(AgentStreamProtocolError);
  });
});

// ── 3. SSE decode ──────────────────────────────────────────────────────────

function enc(event: AgentStreamEvent): Uint8Array {
  return new TextEncoder().encode(encodeSseEvent(event));
}

function decodeAll(chunks: Uint8Array[]): AgentStreamEvent[] {
  const decoder = createSseEventDecoder();
  const out: AgentStreamEvent[] = [];
  for (const c of chunks) {
    out.push(...decoder.push(c).events);
  }
  decoder.flush();
  return out;
}

describe("SSE decode", () => {
  it("decodes a single frame in one chunk", () => {
    const ev = parseAgentStreamEvent(validPayload("response.in_progress", 1));
    const out = decodeAll([enc(ev)]);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("response.in_progress");
  });

  it("decodes multiple frames in the same chunk", () => {
    const a = parseAgentStreamEvent(validPayload("response.in_progress", 1));
    const b = parseAgentStreamEvent(validPayload("response.output_text.delta", 2));
    const combined = new TextEncoder().encode(encodeSseEvent(a) + encodeSseEvent(b));
    const out = decodeAll([combined]);
    expect(out.map((e) => e.type)).toEqual(["response.in_progress", "response.output_text.delta"]);
  });

  it("decodes a single frame split across multiple chunks (byte boundary)", () => {
    const ev = parseAgentStreamEvent(validPayload("response.output_text.delta", 3));
    const bytes = enc(ev);
    const mid = Math.floor(bytes.length / 2);
    const out = decodeAll([bytes.subarray(0, mid), bytes.subarray(mid)]);
    expect(out).toHaveLength(1);
    expect((out[0] as { delta: string }).delta).toBe("hi");
  });

  it("handles Chinese + emoji split at arbitrary UTF-8 byte boundary", () => {
    const payload = validPayload("response.output_text.delta", 4);
    payload.delta = "你好世界😀中文";
    const ev = parseAgentStreamEvent(payload);
    const full = enc(ev);
    // Slice at every possible byte offset to force codepoint splits.
    for (let split = 1; split < full.length; split += 1) {
      const out = decodeAll([full.subarray(0, split), full.subarray(split)]);
      expect(out).toHaveLength(1);
      expect((out[0] as { delta: string }).delta).toBe("你好世界😀中文");
    }
  });

  it("supports \\r\\n\\r\\n frame terminator", () => {
    const ev = parseAgentStreamEvent(validPayload("response.in_progress", 1));
    const json = JSON.stringify(ev);
    // Manually build a CRLF-terminated frame.
    const frame = `event: ${ev.type}\r\nid: ${agentStreamEventId(ev)}\r\ndata: ${json}\r\n\r\n`;
    const out = decodeAll([new TextEncoder().encode(frame)]);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("response.in_progress");
  });

  it("supports multi-line data: (joined with \\n)", () => {
    const ev = parseAgentStreamEvent(validPayload("response.output_text.delta", 1));
    const json = JSON.stringify(ev);
    // Split on a structural boundary (after a top-level comma) so rejoining
    // with `\n` cannot land inside a JSON string literal.
    const commaIdx = json.indexOf(",");
    expect(commaIdx).toBeGreaterThan(0);
    const part1 = json.slice(0, commaIdx + 1);
    const part2 = json.slice(commaIdx + 1);
    const frame = `event: ${ev.type}\nid: ${agentStreamEventId(ev)}\ndata: ${part1}\ndata: ${part2}\n\n`;
    const out = decodeAll([new TextEncoder().encode(frame)]);
    expect(out).toHaveLength(1);
    expect((out[0] as { delta: string }).delta).toBe("hi");
  });

  it("rejects malformed JSON data", () => {
    const frame = `event: response.in_progress\nid: x:1\ndata: {not json\n\n`;
    expect(() => decodeAll([new TextEncoder().encode(frame)])).toThrowError(
      /MALFORMED_EVENT_JSON/,
    );
  });

  it("rejects event: line that does not match data.type", () => {
    const ev = parseAgentStreamEvent(validPayload("response.in_progress", 1));
    const json = JSON.stringify(ev);
    const frame = `event: response.completed\nid: ${agentStreamEventId(ev)}\ndata: ${json}\n\n`;
    expect(() => decodeAll([new TextEncoder().encode(frame)])).toThrowError(
      /EVENT_TYPE_MISMATCH/,
    );
  });

  it("rejects id: that does not match response_id:sequence_number", () => {
    const ev = parseAgentStreamEvent(validPayload("response.in_progress", 1));
    const json = JSON.stringify(ev);
    const frame = `event: response.in_progress\nid: WRONG:99\ndata: ${json}\n\n`;
    expect(() => decodeAll([new TextEncoder().encode(frame)])).toThrowError(
      /EVENT_TYPE_MISMATCH/,
    );
  });

  it("EOF with residual partial frame throws RESIDUAL_FRAME_AT_EOF", () => {
    const decoder = createSseEventDecoder();
    const ev = parseAgentStreamEvent(validPayload("response.in_progress", 1));
    const bytes = enc(ev);
    // Feed all bytes EXCEPT the final terminator (drop last 2 bytes: \n\n).
    decoder.push(bytes.subarray(0, bytes.length - 2));
    expect(() => decoder.flush()).toThrowError(/RESIDUAL_FRAME_AT_EOF/);
  });

  it("flush on empty buffer is a no-op", () => {
    const decoder = createSseEventDecoder();
    expect(() => decoder.flush()).not.toThrow();
  });

  it("ignores SSE comment lines (:) and unknown fields", () => {
    const ev = parseAgentStreamEvent(validPayload("response.in_progress", 1));
    const json = JSON.stringify(ev);
    const frame = `: heartbeat\nretry: 5000\nevent: ${ev.type}\nid: ${agentStreamEventId(ev)}\ndata: ${json}\n\n`;
    const out = decodeAll([new TextEncoder().encode(frame)]);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("response.in_progress");
  });

  it("push returns pendingBytes for buffered partial frame", () => {
    const decoder = createSseEventDecoder();
    const ev = parseAgentStreamEvent(validPayload("response.in_progress", 1));
    const bytes = enc(ev);
    const r = decoder.push(bytes.subarray(0, bytes.length - 2));
    expect(r.events).toHaveLength(0);
    expect(r.pendingBytes).toBeGreaterThan(0);
  });
});

// ── 4. sequence ────────────────────────────────────────────────────────────

describe("createSequenceTracker", () => {
  it("response.created must be sequence 0", () => {
    const t = createSequenceTracker();
    expect(t.observe(0).ok).toBe(true);
  });

  it("rejects first event that is not 0", () => {
    const t = createSequenceTracker();
    const r = t.observe(1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("backward");
  });

  it("accepts strictly monotonic +1 sequence", () => {
    const t = createSequenceTracker();
    t.observe(0);
    expect(t.observe(1).ok).toBe(true);
    expect(t.observe(2).ok).toBe(true);
    expect(t.observe(3).ok).toBe(true);
  });

  it("detects duplicate", () => {
    const t = createSequenceTracker();
    t.observe(0);
    t.observe(1);
    const r = t.observe(1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("duplicate");
  });

  it("detects backward", () => {
    const t = createSequenceTracker();
    t.observe(0);
    t.observe(1);
    t.observe(2);
    const r = t.observe(1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("backward");
  });

  it("detects gap", () => {
    const t = createSequenceTracker();
    t.observe(0);
    t.observe(1);
    const r = t.observe(5);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("gap");
      expect(r.expected).toBe(2);
      expect(r.actual).toBe(5);
    }
  });

  it("exposes last accepted sequence", () => {
    const t = createSequenceTracker();
    expect(t.last).toBeUndefined();
    t.observe(0);
    expect(t.last).toBe(0);
    t.observe(1);
    expect(t.last).toBe(1);
  });
});

// ── cross-module smoke ────────────────────────────────────────────────────

describe("shared module cross-reference", () => {
  it("decoder imports the same event contract as the protocol module", async () => {
    // dynamic import to assert the path resolves in the Next app context
    const mod = await import("../src/lib/agent-stream/decode-sse");
    expect(typeof mod.createSseEventDecoder).toBe("function");
    // The decoder must surface AgentStreamProtocolError re-exported from protocol.
    expect(mod.AgentStreamProtocolError).toBe(AgentStreamProtocolError);
  });
});

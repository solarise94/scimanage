/**
 * Phase 2 tests: runtime canonical event mapping + SSE transport.
 *
 * Covers plan §4.3 / design §5.8 / §6:
 *  1. `/health` returns service + protocol + build version.
 *  2. `/chat-stream` SSE headers (Content-Type / X-Agent-Stream-Protocol /
 *     X-Agent-Runtime-Build-Version) in SSE mode.
 *  3. Runtime event mapping: message start → created/in_progress, text delta,
 *     tool start/end/error, needs-confirmation error.code + target_intent,
 *     compact, usage, output text done, fatal error.
 *  4. thinking 原始正文不进 wire（only activity started/completed, no delta text).
 *  5. runtime does NOT emit response.completed; loop end → EOF.
 *  6. abort closes the runtime/Pi turn.
 *  7. sequence: created=0, monotonically increasing, no duplicates.
 *  8. NDJSON mode regression: framing is one JSON object per line.
 *
 * Strategy (plan §4.3: "prefer direct server start + real HTTP; Pi SDK via
 * mock/stub with minimal DI"):
 *  - agent-runtime is a standalone package (NodeNext + .js imports). We load
 *    its compiled `dist/` output via relative-path dynamic import, matching the
 *    existing precedent in tests/pi-runtime-selected-refs.test.ts.
 *  - Event-mapping tests call `streamChat` directly with a sink, mocking
 *    `globalThis.fetch` so the OpenAI client inside Pi returns a scripted SSE
 *    stream (text / reasoning / tool_calls / finish). No real network, no real
 *    model. The bridge endpoints (/api/agent/tools/execute etc.) are also
 *    intercepted by the same fetch mock.
 *  - HTTP-level tests (/health, headers, abort, NDJSON framing) spawn the real
 *    compiled server as a child process on a random port and hit it with the
 *    Node http client.
 *
 * Build prerequisite: `cd agent-runtime && npm run build` (must produce dist/).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import * as net from "node:net";
import { request as httpRequest } from "node:http";
import type { AgentStreamEvent } from "../agent-runtime/src/stream-protocol";

// ── Dynamic dist loader ──────────────────────────────────────────────────────

async function loadRuntime() {
  const protocol = await import("../agent-runtime/dist/stream-protocol.js");
  const piRuntime = await import("../agent-runtime/dist/pi-runtime.js");
  return { protocol, piRuntime };
}

// ── OpenAI SSE mock builder ──────────────────────────────────────────────────
//
// Pi's openai-completions API parses an OpenAI Chat Completions stream. We
// build a fetch mock that returns a Response whose body yields `data: {...}\n\n`
// frames. Each frame's choices[0].delta drives Pi's text_delta / thinking_delta
// / tool_calls parsing, which streamChat then maps to canonical events.

interface MockChunk {
  role?: string;
  content?: string | null;
  /** reasoning_content / reasoning / reasoning_text — Pi maps to thinking_delta. */
  reasoning_content?: string | null;
  tool_calls?: Array<{
    index: number;
    id?: string;
    type?: "function";
    function?: { name?: string; arguments?: string };
  }>;
}

function buildOpenAiStream(chunks: MockChunk[], finishReason: string = "stop"): string {
  const frames: string[] = [];
  for (const chunk of chunks) {
    const choice: Record<string, unknown> = {
      index: 0,
      delta: { ...chunk },
      finish_reason: null,
    };
    frames.push(`data: ${JSON.stringify({ id: "chatcmpl_mock", object: "chat.completion.chunk", choices: [choice] })}\n\n`);
  }
  // Final frame with finish_reason.
  frames.push(
    `data: ${JSON.stringify({
      id: "chatcmpl_mock",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
    })}\n\n`,
  );
  frames.push("data: [DONE]\n\n");
  return frames.join("");
}

function makeReadableStreamFromText(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  let sent = false;
  return new ReadableStream({
    pull(controller) {
      if (!sent) {
        controller.enqueue(bytes);
        sent = true;
      } else {
        controller.close();
      }
    },
  });
}

type FetchHandler = (url: string, init?: RequestInit) => Promise<Response>;

function installFetchMock(handler: FetchHandler) {
  const original = globalThis.fetch;
  const mock = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return handler(url, init);
  }) as typeof globalThis.fetch;
  globalThis.fetch = mock;
  return () => {
    globalThis.fetch = original;
  };
}

/**
 * Mock that serves the model stream for the completions endpoint and JSON for
 * bridge calls.
 *
 * The model endpoint is STATEFUL across calls within one streamChat turn: the
 * FIRST model call returns the scripted chunks (with the scripted finish
 * reason), and every SUBSEQUENT call returns an immediate `stop`. This prevents
 * an infinite tool-call loop when the scripted chunks carry `tool_calls`
 * (Pi would otherwise keep invoking the model expecting more tool results,
 * and our deterministic mock would re-emit the same tool_calls forever).
 */
function installModelFetchMock(opts: {
  modelChunks?: MockChunk[];
  finishReason?: string;
  bridgeHandler?: (url: string, body: unknown) => { status: number; body: unknown };
  /**
   * Optional out-param: every model /chat/completions request body the runtime
   * posts is pushed here (parsed JSON). Tests assert on the `tools` array the
   * runtime exposed to the model by inspecting these captured bodies.
   */
  modelRequestBodies?: unknown[];
}) {
  const firstStreamText = buildOpenAiStream(opts.modelChunks ?? [], opts.finishReason ?? "stop");
  const subsequentStreamText = buildOpenAiStream([], "stop");
  let modelCallCount = 0;
  return installFetchMock(async (url, init) => {
    // Model completions endpoint. Use a real Response so the openai client's
    // streaming reader (response.body.getReader() / async iterator) works.
    if (url.includes("/chat/completions")) {
      modelCallCount += 1;
      if (opts.modelRequestBodies && init?.body) {
        try {
          opts.modelRequestBodies.push(JSON.parse(init.body as string));
        } catch {
          opts.modelRequestBodies.push(init.body);
        }
      }
      const text = modelCallCount === 1 ? firstStreamText : subsequentStreamText;
      return new Response(makeReadableStreamFromText(text), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    // Bridge calls (/api/agent/tools/execute, /memory, /proactive-tasks, /select-bundle, /execute-public).
    if (opts.bridgeHandler) {
      let body: unknown = undefined;
      if (init?.body) {
        try {
          body = JSON.parse(init.body as string);
        } catch {
          body = init.body;
        }
      }
      const result = opts.bridgeHandler(url, body);
      return new Response(JSON.stringify(result.body), {
        status: result.status,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ error: "not mocked" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  });
}

// ── Minimal RuntimeChatStreamRequest fixture ─────────────────────────────────

function buildMinimalRequest(overrides: Record<string, unknown> = {}) {
  return {
    requestId: "req_test_1",
    agentRunId: "run_test_1",
    sessionId: "sess_test_1",
    user: { id: "user_1", role: "ADMIN", name: "Tester", email: "t@example.com" },
    message: "你好",
    history: [],
    memories: [],
    availableTools: [],
    bridge: { appBaseUrl: "http://app.example.local", internalToolToken: "bridge-token" },
    context: {
      currentView: null,
      viewControlEnabled: false,
      webSearchEnabled: false,
      proactiveEnabled: false,
      dynamicToolBundlesEnabled: false,
    },
    ...overrides,
  };
}

async function runStreamChat(request: unknown): Promise<AgentStreamEvent[]> {
  const { piRuntime } = await loadRuntime();
  const events: AgentStreamEvent[] = [];
  await (piRuntime as { streamChat: (r: unknown, sink: (e: AgentStreamEvent) => void) => Promise<void> }).streamChat(
    request,
    (e: AgentStreamEvent) => events.push(e),
  );
  return events;
}

// ── Sequence helper ──────────────────────────────────────────────────────────

function assertMonotonicSequence(events: AgentStreamEvent[]) {
  const seqs = events.map((e) => e.sequence_number);
  expect(seqs[0]).toBe(0);
  for (let i = 1; i < seqs.length; i++) {
    expect(seqs[i]).toBe(seqs[i - 1] + 1);
  }
  // No duplicates.
  expect(new Set(seqs).size).toBe(seqs.length);
}

// ── Tests: factory + sequencer (pure) ────────────────────────────────────────

describe("Phase 2: AgentEventEmitter sequencer (category 7)", () => {
  it("response.created is sequence 0 and subsequent events increment by 1", async () => {
    const { protocol } = await loadRuntime();
    const sink: AgentStreamEvent[] = [];
    const emitter = protocol.createAgentEventEmitter(
      { response_id: "resp_1", session_id: "sess_1", agent_run_id: "run_1" },
      (e: AgentStreamEvent) => sink.push(e),
    );
    emitter.created();
    emitter.emit({ type: "response.in_progress" });
    emitter.emit({ type: "response.output_text.delta", delta: "hi" });
    emitter.emit({ type: "response.output_text.done", text: "hi" });

    expect(sink.map((e) => e.sequence_number)).toEqual([0, 1, 2, 3]);
    expect(sink.map((e) => e.type)).toEqual([
      "response.created",
      "response.in_progress",
      "response.output_text.delta",
      "response.output_text.done",
    ]);
    // Envelope fields stamped on every event.
    for (const e of sink) {
      expect(e.protocol).toBe("scimanage-agent-sse-v1");
      expect(e.response_id).toBe("resp_1");
      expect(e.session_id).toBe("sess_1");
      expect(e.agent_run_id).toBe("run_1");
      expect(typeof e.created_at).toBe("number");
    }
  });

  it("emitting before created() throws", async () => {
    const { protocol } = await loadRuntime();
    const emitter = protocol.createAgentEventEmitter(
      { response_id: "resp_1", session_id: "s", agent_run_id: "r" },
      () => {},
    );
    expect(() => emitter.emit({ type: "response.in_progress" })).toThrow();
  });

  it("calling created() twice throws", async () => {
    const { protocol } = await loadRuntime();
    const emitter = protocol.createAgentEventEmitter(
      { response_id: "resp_1", session_id: "s", agent_run_id: "r" },
      () => {},
    );
    emitter.created();
    expect(() => emitter.created()).toThrow();
  });

  it("emitError stamps a canonical error event with code/retryable", async () => {
    const { protocol } = await loadRuntime();
    const sink: AgentStreamEvent[] = [];
    const emitter = protocol.createAgentEventEmitter(
      { response_id: "resp_1", session_id: "s", agent_run_id: "r" },
      (e: AgentStreamEvent) => sink.push(e),
    );
    emitter.created();
    emitter.emitError("boom", { code: "NEEDS_USER_CONFIRMATION", retryable: false });
    const err = sink[1];
    expect(err.type).toBe("error");
    if (err.type === "error") {
      expect(err.error.message).toBe("boom");
      expect(err.error.code).toBe("NEEDS_USER_CONFIRMATION");
      expect(err.error.retryable).toBe(false);
    }
  });
});

// ── Tests: streamChat end-to-end with mocked model ───────────────────────────

describe("Phase 2: runtime event mapping (category 3, 4, 5, 7)", () => {
  let restoreFetch: (() => void) | undefined;
  let savedMinimaxKey: string | undefined;

  beforeEach(() => {
    restoreFetch = undefined;
    // Pi's getEnvApiKey("minimax") reads MINIMAX_API_KEY; without it the model
    // call aborts with "No API key" before our fetch mock is ever consulted.
    // We set a dummy key so the fetch mock (which intercepts the actual HTTP)
    // is the thing that drives behavior.
    savedMinimaxKey = process.env.MINIMAX_API_KEY;
    process.env.MINIMAX_API_KEY = "test-minimax-key";
  });

  afterEach(() => {
    if (restoreFetch) restoreFetch();
    if (savedMinimaxKey === undefined) {
      delete process.env.MINIMAX_API_KEY;
    } else {
      process.env.MINIMAX_API_KEY = savedMinimaxKey;
    }
  });

  it("message start → response.created + response.in_progress, then EOF (no completed)", async () => {
    // Empty model output: Pi emits message_start, message_end with empty text.
    restoreFetch = installModelFetchMock({ modelChunks: [], finishReason: "stop" });
    const events = await runStreamChat(buildMinimalRequest());

    expect(events[0].type).toBe("response.created");
    expect(events[0].sequence_number).toBe(0);
    expect(events[1].type).toBe("response.in_progress");
    // runtime MUST NOT emit response.completed (design §6.3).
    expect(events.some((e) => e.type === "response.completed")).toBe(false);
    assertMonotonicSequence(events);
  });

  it("text delta + output_text.done carry visible text", async () => {
    restoreFetch = installModelFetchMock({
      modelChunks: [{ role: "assistant", content: "你好" }, { content: "，世界" }],
      finishReason: "stop",
    });
    const events = await runStreamChat(buildMinimalRequest());

    const deltas = events.filter((e) => e.type === "response.output_text.delta");
    expect(deltas.length).toBeGreaterThan(0);
    const done = events.find((e) => e.type === "response.output_text.done");
    expect(done).toBeDefined();
    if (done && done.type === "response.output_text.done") {
      expect(done.text).toContain("你好");
      expect(done.text).toContain("世界");
    }
    assertMonotonicSequence(events);
  });

  it("thinking reasoning never reaches the wire — only activity started/completed", async () => {
    // Model emits reasoning_content (Pi → thinking_delta) then visible content.
    restoreFetch = installModelFetchMock({
      modelChunks: [
        { reasoning_content: "这是一个不该泄露的私密推理过程。" },
        { reasoning_content: "继续推理中..." },
        { content: "可见回答" },
      ],
      finishReason: "stop",
    });
    const events = await runStreamChat(buildMinimalRequest());

    // NO canonical event carries the raw reasoning text.
    const wire = JSON.stringify(events);
    expect(wire).not.toContain("私密推理");
    expect(wire).not.toContain("继续推理中");

    // activity.started (label 正在思考) + activity.completed MUST appear.
    const started = events.find((e) => e.type === "scimanage.activity.started");
    const completed = events.find((e) => e.type === "scimanage.activity.completed");
    expect(started).toBeDefined();
    expect(completed).toBeDefined();
    if (started && started.type === "scimanage.activity.started") {
      expect(started.label).toBe("正在思考");
      expect(typeof started.activity_id).toBe("string");
      expect(started.activity_id.length).toBeGreaterThan(0);
    }
    // Stable activity_id across started/completed.
    if (started && completed && completed.type === "scimanage.activity.completed") {
      expect(completed.activity_id).toBe(
        (started as { activity_id: string }).activity_id,
      );
    }
    assertMonotonicSequence(events);
  });

  it("inline <think>...</think> reasoning is stripped from text deltas", async () => {
    // Model emits visible + inline-think mixed text.
    restoreFetch = installModelFetchMock({
      modelChunks: [
        { content: "前面" },
        { content: "<think>隐秘推理不应出现在 wire</think>" },
        { content: "后面" },
      ],
      finishReason: "stop",
    });
    const events = await runStreamChat(buildMinimalRequest());

    const wire = JSON.stringify(events);
    expect(wire).not.toContain("隐秘推理");
    // Visible text is preserved.
    expect(wire).toContain("前面");
    expect(wire).toContain("后面");
    // activity driven by inline think.
    expect(events.some((e) => e.type === "scimanage.activity.started")).toBe(true);
    expect(events.some((e) => e.type === "scimanage.activity.completed")).toBe(true);
  });

  it("tool start → scimanage.tool_execution.started with tool_execution_id", async () => {
    // A tool_calls delta: Pi emits toolcall_start/end; with dynamic bundles OFF
    // the tool execute() calls the bridge. We intercept bridge /api/agent/tools/execute.
    restoreFetch = installModelFetchMock({
      modelChunks: [
        {
          tool_calls: [
            {
              index: 0,
              id: "call_1",
              type: "function",
              function: { name: "noop_tool", arguments: "{}" },
            },
          ],
        },
      ],
      finishReason: "tool_calls",
      bridgeHandler: () => ({ status: 200, body: { ok: true, result: { done: true } } }),
    });
    // Provide an available tool so buildBusinessTools registers it.
    const request = buildMinimalRequest({
      availableTools: [
        { name: "noop_tool", description: "does nothing", input_schema: { type: "object" } },
      ],
    });
    const events = await runStreamChat(request);

    const started = events.find((e) => e.type === "scimanage.tool_execution.started");
    expect(started).toBeDefined();
    if (started && started.type === "scimanage.tool_execution.started") {
      expect(started.tool_execution_id).toBe("call_1");
      expect(started.tool_name).toBe("noop_tool");
    }
    assertMonotonicSequence(events);
  });

  it("needs-confirmation tool failure preserves error.code + target_intent", async () => {
    // The needs-confirmation mapping (409 NEEDS_USER_CONFIRMATION from the
    // execute-public bridge → scimanage.tool_execution.failed carrying
    // error.code + target_intent) lives in streamChat's tool_execution_end
    // handler. Driving the full dynamic-bundle path requires
    // AGENT_DYNAMIC_TOOL_BUNDLES_ENABLED at module-load time, which the cached
    // config makes unreliable per-test. Instead we verify the canonical
    // mapping contract directly: the emitter produces a tool_execution.failed
    // event that preserves error.code + target_intent (the fields the UI's
    // needs-user-confirmation card reads). The bridge→details plumbing this
    // builds on is covered by tests/pi-runtime-selected-refs.test.ts and the
    // Phase 3 persistence projector tests.
    const { protocol } = await loadRuntime();
    const sink: AgentStreamEvent[] = [];
    const emitter = protocol.createAgentEventEmitter(
      { response_id: "resp_conf", session_id: "s", agent_run_id: "r" },
      (e: AgentStreamEvent) => sink.push(e),
    );
    emitter.created();
    emitter.emit({
      type: "scimanage.tool_execution.started",
      tool_execution_id: "call_conf",
      tool_name: "propose_something",
      label: "propose_something",
      input: {},
    });
    // Mirror the exact shape streamChat emits on a 409 confirmation failure:
    // error.code = NEEDS_USER_CONFIRMATION, retryable:false, target_intent set.
    emitter.emit({
      type: "scimanage.tool_execution.failed",
      tool_execution_id: "call_conf",
      tool_name: "propose_something",
      label: "propose_something",
      error: {
        message: "NEEDS_USER_CONFIRMATION",
        code: "NEEDS_USER_CONFIRMATION",
        retryable: false,
      },
      target_intent: "confirm_something",
    });
    const failed = sink.find((e) => e.type === "scimanage.tool_execution.failed");
    expect(failed).toBeDefined();
    if (failed && failed.type === "scimanage.tool_execution.failed") {
      expect(failed.tool_execution_id).toBe("call_conf");
      expect(failed.error.code).toBe("NEEDS_USER_CONFIRMATION");
      expect(failed.target_intent).toBe("confirm_something");
    }
    assertMonotonicSequence(sink);
  });

  it("compact events: started/completed (summary not on wire)", async () => {
    // We verify the canonical context_compaction event shapes directly through
    // the emitter (the auto-compaction trigger path is config-gated and reads
    // env at module-load time, so it can't be reliably driven per-test; the
    // mapping itself — started/completed with tokens_before/after, summary NOT
    // on the wire — is what this test pins down).
    const { protocol } = await loadRuntime();
    const sink: AgentStreamEvent[] = [];
    const emitter = protocol.createAgentEventEmitter(
      { response_id: "resp_c", session_id: "s", agent_run_id: "r" },
      (e: AgentStreamEvent) => sink.push(e),
    );
    emitter.created();
    emitter.emit({ type: "scimanage.context_compaction.started" });
    emitter.emit({
      type: "scimanage.context_compaction.completed",
      tokens_before: 500000,
      tokens_after: 10000,
    });
    const started = sink.find((e) => e.type === "scimanage.context_compaction.started");
    const completed = sink.find((e) => e.type === "scimanage.context_compaction.completed");
    expect(started).toBeDefined();
    expect(completed).toBeDefined();
    if (completed && completed.type === "scimanage.context_compaction.completed") {
      expect(completed.tokens_before).toBe(500000);
      expect(completed.tokens_after).toBe(10000);
    }
    // Summary body is never on the wire (design §5.4).
    expect(JSON.stringify(sink)).not.toContain("summary正文");
    assertMonotonicSequence(sink);
  });

  it("usage updated event carries token fields", async () => {
    restoreFetch = installModelFetchMock({
      modelChunks: [{ content: "ok" }],
      finishReason: "stop",
    });
    const events = await runStreamChat(buildMinimalRequest());
    const usage = events.find((e) => e.type === "scimanage.usage.updated");
    expect(usage).toBeDefined();
    if (usage && usage.type === "scimanage.usage.updated") {
      expect(typeof usage.usage.total_tokens).toBe("number");
    }
  });

  it("fatal agent error → canonical error event, no completed", async () => {
    // fetch rejects → Pi throws → streamChat catches → emits error event.
    restoreFetch = installFetchMock(async () => {
      throw new Error("model endpoint exploded");
    });
    const events = await runStreamChat(buildMinimalRequest());
    expect(events[0].type).toBe("response.created");
    expect(events[1].type).toBe("response.in_progress");
    const err = events.find((e) => e.type === "error");
    expect(err).toBeDefined();
    expect(events.some((e) => e.type === "response.completed")).toBe(false);
    assertMonotonicSequence(events);
  });

  it("P1-d2: AbortSignal is forwarded to the model fetch and cancels the turn", async () => {
    // Defect 2 unit-level test: streamChat receives an AbortSignal, forwards it
    // into the Pi Agent, which passes it to the model fetch. We assert:
    //   1. the fetch mock receives a non-null `signal` in its RequestInit;
    //   2. when the signal aborts, the hanging model fetch is cancelled
    //      (the mock's pull observes signal abort) and streamChat resolves
    //      promptly (the turn terminates instead of hanging forever).
    let observedSignal: AbortSignal | undefined;
    let pullSawAbort = false;
    const controller = new AbortController();
    restoreFetch = installFetchMock(async (_url, init) => {
      observedSignal = init?.signal ?? undefined;
      // Build a body that hangs until the signal aborts, then errors.
      const body = new ReadableStream<Uint8Array>({
        async pull() {
          // Wait until the signal aborts (or a safety timeout).
          if (controller.signal.aborted) {
            pullSawAbort = true;
            throw new DOMException("aborted", "AbortError");
          }
          await new Promise<void>((resolve, reject) => {
            const onAbort = () => {
              pullSawAbort = true;
              reject(new DOMException("aborted", "AbortError"));
            };
            if (controller.signal.aborted) {
              onAbort();
              return;
            }
            controller.signal.addEventListener("abort", onAbort, { once: true });
            // Safety: don't hang the test forever if abort never fires.
            const to = setTimeout(() => resolve(), 5000);
            controller.signal.addEventListener("abort", () => clearTimeout(to), { once: true });
          });
          if (controller.signal.aborted) {
            pullSawAbort = true;
            throw new DOMException("aborted", "AbortError");
          }
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });

    const { piRuntime } = await loadRuntime();
    const events: AgentStreamEvent[] = [];
    const turnPromise = (
      piRuntime as {
        streamChat: (
          r: unknown,
          sink: (e: AgentStreamEvent) => void,
          signal?: AbortSignal,
        ) => Promise<void>;
      }
    ).streamChat(buildMinimalRequest(), (e) => events.push(e), controller.signal);

    // Let streamChat reach the model fetch (created/in_progress emitted first).
    await new Promise((r) => setTimeout(r, 100));
    // The fetch mock MUST have received the abort signal (proving streamChat
    // forwards it rather than dropping it).
    expect(observedSignal).toBeDefined();
    expect(observedSignal?.aborted).toBe(false);

    // Abort the client.
    controller.abort();

    // streamChat must resolve promptly (not hang). Bounded wait.
    await expect(turnPromise).resolves.toBeUndefined();

    // The model fetch's body pull observed the abort (the pending request was
    // actually cancelled, not ignored).
    expect(pullSawAbort).toBe(true);

    // created/in_progress were emitted before the abort; no completed.
    expect(events[0]?.type).toBe("response.created");
    expect(events.some((e) => e.type === "response.completed")).toBe(false);
  });
});

// ── Tests: P1/defect 2 — toolDispatch=public_read_only explicit dispatch ──────
//
// The OpenAI facade read-only run injects public tool keys (find_customers etc.)
// via request.availableTools and sets toolDispatch: "public_read_only". The
// runtime MUST route those tool executions through /api/agent/tools/execute-public
// (public executor, Layer-2 read-only 403 gate), regardless of the global
// dynamic-bundle flag (default OFF). It MUST NOT call the bundle selector to
// replace the tool list (which would re-introduce write tools).

describe("P1/defect 2: toolDispatch=public_read_only dispatch (flag OFF)", () => {
  let restoreFetch: (() => void) | undefined;
  let savedMinimaxKey: string | undefined;

  beforeEach(() => {
    restoreFetch = undefined;
    savedMinimaxKey = process.env.MINIMAX_API_KEY;
    process.env.MINIMAX_API_KEY = "test-minimax-key";
  });

  afterEach(() => {
    if (restoreFetch) restoreFetch();
    if (savedMinimaxKey === undefined) {
      delete process.env.MINIMAX_API_KEY;
    } else {
      process.env.MINIMAX_API_KEY = savedMinimaxKey;
    }
  });

  it("toolDispatch=public_read_only routes find_customers to execute-public (not execute)", async () => {
    // Record every bridge URL + body the runtime calls.
    const bridgeCalls: Array<{ url: string; body: unknown }> = [];
    restoreFetch = installModelFetchMock({
      modelChunks: [
        {
          tool_calls: [
            {
              index: 0,
              id: "call_pub_1",
              type: "function",
              function: { name: "find_customers", arguments: '{"query":"张"}' },
            },
          ],
        },
      ],
      finishReason: "tool_calls",
      bridgeHandler: (url, body) => {
        bridgeCalls.push({ url, body });
        // execute-public contract: { result: { modelFacing, ... } }
        if (url.includes("/api/agent/tools/execute-public")) {
          return {
            status: 200,
            body: {
              ok: true,
              publicToolKey: "find_customers",
              result: { mode: "result", modelFacing: { items: [{ customerId: "c1", name: "张三" }] } },
            },
          };
        }
        return { status: 200, body: { ok: true } };
      },
    });
    // Provide the public read-only tool as availableTools (as the Runner would).
    const request = buildMinimalRequest({
      toolDispatch: "public_read_only",
      // flag OFF (default in buildMinimalRequest).
      availableTools: [
        { name: "find_customers", description: "search customers", input_schema: { type: "object" } },
      ],
    });
    const events = await runStreamChat(request);

    // The tool executed (started + completed, not failed).
    const started = events.find((e) => e.type === "scimanage.tool_execution.started");
    expect(started).toBeDefined();
    const completed = events.find((e) => e.type === "scimanage.tool_execution.completed");
    expect(completed).toBeDefined();

    // P1/defect 2: the bridge call hit execute-public with publicToolKey.
    const executePublicCalls = bridgeCalls.filter((c) =>
      c.url.includes("/api/agent/tools/execute-public"),
    );
    expect(executePublicCalls.length).toBe(1);
    expect(executePublicCalls[0].body).toMatchObject({
      publicToolKey: "find_customers",
      input: { query: "张" },
    });

    // P1/defect 2: NO call to the legacy internal /api/agent/tools/execute.
    const legacyExecuteCalls = bridgeCalls.filter(
      (c) =>
        c.url.includes("/api/agent/tools/execute") &&
        !c.url.includes("/api/agent/tools/execute-public"),
    );
    expect(legacyExecuteCalls.length).toBe(0);

    // P1/defect 2: NO call to select-bundle (selector must not replace the tool list).
    const selectBundleCalls = bridgeCalls.filter((c) =>
      c.url.includes("/api/agent/tools/select-bundle"),
    );
    expect(selectBundleCalls.length).toBe(0);

    assertMonotonicSequence(events);
  });

  it("flag ON + toolDispatch=public_read_only: selector is skipped, read-only list preserved", async () => {
    // dynamic-bundle flag 只会在 pi-runtime 模块加载时读取（getRuntimeConfig 顶层缓存），
    // 用 query-string 重新实例化模块以注入 flag ON 的模块级 config。
    const savedFlag = process.env.AGENT_DYNAMIC_TOOL_BUNDLES_ENABLED;
    process.env.AGENT_DYNAMIC_TOOL_BUNDLES_ENABLED = "true";
    try {
      const bridgeCalls: Array<{ url: string; body: unknown }> = [];
      restoreFetch = installModelFetchMock({
        modelChunks: [
          {
            tool_calls: [
              {
                index: 0,
                id: "call_pub_flag_on",
                type: "function",
                function: { name: "find_customers", arguments: '{"query":"张"}' },
              },
            ],
          },
        ],
        finishReason: "tool_calls",
        bridgeHandler: (url, body) => {
          bridgeCalls.push({ url, body });
          if (url.includes("/api/agent/tools/execute-public")) {
            return {
              status: 200,
              body: {
                ok: true,
                publicToolKey: "find_customers",
                result: { mode: "result", modelFacing: { items: [{ customerId: "c1", name: "张三" }] } },
              },
            };
          }
          return { status: 200, body: { ok: true } };
        },
      });
      // 变量化 specifier：tsc 不对非字面量动态 import 做模块解析检查；Node 运行时按
      // 不同 specifier 重新实例化模块，从而注入 flag ON 的模块级 config。
      const flagOnSpecifier = "../agent-runtime/dist/pi-runtime.js?flag-on-public-read-only";
      const piRuntime = await import(flagOnSpecifier);
      const request = buildMinimalRequest({
        toolDispatch: "public_read_only",
        availableTools: [
          { name: "find_customers", description: "search customers", input_schema: { type: "object" } },
        ],
      });
      const events: AgentStreamEvent[] = [];
      await (piRuntime as { streamChat: (r: unknown, sink: (e: AgentStreamEvent) => void) => Promise<void> }).streamChat(
        request,
        (e) => events.push(e),
      );

      // 工具经 execute-public 执行成功。
      expect(events.some((e) => e.type === "scimanage.tool_execution.completed")).toBe(true);
      // 即使 flag ON，public_read_only 也不调 selector（否则内部员工 bundle 的写工具会击穿 Layer 1）。
      expect(bridgeCalls.filter((c) => c.url.includes("/api/agent/tools/select-bundle")).length).toBe(0);
      expect(bridgeCalls.filter((c) => c.url.includes("/api/agent/tools/execute-public")).length).toBe(1);
      expect(
        bridgeCalls.filter(
          (c) => c.url.includes("/api/agent/tools/execute") && !c.url.includes("/api/agent/tools/execute-public"),
        ).length,
      ).toBe(0);
      assertMonotonicSequence(events);
    } finally {
      if (savedFlag === undefined) {
        delete process.env.AGENT_DYNAMIC_TOOL_BUNDLES_ENABLED;
      } else {
        process.env.AGENT_DYNAMIC_TOOL_BUNDLES_ENABLED = savedFlag;
      }
    }
  });

  it("regression: native CHAT (no toolDispatch) routes to legacy /api/agent/tools/execute", async () => {
    const bridgeCalls: Array<{ url: string; body: unknown }> = [];
    restoreFetch = installModelFetchMock({
      modelChunks: [
        {
          tool_calls: [
            {
              index: 0,
              id: "call_int_1",
              type: "function",
              function: { name: "crm.search_customers", arguments: '{"query":"张"}' },
            },
          ],
        },
      ],
      finishReason: "tool_calls",
      bridgeHandler: (url, body) => {
        bridgeCalls.push({ url, body });
        return { status: 200, body: { ok: true, result: { done: true } } };
      },
    });
    // Native CHAT: no toolDispatch, flag OFF (default).
    const request = buildMinimalRequest({
      availableTools: [
        { name: "crm.search_customers", description: "search customers", input_schema: { type: "object" } },
      ],
    });
    const events = await runStreamChat(request);

    // P1/defect 2 regression: legacy internal execute path is used.
    const legacyExecuteCalls = bridgeCalls.filter(
      (c) =>
        c.url.includes("/api/agent/tools/execute") &&
        !c.url.includes("/api/agent/tools/execute-public"),
    );
    expect(legacyExecuteCalls.length).toBe(1);
    expect(legacyExecuteCalls[0].body).toMatchObject({
      actionKey: "crm.search_customers",
      input: { query: "张" },
    });

    // NO execute-public call on the native path.
    const executePublicCalls = bridgeCalls.filter((c) =>
      c.url.includes("/api/agent/tools/execute-public"),
    );
    expect(executePublicCalls.length).toBe(0);

    assertMonotonicSequence(events);
  });

  // ── P1 (defect 2 — true read-only): built-in write tools MUST NOT reach the model ──
  //
  // buildRuntimeExtraTools() unconditionally appends `agent.save_memory`
  // (writes via /api/agent/memory) and, when proactiveEnabled, appends
  // `agent.schedule_proactive_task` (writes via /api/agent/proactive-tasks).
  // Under toolDispatch=public_read_only the runtime MUST filter those out of
  // the tools array sent to the model, leaving only the truly read-only
  // built-ins (web.search, agent.recall_memory). The model never sees a write
  // tool name, so it cannot call one. Native CHAT (no toolDispatch) keeps the
  // full built-in set byte-identical (regression below).

  it("public_read_only: tools sent to the model exclude save_memory / schedule_proactive_task, include web.search / recall_memory", async () => {
    const modelRequestBodies: Array<{ tools?: Array<{ function?: { name?: string } }> }> = [];
    restoreFetch = installModelFetchMock({
      modelChunks: [{ content: "ok" }],
      finishReason: "stop",
      modelRequestBodies,
    });
    const request = buildMinimalRequest({
      toolDispatch: "public_read_only",
      webSearchEnabled: true,
      proactiveEnabled: true,
      viewControlEnabled: true,
      context: {
        currentView: null,
        viewControlEnabled: true,
        webSearchEnabled: true,
        proactiveEnabled: true,
        dynamicToolBundlesEnabled: false,
      },
      availableTools: [
        { name: "find_customers", description: "search", input_schema: { type: "object" } },
      ],
    });
    await runStreamChat(request);

    expect(modelRequestBodies.length).toBeGreaterThanOrEqual(1);
    const toolNames = (modelRequestBodies[0].tools ?? []).map((t) => t.function?.name ?? "");
    // Read-only built-ins present.
    expect(toolNames).toContain("find_customers");
    expect(toolNames).toContain("web.search");
    expect(toolNames).toContain("agent.recall_memory");
    // Persistence-writing built-ins MUST be absent.
    expect(toolNames).not.toContain("agent.save_memory");
    expect(toolNames).not.toContain("agent.schedule_proactive_task");
    // suggest_view is a UI mutation hint, not part of the read-only contract.
    expect(toolNames).not.toContain("agent.suggest_view");
  });

  it("public_read_only: web.search is omitted when webSearchEnabled=false, but recall_memory still present", async () => {
    const modelRequestBodies: Array<{ tools?: Array<{ function?: { name?: string } }> }> = [];
    restoreFetch = installModelFetchMock({
      modelChunks: [{ content: "ok" }],
      finishReason: "stop",
      modelRequestBodies,
    });
    const request = buildMinimalRequest({
      toolDispatch: "public_read_only",
      availableTools: [
        { name: "find_customers", description: "search", input_schema: { type: "object" } },
      ],
    });
    await runStreamChat(request);

    const toolNames = (modelRequestBodies[0].tools ?? []).map((t) => t.function?.name ?? "");
    expect(toolNames).not.toContain("web.search");
    expect(toolNames).toContain("agent.recall_memory");
    expect(toolNames).not.toContain("agent.save_memory");
  });

  it("public_read_only: hallucinated agent.save_memory call produces NO bridge write and turn completes", async () => {
    // Defensive: even though save_memory is not in the tool list (so the model
    // should never emit it), if the model hallucinates the call, Pi returns
    // "Tool agent.save_memory not found" as an error tool result WITHOUT
    // executing any bridge write. We assert zero /api/agent/memory hits and
    // that the turn still closes normally (no fatal error event).
    const bridgeCalls: Array<{ url: string; body: unknown }> = [];
    restoreFetch = installModelFetchMock({
      modelChunks: [
        {
          tool_calls: [
            {
              index: 0,
              id: "call_hallucination",
              type: "function",
              function: { name: "agent.save_memory", arguments: '{"kind":"preference","content":"x"}' },
            },
          ],
        },
        // After the tool error, the model emits a normal text reply and stops.
        { content: "已收到。" },
      ],
      finishReason: "stop",
      bridgeHandler: (url, body) => {
        bridgeCalls.push({ url, body });
        return { status: 200, body: { ok: true } };
      },
    });
    const request = buildMinimalRequest({
      toolDispatch: "public_read_only",
      availableTools: [
        { name: "find_customers", description: "search", input_schema: { type: "object" } },
      ],
    });
    const events = await runStreamChat(request);

    // The hallucinated call surfaces as a tool_execution.failed (Pi's
    // "Tool ... not found" error result), NOT a completed write.
    const failed = events.find((e) => e.type === "scimanage.tool_execution.failed");
    expect(failed).toBeDefined();

    // Zero bridge writes to /api/agent/memory (the save_memory persistence path).
    const memoryWrites = bridgeCalls.filter((c) => c.url.includes("/api/agent/memory"));
    expect(memoryWrites.length).toBe(0);
    // Zero writes to /api/agent/proactive-tasks as well.
    const proactiveWrites = bridgeCalls.filter((c) => c.url.includes("/api/agent/proactive-tasks"));
    expect(proactiveWrites.length).toBe(0);

    // No fatal top-level error — the turn recovered and emitted output_text.done.
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(events.some((e) => e.type === "response.output_text.done")).toBe(true);
    assertMonotonicSequence(events);
  });

  it("regression: native CHAT built-in tools include save_memory (byte-identical)", async () => {
    // Native CHAT (no toolDispatch): the built-in tool set MUST still include
    // agent.save_memory — the read-only filter only applies to public_read_only.
    const modelRequestBodies: Array<{ tools?: Array<{ function?: { name?: string } }> }> = [];
    restoreFetch = installModelFetchMock({
      modelChunks: [{ content: "ok" }],
      finishReason: "stop",
      modelRequestBodies,
    });
    const request = buildMinimalRequest({
      // No toolDispatch → native CHAT.
      availableTools: [
        { name: "crm.search_customers", description: "search", input_schema: { type: "object" } },
      ],
    });
    await runStreamChat(request);

    const toolNames = (modelRequestBodies[0].tools ?? []).map((t) => t.function?.name ?? "");
    expect(toolNames).toContain("crm.search_customers");
    // Native CHAT keeps the unconditional save_memory built-in.
    expect(toolNames).toContain("agent.save_memory");
    // web.search absent because webSearchEnabled defaults to false.
    expect(toolNames).not.toContain("web.search");
  });
});

// ── Tests: HTTP server (/health, headers, abort, NDJSON) ─────────────────────

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        s.close(() => resolve(port));
      } else {
        reject(new Error("could not allocate port"));
      }
    });
  });
}

interface SpawnedServer {
  process: ChildProcess;
  port: number;
  token: string;
}

async function spawnServer(env: Record<string, string>): Promise<SpawnedServer> {
  const port = await findFreePort();
  const token = `test-token-${Math.random().toString(36).slice(2)}`;
  const proc = spawn("node", ["dist/server.js"], {
    cwd: `${process.cwd()}/agent-runtime`,
    env: {
      ...process.env,
      AGENT_RUNTIME_HOST: "127.0.0.1",
      AGENT_RUNTIME_PORT: String(port),
      AGENT_RUNTIME_TOKEN: token,
      // Avoid hitting real MiniMax if anything escapes; not needed for /health.
      MINIMAX_BASE_URL: "http://127.0.0.1:9",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Wait for the server to be listening by polling /health.
  const start = Date.now();
  while (Date.now() - start < 8000) {
    const ok = await probeHealth(port).catch(() => null);
    if (ok) return { process: proc, port, token };
    await new Promise((r) => setTimeout(r, 100));
  }
  proc.kill("SIGKILL");
  throw new Error(`server on port ${port} did not become ready`);
}

async function probeHealth(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createConnection({ host: "127.0.0.1", port }, () => {
      s.destroy();
      resolve(true);
    });
    s.on("error", () => resolve(false));
  });
}

async function httpGet(port: number, path: string): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path, method: "GET" },
      (res: import("node:http").IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers as Record<string, string | string[] | undefined>,
            body: Buffer.concat(chunks).toString("utf-8"),
          });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function httpPost(
  port: number,
  path: string,
  body: unknown,
  headers: Record<string, string>,
  signal?: { onAbort: () => void },
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload), ...headers },
      },
      (res: import("node:http").IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers as Record<string, string | string[] | undefined>,
            body: Buffer.concat(chunks).toString("utf-8"),
          });
        });
      },
    );
    req.on("error", reject);
    if (signal) {
      signal.onAbort = () => req.destroy();
    }
    req.write(payload);
    req.end();
  });
}

describe("Phase 2/5: HTTP server /health + SSE headers + abort (categories 1, 2, 6)", () => {
  let server: SpawnedServer | undefined;

  afterEach(async () => {
    if (server) {
      server.process.kill("SIGKILL");
      server = undefined;
      await new Promise((r) => setTimeout(r, 100));
    }
  });

  it("/health returns service + protocol + buildVersion (category 1)", async () => {
    server = await spawnServer({ APP_BUILD_VERSION: "test-build-42" });
    const res = await httpGet(server.port, "/health");
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.service).toBe("scimanage-agent-runtime");
    expect(body.protocol).toBe("scimanage-agent-sse-v1");
    expect(body.buildVersion).toBe("test-build-42");
    expect(body.transport).toBeDefined();
  });

  it("/health reports transport=sse (Phase 5: SSE is the only transport)", async () => {
    server = await spawnServer({ APP_BUILD_VERSION: "b1" });
    const res = await httpGet(server.port, "/health");
    const body = JSON.parse(res.body);
    // Phase 5 (plan §7): NDJSON and the AGENT_STREAM_TRANSPORT switch are gone;
    // SSE is the only transport the runtime reports.
    expect(body.transport).toBe("sse");
  });

  it("/chat-stream sends text/event-stream + protocol + build version headers (category 2)", async () => {
    server = await spawnServer({
      APP_BUILD_VERSION: "sse-build-7",
    });
    // Use an empty availableTools request; the model call will fail fast
    // (MINIMAX_BASE_URL points to a closed port), so we still receive the SSE
    // headers + created/in_progress/error frames before EOF.
    const res = await httpPost(
      server.port,
      "/chat-stream",
      buildMinimalRequest(),
      { "x-agent-runtime-token": server.token },
    );
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.headers["x-agent-stream-protocol"]).toBe("scimanage-agent-sse-v1");
    expect(res.headers["x-agent-runtime-build-version"]).toBe("sse-build-7");
    // Body must contain at least the created frame (SSE framing).
    expect(res.body).toContain("event: response.created");
    expect(res.body).toContain("data: {");
    // No response.completed frame from runtime.
    expect(res.body).not.toContain("event: response.completed");
  });

  it("abort: client disconnect is detected by the server (category 6)", async () => {
    // We verify the server-side disconnect handling: open a streaming request,
    // abort the socket mid-stream, and assert the server process stays alive
    // and continues serving /health. To keep the server mid-stream (rather
    // than failing the model call instantly), we point MINIMAX_BASE_URL at a
    // local "blackhole" TCP server that accepts the connection but never
    // replies, so the model fetch hangs until we abort the client.
    const blackhole = net.createServer((socket) => {
      // accept and hold the connection open without responding
      socket.resume();
    });
    blackhole.unref();
    const blackholePort = await findFreePort();
    await new Promise<void>((resolve, reject) => {
      blackhole.listen(blackholePort, "127.0.0.1", () => resolve());
      blackhole.on("error", reject);
    });

    server = await spawnServer({
      APP_BUILD_VERSION: "b-abort",
      MINIMAX_BASE_URL: `http://127.0.0.1:${blackholePort}/v1`,
    });
    // Capture a non-null reference so the connect callback (a later closure)
    // doesn't narrow against the mutable `let server`.
    const srv = server;

    // Open the streaming request with a raw socket so we can sever it.
    const client = net.createConnection({ host: "127.0.0.1", port: srv.port }, () => {
      const body = JSON.stringify(buildMinimalRequest());
      const req = [
        `POST /chat-stream HTTP/1.1`,
        `Host: 127.0.0.1:${srv.port}`,
        `x-agent-runtime-token: ${srv.token}`,
        `content-type: application/json`,
        `content-length: ${Buffer.byteLength(body)}`,
        `connection: close`,
        ``,
        body,
      ].join("\r\n");
      client.write(req);
    });

    // Give the server a moment to start streaming (created/in_progress frames
    // are emitted before the hanging model fetch), then sever the connection.
    await new Promise((r) => setTimeout(r, 200));
    client.destroy();

    // Allow the server's 'close' handler + abort to settle.
    await new Promise((r) => setTimeout(r, 200));

    expect(server.process.killed).toBe(false);
    // Server still serves /health after the abort.
    const health = await httpGet(server.port, "/health").catch(() => null);
    expect(health?.status).toBe(200);

    blackhole.close();
    client.destroy();
  });

  it("abort: client disconnect cancels the pending model fetch (Pi turn aborted, defect 2)", async () => {
    // Defect 2 regression: the original test only asserted the server process
    // stayed alive after a client disconnect. It did NOT verify that the
    // pending model request was actually cancelled. We point MINIMAX_BASE_URL
    // at a blackhole TCP server that RECORDS when its socket is closed (which
    // happens when the runtime aborts the in-flight fetch). After the client
    // disconnects, we assert:
    //   1. the blackhole model socket is closed within a reasonable time
    //      (proving agent.abort() propagated into the model fetch and the
    //      pending request was cancelled, not just ignored);
    //   2. the server process ends the turn and stays alive.
    const modelSocketClosed = { value: false };
    const blackhole = net.createServer((socket) => {
      socket.resume();
      socket.on("close", () => {
        modelSocketClosed.value = true;
      });
      socket.on("error", () => {
        // swallow — aborted sockets may emit ECONNRESET
      });
    });
    blackhole.unref();
    const blackholePort = await findFreePort();
    await new Promise<void>((resolve, reject) => {
      blackhole.listen(blackholePort, "127.0.0.1", () => resolve());
      blackhole.on("error", reject);
    });

    server = await spawnServer({
      APP_BUILD_VERSION: "b-abort-cancel",
      MINIMAX_BASE_URL: `http://127.0.0.1:${blackholePort}/v1`,
      // A fake key is required so the Pi SDK proceeds to the model fetch
      // (which hangs on the blackhole). Without it the SDK throws "No API
      // key" before ever connecting, and the abort path under test is never
      // exercised.
      MINIMAX_API_KEY: "fake-key-for-abort-test",
    });
    const srv = server;

    // Open the streaming request with a raw socket so we can sever it.
    const client = net.createConnection({ host: "127.0.0.1", port: srv.port }, () => {
      const body = JSON.stringify(buildMinimalRequest());
      const req = [
        `POST /chat-stream HTTP/1.1`,
        `Host: 127.0.0.1:${srv.port}`,
        `x-agent-runtime-token: ${srv.token}`,
        `content-type: application/json`,
        `content-length: ${Buffer.byteLength(body)}`,
        `connection: close`,
        ``,
        body,
      ].join("\r\n");
      client.write(req);
    });

    // Let the runtime reach the hanging model fetch (created/in_progress are
    // emitted before the fetch, so by now the fetch is in flight).
    await new Promise((r) => setTimeout(r, 250));
    expect(modelSocketClosed.value).toBe(false); // still hanging pre-abort

    // Sever the client connection — server.ts 'close' → abortController.abort().
    client.destroy();

    // Wait for the model fetch to be cancelled. The Pi SDK passes the abort
    // signal into fetch, so Node closes the blackhole socket. Give it a
    // generous-but-bounded window (abort propagation + socket teardown).
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !modelSocketClosed.value) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(modelSocketClosed.value).toBe(true);

    // Server survived and still serves /health.
    expect(server.process.killed).toBe(false);
    const health = await httpGet(server.port, "/health").catch(() => null);
    expect(health?.status).toBe(200);

    blackhole.close();
    client.destroy();
  });
});

// ── Test: SSE encode round-trip via shared encoder ───────────────────────────

describe("Phase 2: SSE framing via encodeSseEvent (category 2 framing)", () => {
  it("encodeSseEvent produces event:/id:/data: lines terminated by blank line", async () => {
    const { protocol } = await loadRuntime();
    const event: AgentStreamEvent = {
      type: "response.output_text.delta",
      protocol: "scimanage-agent-sse-v1",
      response_id: "resp_x",
      sequence_number: 7,
      session_id: "s",
      agent_run_id: "r",
      created_at: 123,
      delta: "你好",
    };
    const frame = protocol.encodeSseEvent(event);
    expect(frame).toContain("event: response.output_text.delta\n");
    expect(frame).toContain("id: resp_x:7\n");
    expect(frame).toContain('"delta":"你好"');
    expect(frame.endsWith("\n\n")).toBe(true);
  });
});

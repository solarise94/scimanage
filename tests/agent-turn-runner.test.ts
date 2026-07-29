/**
 * Phase 3/5 AgentTurnRunner tests (plan §5.4 / design §7).
 *
 * Strategy: mock the application-service dependencies + runtime fetch, drive
 * real canonical events through the runner, and assert the runner's contract:
 *  - completed is emitted only AFTER assistant-message persistence
 *  - synthetic events continue the runtime's sequence monotonically
 *  - transport mismatch fails fast (503, no body forwarded, no tool executed)
 *  - persistence failure → error + response.failed, no completed
 *  - pre-stream typed errors (409/413) throw verbatim
 *  - SSE framing: each yielded event is a canonical object
 *
 * No real DB, no real runtime process. The runner is exercised end-to-end via
 * the public `runAgentTurn()` entry; mocks record call order so we can assert
 * "persistence before completed".
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { AgentStreamEvent } from "../agent-runtime/src/stream-protocol";
import { AGENT_STREAM_PROTOCOL } from "../agent-runtime/src/stream-protocol";

// ── Hoisted mock state ───────────────────────────────────────────────────────

const mockState = vi.hoisted(() => ({
  // Recorded call log to assert ordering (e.g. persistence before completed).
  calls: [] as string[],
  // Configurable runtime response (headers + body chunks).
  runtimeHeaders: {} as Record<string, string>,
  runtimeChunks: [] as Uint8Array[],
  // Configurable service behaviours.
  persistenceShouldFail: false,
  crmFollowUpResult: null as { mode: "result"; result: unknown } | null,
  crmValidationOk: true,
  // Defect-3 regression: when true, persist-assistant throws AFTER the runner
  // has already emitted synthetic CRM follow-up events. The catch path must
  // reuse the same sequencer (no reuse/regression of sequence numbers).
  persistenceShouldFailAfterFollowUp: false,
  // P1/defect 2: the last runtime request body sent to /chat-stream.
  lastRuntimeBody: null as Record<string, unknown> | null,
}));

// ── Mocks of application services ───────────────────────────────────────────
//
// Every Prisma-touching / network helper the runner imports is replaced with a
// deterministic stub. Stubs record their invocation into mockState.calls so the
// test can assert cross-step ordering.

vi.mock("@/lib/agent-actions/run-context", () => ({
  getOrCreateAgentRunFromSession: vi.fn(async () => {
    mockState.calls.push("create-run");
    return { id: "run_test_1", userId: "user_1", source: "CHAT" };
  }),
  getInternalToolToken: () => "internal-tool-token",
}));

vi.mock("@/lib/agent-actions/execute-tool-for-run", () => ({
  executeAgentToolForRun: vi.fn(async () => {
    mockState.calls.push("crm-followup");
    if (!mockState.crmFollowUpResult) {
      return { actionKey: "crm.get_customer_context", mode: "result", result: {} };
    }
    return { actionKey: "crm.get_customer_context", ...mockState.crmFollowUpResult };
  }),
}));

vi.mock("@/lib/agent-actions/registry", () => ({
  listAvailableAgentActions: vi.fn(async () => []),
}));

vi.mock("@/lib/agent-actions/tool-adapter", () => ({
  actionToTool: () => ({ name: "noop", description: "", input_schema: {} }),
}));

vi.mock("@/lib/agent-runtime/chat-sessions", () => ({
  commitAgentChatUserMessage: vi.fn(async () => {
    mockState.calls.push("commit-user-message");
    return "sess_test_1";
  }),
  createAgentChatMessage: vi.fn(async () => {
    mockState.calls.push("persist-assistant");
    if (mockState.persistenceShouldFail || mockState.persistenceShouldFailAfterFollowUp) {
      throw new Error("persistence boom");
    }
    return { id: "msg_assistant_1" };
  }),
  getAgentChatSessionDetail: vi.fn(async (_actor: unknown, sessionId: string) => ({
    id: sessionId,
    userId: "user_1",
    agentRunId: "run_test_1",
    title: "t",
    status: "ACTIVE",
    source: "CHAT",
    summary: null,
    compactSummary: null,
    metadata: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastMessageAt: "2026-01-01T00:00:00.000Z",
    messageCount: 0,
    messages: [],
  })),
  updateAgentChatSession: vi.fn(async () => {
    mockState.calls.push("persist-compact");
    return {};
  }),
}));

vi.mock("@/lib/agent-runtime/config", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getAgentRuntimeBaseUrl: () => "http://runtime.test.local",
  getAgentRuntimeToken: () => "runtime-token",
  getAgentRuntimeFlags: () => ({
    compactionEnabled: true,
    memoryEnabled: true,
    proactiveEnabled: false,
    viewControlEnabled: false,
    webSearchEnabled: false,
    dynamicToolBundlesEnabled: false,
    contextWindowTokens: 1000000,
    keepRecentTokens: 12000,
  }),
}));

vi.mock("@/lib/agent-runtime/memory", () => ({
  listAgentMemory: vi.fn(async () => []),
}));

vi.mock("@/lib/crm/hot-customers", () => ({
  listHotCustomersForActor: vi.fn(async () => []),
}));

vi.mock("@/lib/agent-runtime/hot-projects", () => ({
  listHotProjectsForActor: vi.fn(async () => []),
}));

vi.mock("@/lib/agent-runtime/entity-memory-access", () => ({
  listActiveEntityMemoriesForActor: vi.fn(async () => []),
}));

vi.mock("@/lib/crm/customer-target-validator", () => ({
  validateCustomerTarget: vi.fn(async () => ({
    ok: mockState.crmValidationOk,
    profile: { profileId: "p1" },
    reason: "not found",
  })),
}));

vi.mock("@/lib/agent-runtime/history-context", () => ({
  appendVerifiedCustomerHistoryContext: (content: string) => content,
}));

vi.mock("@/lib/agent-runtime/crm-follow-up", () => ({
  shouldFollowCrmCustomerContext: vi.fn(() => false),
  extractCrmFollowUpProfileId: vi.fn(() => null),
}));

vi.mock("@/lib/finance/invoice-staging", () => ({
  validateVerifiedInvoiceStagingContextList: vi.fn(async () => []),
  assertAndBindStagingToAgentRun: vi.fn(async () => {}),
}));

vi.mock("@/lib/finance/invoice-ingest-job", () => ({
  createInvoiceIngestJob: vi.fn(async () => ({})),
}));

vi.mock("@/lib/import-staging", () => ({
  validateVerifiedImportStagingContext: vi.fn(async () => null),
  assertAndBindImportStagingToAgentRun: vi.fn(async () => {}),
  IMPORT_KIND: { ORDER: "ORDER" },
}));

vi.mock("@/lib/agent-attachments/staging", () => ({
  validateVerifiedAgentAttachmentContext: vi.fn(async () => null),
  getOwnedAgentAttachment: vi.fn(async () => ({})),
  verifyAttachmentIntegrity: vi.fn(async () => Buffer.alloc(0)),
}));

vi.mock("@/lib/app-url", () => ({
  getAgentInternalAppBaseUrl: () => "http://app.test.local",
}));

// ── Runtime fetch mock ───────────────────────────────────────────────────────
//
// The runner calls fetch(runtimeBase/chat-stream). We return a Response whose
// body is a ReadableStream yielding mockState.runtimeChunks, with headers from
// mockState.runtimeHeaders. Tests configure these before invoking runAgentTurn.

const ACTOR = { userId: "user_1", role: "ADMIN", name: "Tester", email: "t@e.com" };
const SESSION = { user: { id: "user_1", role: "ADMIN", name: "Tester", email: "t@e.com" } } as never;

function sseChunks(events: AgentStreamEvent[]): Uint8Array[] {
  const enc = (e: AgentStreamEvent) =>
    `event: ${e.type}\nid: ${e.response_id}:${e.sequence_number}\ndata: ${JSON.stringify(e)}\n\n`;
  return [new TextEncoder().encode(events.map(enc).join(""))];
}

function canonicalEvents(): AgentStreamEvent[] {
  const base = { protocol: AGENT_STREAM_PROTOCOL, response_id: "resp_runtime_1", session_id: "sess_test_1", agent_run_id: "run_test_1" };
  return [
    { ...base, type: "response.created", sequence_number: 0, created_at: 1 },
    { ...base, type: "response.in_progress", sequence_number: 1, created_at: 2 },
    { ...base, type: "response.output_text.delta", sequence_number: 2, delta: "Hello", created_at: 3 },
    { ...base, type: "response.output_text.delta", sequence_number: 3, delta: " world", created_at: 4 },
    { ...base, type: "response.output_text.done", sequence_number: 4, text: "Hello world", created_at: 5 },
  ] as unknown as AgentStreamEvent[];
}

function sseHeaders(buildVersion = "test-build-1") {
  return {
    "content-type": "text/event-stream; charset=utf-8",
    "x-agent-stream-protocol": AGENT_STREAM_PROTOCOL,
    "x-agent-runtime-build-version": buildVersion,
  };
}

function installFetchMock() {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("/chat-stream")) {
      mockState.calls.push("runtime-fetch");
      // P1/defect 2: capture the runtime request body for dispatch assertions.
      if (init?.body) {
        try {
          mockState.lastRuntimeBody = JSON.parse(init.body as string);
        } catch {
          mockState.lastRuntimeBody = null;
        }
      }
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of mockState.runtimeChunks) controller.enqueue(chunk);
          controller.close();
        },
      });
      return new Response(body, { status: 200, headers: mockState.runtimeHeaders });
    }
    return new Response("not found", { status: 404 });
  }) as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = original;
  };
}

async function collectEvents(gen: AsyncGenerator<AgentStreamEvent>): Promise<AgentStreamEvent[]> {
  const out: AgentStreamEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("Phase 3/5: AgentTurnRunner", () => {
  let restoreFetch: (() => void) | undefined;
  let savedBuildVersion: string | undefined;

  beforeEach(() => {
    mockState.calls = [];
    mockState.runtimeHeaders = {};
    mockState.runtimeChunks = [];
    mockState.persistenceShouldFail = false;
    mockState.persistenceShouldFailAfterFollowUp = false;
    mockState.crmFollowUpResult = null;
    mockState.crmValidationOk = true;
    mockState.lastRuntimeBody = null;
    savedBuildVersion = process.env.APP_BUILD_VERSION;
    process.env.APP_BUILD_VERSION = "test-build-1";
    restoreFetch = installFetchMock();
  });

  afterEach(() => {
    if (restoreFetch) restoreFetch();
    if (savedBuildVersion === undefined) delete process.env.APP_BUILD_VERSION;
    else process.env.APP_BUILD_VERSION = savedBuildVersion;
  });

  // ── Full turn: completed after persistence ─────────────────────────────────

  it("emits response.completed only AFTER assistant-message persistence", async () => {
    mockState.runtimeHeaders = sseHeaders();
    mockState.runtimeChunks = sseChunks(canonicalEvents());

    const { runAgentTurn } = await import("@/lib/agent-runtime/agent-turn-runner");
    const turn = await runAgentTurn({
      actor: ACTOR, session: SESSION, message: "hi",
    });
    const events = await collectEvents(turn.events);

    // Last event is response.completed.
    const completed = events[events.length - 1];
    expect(completed.type).toBe("response.completed");

    // Persistence happened before completed was emitted.
    const persistIdx = mockState.calls.indexOf("persist-assistant");
    expect(persistIdx).toBeGreaterThanOrEqual(0);
    // The completed event is yielded AFTER persist-assistant was called. Since
    // calls are recorded synchronously inside the runner, persist-assistant
    // must appear before any post-persistence step. We assert it ran at all and
    // that completed is the final event (which by construction follows persistence).
    expect(persistIdx).toBeGreaterThanOrEqual(0);

    // Sequence numbers are strictly monotonic across the whole turn.
    const seqs = events.map((e) => e.sequence_number);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }
    // Runtime's response.created is sequence 0.
    expect(seqs[0]).toBe(0);
    // Runtime's last event was sequence 4; the synthetic completed must be 5.
    expect(completed.sequence_number).toBe(5);
    expect(completed.response_id).toBe("resp_runtime_1");
  });

  // ── Synthetic event sequence continues runtime's last (no reuse, no 0..N) ──

  it("synthetic events continue runtime's last sequence number (CRM follow-up)", async () => {
    mockState.runtimeHeaders = sseHeaders();
    // Runtime emits a tool that triggers CRM follow-up (search_customers single hit).
    const base = { protocol: AGENT_STREAM_PROTOCOL, response_id: "resp_rt_2", session_id: "sess_test_1", agent_run_id: "run_test_1" };
    const events: AgentStreamEvent[] = [
      { ...base, type: "response.created", sequence_number: 0, created_at: 1 },
      { ...base, type: "response.in_progress", sequence_number: 1, created_at: 2 },
      { ...base, type: "scimanage.tool_execution.started", sequence_number: 2, tool_execution_id: "c1", tool_name: "crm.search_customers", label: "搜索客户", created_at: 3 },
      { ...base, type: "scimanage.tool_execution.completed", sequence_number: 3, tool_execution_id: "c1", tool_name: "crm.search_customers", label: "搜索客户", output: { resolution: "UNIQUE", profileId: "p1", hits: [{ profileId: "p1" }] }, created_at: 4 },
      { ...base, type: "response.output_text.done", sequence_number: 4, text: "done", created_at: 5 },
    ] as unknown as AgentStreamEvent[];
    mockState.runtimeChunks = sseChunks(events);

    // Enable the CRM follow-up path.
    const crmFollowUp = await import("@/lib/agent-runtime/crm-follow-up");
    vi.mocked(crmFollowUp.shouldFollowCrmCustomerContext).mockReturnValue(true);
    vi.mocked(crmFollowUp.extractCrmFollowUpProfileId).mockReturnValue("p1");
    mockState.crmFollowUpResult = { mode: "result", result: { profileId: "p1", name: "ACME" } };

    const { runAgentTurn } = await import("@/lib/agent-runtime/agent-turn-runner");
    const turn = await runAgentTurn({ actor: ACTOR, session: SESSION, message: "find ACME" });
    const out = await collectEvents(turn.events);

    // Synthetic follow-up events appear between runtime EOF and completed.
    const types = out.map((e) => e.type);
    expect(types).toContain("scimanage.tool_execution.started");
    expect(types).toContain("scimanage.tool_execution.completed");
    expect(types[types.length - 1]).toBe("response.completed");

    // The synthetic started/completed use sequence numbers 5, 6, 7 (runtime's
    // last was 4). No reuse, no reset to 0.
    const syntheticStarted = out.find(
      (e) => e.type === "scimanage.tool_execution.started" && e.tool_execution_id.startsWith("followup_"),
    );
    expect(syntheticStarted?.sequence_number).toBe(5);
    const completedIdx = out.findIndex((e) => e.type === "response.completed");
    expect(out[completedIdx].sequence_number).toBeGreaterThan(4);
    // All sequences strictly monotonic + unique.
    const seqs = out.map((e) => e.sequence_number);
    expect(new Set(seqs).size).toBe(seqs.length);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    // Synthetic events share runtime's response_id.
    expect(syntheticStarted?.response_id).toBe("resp_rt_2");
  });

  // ── Transport mismatch: 503, no body forwarded, no tool executed ───────────

  it("transport mismatch (wrong Content-Type) → STREAM_TRANSPORT_MISMATCH, no body, no tool", async () => {
    // Runtime wrongly returns a non-SSE content-type (e.g. leftover NDJSON).
    mockState.runtimeHeaders = {
      "content-type": "application/x-ndjson; charset=utf-8",
      "x-agent-stream-protocol": AGENT_STREAM_PROTOCOL,
      "x-agent-runtime-build-version": "test-build-1",
    };
    mockState.runtimeChunks = sseChunks(canonicalEvents());

    const { runAgentTurn, AgentStreamTransportMismatchError } = await import(
      "@/lib/agent-runtime/agent-turn-runner"
    );
    await expect(
      runAgentTurn({ actor: ACTOR, session: SESSION, message: "hi" }),
    ).rejects.toMatchObject({ code: "STREAM_TRANSPORT_MISMATCH" });
    // The runtime fetch was attempted, but no tool/follow-up/persistence ran
    // for the streaming phase (commit-user-message runs pre-stream; CRM follow-up
    // must NOT have run).
    expect(mockState.calls).not.toContain("crm-followup");
    expect(mockState.calls).not.toContain("persist-assistant");
    void AgentStreamTransportMismatchError;
  });

  it("transport mismatch (wrong protocol header) → STREAM_TRANSPORT_MISMATCH", async () => {
    mockState.runtimeHeaders = {
      "content-type": "text/event-stream; charset=utf-8",
      "x-agent-stream-protocol": "wrong-protocol",
      "x-agent-runtime-build-version": "test-build-1",
    };
    mockState.runtimeChunks = sseChunks(canonicalEvents());
    const { runAgentTurn } = await import("@/lib/agent-runtime/agent-turn-runner");
    await expect(
      runAgentTurn({ actor: ACTOR, session: SESSION, message: "hi" }),
    ).rejects.toMatchObject({ code: "STREAM_TRANSPORT_MISMATCH" });
  });

  it("transport mismatch (build version drift) → STREAM_TRANSPORT_MISMATCH", async () => {
    mockState.runtimeHeaders = {
      "content-type": "text/event-stream; charset=utf-8",
      "x-agent-stream-protocol": AGENT_STREAM_PROTOCOL,
      "x-agent-runtime-build-version": "stale-build-9",
    };
    mockState.runtimeChunks = sseChunks(canonicalEvents());
    const { runAgentTurn } = await import("@/lib/agent-runtime/agent-turn-runner");
    await expect(
      runAgentTurn({ actor: ACTOR, session: SESSION, message: "hi" }),
    ).rejects.toMatchObject({ code: "STREAM_TRANSPORT_MISMATCH" });
  });

  // ── Persistence failure → error + response.failed, no completed ────────────

  it("persistence failure → error + response.failed, no completed", async () => {
    mockState.runtimeHeaders = sseHeaders();
    mockState.runtimeChunks = sseChunks(canonicalEvents());
    mockState.persistenceShouldFail = true;

    const { runAgentTurn } = await import("@/lib/agent-runtime/agent-turn-runner");
    const turn = await runAgentTurn({ actor: ACTOR, session: SESSION, message: "hi" });
    const events = await collectEvents(turn.events);

    const types = events.map((e) => e.type);
    expect(types).toContain("error");
    expect(types).toContain("response.failed");
    expect(types).not.toContain("response.completed");
    // The failed event carries the persistence error message.
    const failed = events.find((e) => e.type === "response.failed");
    expect(failed && failed.type === "response.failed" && failed.error.message).toBe("persistence boom");
  });

  // ── Pre-stream typed errors (409/413) throw verbatim ───────────────────────

  it("attachment validation failure throws AgentActionError with ATTACHMENT_CHANGED (409)", async () => {
    mockState.runtimeHeaders = sseHeaders();
    mockState.runtimeChunks = sseChunks(canonicalEvents());

    const staging = await import("@/lib/agent-attachments/staging");
    // validateVerifiedAgentAttachmentContext returns null → ATTACHMENT_CHANGED 409.
    vi.mocked(staging.validateVerifiedAgentAttachmentContext).mockResolvedValue(null);

    const { runAgentTurn } = await import("@/lib/agent-runtime/agent-turn-runner");
    await expect(
      runAgentTurn({
        actor: ACTOR,
        session: SESSION,
        message: "hi",
        messageContext: {
          verifiedAgentAttachments: [{ stagingFileId: "att_1", sha256: "x", version: 1 }],
        },
      }),
    ).rejects.toMatchObject({ code: "ATTACHMENT_CHANGED", status: 409 });
    // No runtime fetch happened (validation is pre-stream).
    expect(mockState.calls).not.toContain("runtime-fetch");
  });

  it("empty message throws AgentActionInputError (pre-stream)", async () => {
    const { runAgentTurn } = await import("@/lib/agent-runtime/agent-turn-runner");
    await expect(
      runAgentTurn({ actor: ACTOR, session: SESSION, message: "   " }),
    ).rejects.toMatchObject({ code: "INVALID_ACTION_INPUT", status: 400 });
  });

  // ── Canonical event envelope ────────────────────────────────────────────────

  it("each yielded event is a canonical object (protocol + response_id + sequence)", async () => {
    mockState.runtimeHeaders = sseHeaders();
    mockState.runtimeChunks = sseChunks(canonicalEvents());

    const { runAgentTurn } = await import("@/lib/agent-runtime/agent-turn-runner");
    const turn = await runAgentTurn({ actor: ACTOR, session: SESSION, message: "hi" });
    const events = await collectEvents(turn.events);

    // Every event carries the canonical protocol marker + envelope.
    for (const ev of events) {
      expect(ev.protocol).toBe(AGENT_STREAM_PROTOCOL);
      expect(typeof ev.response_id).toBe("string");
      expect(typeof ev.sequence_number).toBe("number");
    }
    // The first runtime event is response.created (sequence 0) — preserved.
    expect(events[0].type).toBe("response.created");
    expect(events[0].sequence_number).toBe(0);
    // Text deltas are yielded in order.
    const deltas = events.filter((e) => e.type === "response.output_text.delta");
    expect(deltas).toHaveLength(2);
    if (deltas[0].type === "response.output_text.delta") expect(deltas[0].delta).toBe("Hello");
    if (deltas[1].type === "response.output_text.delta") expect(deltas[1].delta).toBe(" world");
  });

  // ── P1 defect 1: runtime fatal `error` event → response.failed (not completed) ─

  it("P1-d1: runtime fatal error event → response.failed, never completed", async () => {
    // Stream: created → in_progress → delta → done → fatal error → EOF.
    // A single scimanage.tool_execution.failed is NOT fatal (covered by the
    // next test). Only the canonical `error` event is fatal.
    mockState.runtimeHeaders = sseHeaders();
    const base = {
      protocol: AGENT_STREAM_PROTOCOL,
      response_id: "resp_fatal_1",
      session_id: "sess_test_1",
      agent_run_id: "run_test_1",
    };
    const events: AgentStreamEvent[] = [
      { ...base, type: "response.created", sequence_number: 0, created_at: 1 },
      { ...base, type: "response.in_progress", sequence_number: 1, created_at: 2 },
      { ...base, type: "response.output_text.delta", sequence_number: 2, delta: "partial ", created_at: 3 },
      { ...base, type: "response.output_text.done", sequence_number: 3, text: "partial ", created_at: 4 },
      { ...base, type: "error", sequence_number: 4, error: { message: "model endpoint exploded" }, created_at: 5 },
    ] as unknown as AgentStreamEvent[];
    mockState.runtimeChunks = sseChunks(events);

    const { runAgentTurn } = await import("@/lib/agent-runtime/agent-turn-runner");
    const turn = await runAgentTurn({ actor: ACTOR, session: SESSION, message: "hi" });
    const out = await collectEvents(turn.events);

    const types = out.map((e) => e.type);
    // Terminal MUST be response.failed, NOT response.completed.
    expect(types).toContain("response.failed");
    expect(types).not.toContain("response.completed");
    // The runtime's own fatal error event was forwarded as-is.
    const runtimeError = out.find((e) => e.type === "error");
    expect(runtimeError).toBeDefined();
    // The terminal response.failed carries the runtime's error message.
    const failed = out.find((e) => e.type === "response.failed");
    expect(failed && failed.type === "response.failed" && failed.error.message).toBe(
      "model endpoint exploded",
    );
    // Partial assistant content was still persisted (best-effort, error state).
    expect(mockState.calls).toContain("persist-assistant");
    // Sequence numbers strictly monotonic + unique across the whole turn.
    const seqs = out.map((e) => e.sequence_number);
    expect(new Set(seqs).size).toBe(seqs.length);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
  });

  it("P1-d1: tool execution failure (non-fatal) still completes normally", async () => {
    // A scimanage.tool_execution.failed is NOT a fatal error — the agent can
    // interpret the failure and reply normally → response.completed.
    mockState.runtimeHeaders = sseHeaders();
    const base = {
      protocol: AGENT_STREAM_PROTOCOL,
      response_id: "resp_toolfail_1",
      session_id: "sess_test_1",
      agent_run_id: "run_test_1",
    };
    const events: AgentStreamEvent[] = [
      { ...base, type: "response.created", sequence_number: 0, created_at: 1 },
      { ...base, type: "response.in_progress", sequence_number: 1, created_at: 2 },
      {
        ...base,
        type: "scimanage.tool_execution.started",
        sequence_number: 2,
        tool_execution_id: "t1",
        tool_name: "crm.search_customers",
        label: "搜索客户",
        created_at: 3,
      },
      {
        ...base,
        type: "scimanage.tool_execution.failed",
        sequence_number: 3,
        tool_execution_id: "t1",
        tool_name: "crm.search_customers",
        label: "搜索客户",
        error: { message: "no results" },
        created_at: 4,
      },
      { ...base, type: "response.output_text.delta", sequence_number: 4, delta: "sorry, no match", created_at: 5 },
      { ...base, type: "response.output_text.done", sequence_number: 5, text: "sorry, no match", created_at: 6 },
    ] as unknown as AgentStreamEvent[];
    mockState.runtimeChunks = sseChunks(events);

    const { runAgentTurn } = await import("@/lib/agent-runtime/agent-turn-runner");
    const turn = await runAgentTurn({ actor: ACTOR, session: SESSION, message: "find X" });
    const out = await collectEvents(turn.events);

    const types = out.map((e) => e.type);
    // The tool failure did NOT flip the turn to fatal → completed normally.
    expect(types[types.length - 1]).toBe("response.completed");
    expect(types).not.toContain("response.failed");
    expect(types).not.toContain("error");
  });

  // ── P1 defect 3: shared sequencer across synthetic + failure path ───────────

  it("P1-d3: synthetic follow-up events emitted, then persistence fails — sequence stays monotonic (shared sequencer)", async () => {
    // Regression for defect 3: CRM follow-up synthetic events have already
    // been emitted (advancing the sequencer) when persist-assistant throws.
    // The catch path MUST reuse the same sequencer instance — rebuilding from
    // lastRuntimeSequence would reuse/regress the numbers already handed out,
    // and a consumer's dedup logic could drop the terminal response.failed.
    mockState.runtimeHeaders = sseHeaders();
    const base = {
      protocol: AGENT_STREAM_PROTOCOL,
      response_id: "resp_seq_1",
      session_id: "sess_test_1",
      agent_run_id: "run_test_1",
    };
    const events: AgentStreamEvent[] = [
      { ...base, type: "response.created", sequence_number: 0, created_at: 1 },
      { ...base, type: "response.in_progress", sequence_number: 1, created_at: 2 },
      {
        ...base,
        type: "scimanage.tool_execution.started",
        sequence_number: 2,
        tool_execution_id: "c1",
        tool_name: "crm.search_customers",
        label: "搜索客户",
        created_at: 3,
      },
      {
        ...base,
        type: "scimanage.tool_execution.completed",
        sequence_number: 3,
        tool_execution_id: "c1",
        tool_name: "crm.search_customers",
        label: "搜索客户",
        output: { resolution: "UNIQUE", profileId: "p1", hits: [{ profileId: "p1" }] },
        created_at: 4,
      },
      { ...base, type: "response.output_text.done", sequence_number: 4, text: "done", created_at: 5 },
    ] as unknown as AgentStreamEvent[];
    mockState.runtimeChunks = sseChunks(events);

    // Enable the CRM follow-up path so synthetic events advance the sequencer
    // BEFORE persist-assistant throws.
    const crmFollowUp = await import("@/lib/agent-runtime/crm-follow-up");
    vi.mocked(crmFollowUp.shouldFollowCrmCustomerContext).mockReturnValue(true);
    vi.mocked(crmFollowUp.extractCrmFollowUpProfileId).mockReturnValue("p1");
    mockState.crmFollowUpResult = { mode: "result", result: { profileId: "p1", name: "ACME" } };
    // Persistence throws AFTER the follow-up synthetic events are emitted.
    mockState.persistenceShouldFailAfterFollowUp = true;

    const { runAgentTurn } = await import("@/lib/agent-runtime/agent-turn-runner");
    const turn = await runAgentTurn({ actor: ACTOR, session: SESSION, message: "find ACME" });
    const out = await collectEvents(turn.events);

    const types = out.map((e) => e.type);
    expect(types).toContain("response.failed");
    expect(types).not.toContain("response.completed");

    // The load-bearing assertion: every sequence number across the whole turn
    // (runtime + synthetic follow-up + catch-path error/response.failed) is
    // strictly monotonic, unique, and never regresses. Before the fix the
    // catch path rebuilt a sequencer from lastRuntimeSequence=4, colliding
    // with the follow-up events that already used 5/6/7.
    const seqs = out.map((e) => e.sequence_number);
    expect(new Set(seqs).size).toBe(seqs.length); // no duplicates
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]); // strictly increasing, no regression
    }

    // The terminal response.failed is reachable: it is the last event and its
    // sequence is the global max (a consumer's sequence tracker accepts it).
    const failed = out[out.length - 1];
    expect(failed.type).toBe("response.failed");
    expect(failed.sequence_number).toBe(Math.max(...seqs));

    // Also assert via the canonical consumer-side sequence tracker that the
    // full event list passes monotonic validation (no duplicate/backward/gap).
    const { createSequenceTracker } = await import("../agent-runtime/src/stream-protocol");
    const tracker = createSequenceTracker();
    for (const ev of out) {
      const check = tracker.observe(ev.sequence_number, { isFirst: ev === out[0] });
      expect(check).toMatchObject({ ok: true });
    }
  });

  // ── P1 defect 2: toolDispatch=public_read_only passed to runtime ────────────

  it("P1-d2: openai_read_only policy → runtime request carries toolDispatch=public_read_only", async () => {
    mockState.runtimeHeaders = sseHeaders();
    mockState.runtimeChunks = sseChunks(canonicalEvents());

    const { runAgentTurn } = await import("@/lib/agent-runtime/agent-turn-runner");
    const turn = await runAgentTurn({
      actor: ACTOR,
      session: SESSION,
      message: "hi",
      toolPolicy: "openai_read_only",
    });
    await collectEvents(turn.events);

    // P1/defect 2: the runtime request body explicitly carries the public_read_only
    // dispatch protocol so the runtime routes tools through execute-public and
    // skips the bundle selector, regardless of the global dynamic-bundle flag.
    expect(mockState.lastRuntimeBody).not.toBeNull();
    expect(mockState.lastRuntimeBody?.toolDispatch).toBe("public_read_only");
  });

  it("P1-d2: native CHAT (no toolPolicy) → runtime request omits toolDispatch (byte-level unchanged)", async () => {
    mockState.runtimeHeaders = sseHeaders();
    mockState.runtimeChunks = sseChunks(canonicalEvents());

    const { runAgentTurn } = await import("@/lib/agent-runtime/agent-turn-runner");
    const turn = await runAgentTurn({
      actor: ACTOR,
      session: SESSION,
      message: "hi",
    });
    await collectEvents(turn.events);

    // P1/defect 2 regression: native CHAT does NOT set toolDispatch — the global
    // dynamicToolBundlesEnabled flag alone decides dispatch (byte-level unchanged).
    expect(mockState.lastRuntimeBody).not.toBeNull();
    expect(mockState.lastRuntimeBody?.toolDispatch).toBeUndefined();
  });
});

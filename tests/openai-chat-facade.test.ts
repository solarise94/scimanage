/**
 * Phase 6 — OpenAI-compatible facade tests (plan §8.10 / §8.12).
 *
 * Coverage:
 *  - disabled → 404; invalid/missing key → 401 (auth module + routes).
 *  - /v1/models returns only the configured model id.
 *  - model mismatch → 404.
 *  - projection: stream=true chunks (role first, content delta, stop, usage,
 *    [DONE]); stream=false aggregation.
 *  - request validation: tools/tool_choice/functions/function_call → 400;
 *    tool/function role history → 400; actor/role/scope injection → 400.
 *  - NO scimanage.* events cross the facade.
 *  - NO tool_calls ever emitted.
 *
 * Strategy:
 *  - The pure projection + auth + parse logic is unit-tested directly.
 *  - The route handler is exercised with runAgentTurn mocked so we drive real
 *    canonical events through the projection without a runtime process.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import type { AgentStreamEvent } from "../agent-runtime/src/stream-protocol";
import { AGENT_STREAM_PROTOCOL } from "../agent-runtime/src/stream-protocol";
import {
  OpenAiChatProjection,
  DONE_FRAME,
  isProjectedEventType,
} from "@/lib/agent-runtime/openai-chat-projection";
import {
  readOpenAiCompatConfig,
  safeEqualSecret,
  extractBearerToken,
  authenticateOpenAiCompatRequest,
  DEFAULT_OPENAI_COMPAT_MODEL_ID,
} from "@/lib/agent-runtime/openai-compat-auth";

// ── Hoisted mock state for the route handler tests ───────────────────────────

const mockState = vi.hoisted(() => ({
  // Canonical events the mocked runAgentTurn will yield.
  events: [] as AgentStreamEvent[],
  // Recorded call args (to assert source / toolPolicy).
  lastCall: null as
    | { source?: string; toolPolicy?: string; externalHistory?: unknown[] }
    | null,
}));

// Mock the runner so the route does not perform a real runtime fetch.
vi.mock("@/lib/agent-runtime/agent-turn-runner", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/lib/agent-runtime/agent-turn-runner")
  >();
  return {
    ...actual,
    runAgentTurn: vi.fn(async (input: {
      source?: string;
      toolPolicy?: string;
      externalHistory?: unknown[];
    }) => {
      mockState.lastCall = {
        source: input.source,
        toolPolicy: input.toolPolicy,
        externalHistory: input.externalHistory,
      };
      const events = mockState.events;
      async function* gen(): AsyncGenerator<AgentStreamEvent, void, unknown> {
        for (const e of events) yield e;
      }
      return {
        sessionId: "sess_facade_1",
        agentRunId: "run_facade_1",
        responseId: "resp_facade_1",
        events: gen(),
      };
    }),
  };
});

// ── Fixture canonical events ─────────────────────────────────────────────────

const BASE = {
  protocol: AGENT_STREAM_PROTOCOL,
  response_id: "resp_facade_1",
  session_id: "sess_facade_1",
  agent_run_id: "run_facade_1",
};

function fixtureEvents(opts?: { withUsage?: boolean; withScimanage?: boolean }): AgentStreamEvent[] {
  const out: AgentStreamEvent[] = [
    { ...BASE, type: "response.created", sequence_number: 0, created_at: 1 } as AgentStreamEvent,
    { ...BASE, type: "response.in_progress", sequence_number: 1, created_at: 2 } as AgentStreamEvent,
  ];
  if (opts?.withScimanage) {
    // Internal events that must NEVER cross the facade.
    out.push(
      {
        ...BASE,
        type: "scimanage.tool_execution.started",
        sequence_number: 2,
        tool_execution_id: "te_1",
        tool_name: "crm.find_customers",
        label: "搜索客户",
        created_at: 3,
      } as AgentStreamEvent,
    );
    out.push(
      {
        ...BASE,
        type: "scimanage.tool_execution.completed",
        sequence_number: 3,
        tool_execution_id: "te_1",
        tool_name: "crm.find_customers",
        label: "搜索客户",
        output: { hits: [] },
        created_at: 4,
      } as AgentStreamEvent,
    );
    out.push({
      ...BASE,
      type: "scimanage.activity.started",
      sequence_number: 4,
      activity_id: "a1",
      label: "thinking",
      created_at: 5,
    } as AgentStreamEvent);
  }
  if (opts?.withUsage) {
    out.push({
      ...BASE,
      type: "scimanage.usage.updated",
      sequence_number: 5,
      usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
      created_at: 6,
    } as AgentStreamEvent);
  }
  out.push(
    { ...BASE, type: "response.output_text.delta", sequence_number: 6, delta: "Hello", created_at: 7 } as AgentStreamEvent,
    { ...BASE, type: "response.output_text.delta", sequence_number: 7, delta: " world", created_at: 8 } as AgentStreamEvent,
    {
      ...BASE,
      type: "response.completed",
      sequence_number: 8,
      status: "completed",
      usage: opts?.withUsage
        ? { input_tokens: 10, output_tokens: 20, total_tokens: 30 }
        : undefined,
      created_at: 9,
    } as AgentStreamEvent,
  );
  return out;
}

// ── env helpers ──────────────────────────────────────────────────────────────

const SAVED_ENV: Record<string, string | undefined> = {};

function setFacadeEnv(overrides: Record<string, string> = {}) {
  const base: Record<string, string> = {
    AGENT_OPENAI_COMPAT_ENABLED: "true",
    AGENT_OPENAI_COMPAT_API_KEY: "test-key-123",
    AGENT_OPENAI_COMPAT_USER_ID: "user_facade_1",
    AGENT_OPENAI_COMPAT_MODEL_ID: "scimanage-agent",
    ...overrides,
  };
  for (const [k, v] of Object.entries(base)) {
    if (SAVED_ENV[k] === undefined) SAVED_ENV[k] = process.env[k];
    process.env[k] = v;
  }
}

function clearFacadeEnv() {
  for (const k of [
    "AGENT_OPENAI_COMPAT_ENABLED",
    "AGENT_OPENAI_COMPAT_API_KEY",
    "AGENT_OPENAI_COMPAT_USER_ID",
    "AGENT_OPENAI_COMPAT_MODEL_ID",
  ]) {
    if (SAVED_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED_ENV[k];
    delete SAVED_ENV[k];
  }
}

// ── Auth module tests ────────────────────────────────────────────────────────

describe("Phase 6 facade auth — config + constant-time compare", () => {
  afterEach(() => clearFacadeEnv());

  it("disabled by default when env unset → enabled=false", () => {
    clearFacadeEnv();
    const cfg = readOpenAiCompatConfig({});
    expect(cfg.enabled).toBe(false);
    expect(cfg.modelId).toBe(DEFAULT_OPENAI_COMPAT_MODEL_ID);
  });

  it("enabled=true requires flag AND key AND userId", () => {
    expect(readOpenAiCompatConfig({ AGENT_OPENAI_COMPAT_ENABLED: "true" }).enabled).toBe(false);
    expect(
      readOpenAiCompatConfig({
        AGENT_OPENAI_COMPAT_ENABLED: "true",
        AGENT_OPENAI_COMPAT_API_KEY: "k",
      }).enabled,
    ).toBe(false);
    expect(
      readOpenAiCompatConfig({
        AGENT_OPENAI_COMPAT_ENABLED: "true",
        AGENT_OPENAI_COMPAT_API_KEY: "k",
        AGENT_OPENAI_COMPAT_USER_ID: "u",
      }).enabled,
    ).toBe(true);
  });

  it("safeEqualSecret is constant-time and length-safe", () => {
    expect(safeEqualSecret("secret", "secret")).toBe(true);
    expect(safeEqualSecret("secret", "secre")).toBe(false);
    expect(safeEqualSecret("secret", "secretX")).toBe(false);
    expect(safeEqualSecret("", "secret")).toBe(false);
    expect(safeEqualSecret("secret", "")).toBe(false);
  });

  it("extractBearerToken parses 'Bearer <token>'", () => {
    expect(extractBearerToken("Bearer abc123")).toBe("abc123");
    expect(extractBearerToken("bearer abc123")).toBe("abc123");
    expect(extractBearerToken("Token abc123")).toBe(null);
    expect(extractBearerToken(null)).toBe(null);
    expect(extractBearerToken("Bearer ")).toBe(null);
  });
});

describe("Phase 6 facade auth — authenticateOpenAiCompatRequest", () => {
  // Mock resolveCurrentBusinessActor to avoid DB.
  vi.mock("@/lib/application/actor", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/lib/application/actor")>();
    return {
      ...actual,
      resolveCurrentBusinessActor: vi.fn(async (input: { userId: string }) => ({
        userId: input.userId,
        role: "ADMIN",
        department: "FIELD_SALES",
        name: "Facade",
        email: "f@e.com",
      })),
    };
  });

  beforeEach(() => {
    setFacadeEnv();
  });
  afterEach(() => clearFacadeEnv());

  it("disabled → 404 OPENAI_COMPAT_DISABLED", async () => {
    clearFacadeEnv();
    const r = await authenticateOpenAiCompatRequest("Bearer test-key-123", {
      AGENT_OPENAI_COMPAT_ENABLED: "false",
      AGENT_OPENAI_COMPAT_API_KEY: "test-key-123",
      AGENT_OPENAI_COMPAT_USER_ID: "user_facade_1",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(404);
      expect(r.code).toBe("OPENAI_COMPAT_DISABLED");
    }
  });

  it("missing key → 401 MISSING_API_KEY", async () => {
    const r = await authenticateOpenAiCompatRequest(null);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(401);
      expect(r.code).toBe("MISSING_API_KEY");
    }
  });

  it("invalid key → 401 INVALID_API_KEY", async () => {
    const r = await authenticateOpenAiCompatRequest("Bearer wrong-key");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(401);
      expect(r.code).toBe("INVALID_API_KEY");
    }
  });

  it("valid key → resolves live actor", async () => {
    const r = await authenticateOpenAiCompatRequest("Bearer test-key-123");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.actor.userId).toBe("user_facade_1");
      expect(r.actor.role).toBe("ADMIN");
      expect(r.config.modelId).toBe("scimanage-agent");
    }
  });
});

// ── Projection tests (pure) ──────────────────────────────────────────────────

describe("Phase 6 facade projection — stream chunks", () => {
  it("emits role first, then content deltas, then stop + [DONE]", () => {
    const proj = new OpenAiChatProjection({
      completionId: "chatcmpl_1",
      modelId: "scimanage-agent",
      includeUsage: false,
    });
    const frames: string[] = [];
    for (const ev of fixtureEvents()) frames.push(...proj.project(ev));

    const allJson = frames.filter((f) => f.startsWith("data: ") && f !== DONE_FRAME);
    expect(allJson.length).toBeGreaterThan(0);
    const chunks = allJson.map((f) => JSON.parse(f.slice("data: ".length).trim()));

    // First chunk carries delta.role = assistant.
    const first = chunks[0];
    expect(first.choices[0].delta.role).toBe("assistant");
    expect(first.choices[0].finish_reason).toBeNull();

    // Content deltas.
    const contentChunks = chunks.filter((c) => typeof c.choices[0].delta.content === "string");
    expect(contentChunks.map((c) => c.choices[0].delta.content).join("")).toBe("Hello world");

    // Stop chunk.
    const stop = chunks[chunks.length - 1];
    expect(stop.choices[0].finish_reason).toBe("stop");
    expect(stop.choices[0].delta).toEqual({});

    // [DONE] terminal.
    expect(frames[frames.length - 1]).toBe(DONE_FRAME);
  });

  it("emits usage chunk before [DONE] when include_usage=true", () => {
    const proj = new OpenAiChatProjection({
      completionId: "chatcmpl_1",
      modelId: "scimanage-agent",
      includeUsage: true,
    });
    const frames: string[] = [];
    for (const ev of fixtureEvents({ withUsage: true })) frames.push(...proj.project(ev));
    const chunks = frames
      .filter((f) => f.startsWith("data: ") && f !== DONE_FRAME)
      .map((f) => JSON.parse(f.slice("data: ".length).trim()));
    const stop = chunks[chunks.length - 1];
    expect(stop.usage).toEqual({ prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 });
  });

  it("filters out ALL scimanage.* events; never emits tool_calls", () => {
    const proj = new OpenAiChatProjection({
      completionId: "chatcmpl_1",
      modelId: "scimanage-agent",
      includeUsage: true,
    });
    const frames: string[] = [];
    for (const ev of fixtureEvents({ withUsage: true, withScimanage: true })) {
      frames.push(...proj.project(ev));
    }
    const blob = frames.join("");
    // No scimanage.* type strings leak.
    expect(blob).not.toContain("scimanage.");
    expect(blob).not.toContain("tool_execution");
    expect(blob).not.toContain("tool_calls");
    expect(blob).not.toContain("activity");
    // tool_calls key never appears in any delta.
    for (const f of frames) {
      if (!f.startsWith("data: ") || f === DONE_FRAME) continue;
      const chunk = JSON.parse(f.slice("data: ".length).trim());
      for (const choice of chunk.choices ?? []) {
        expect(choice.delta?.tool_calls).toBeUndefined();
      }
    }
  });

  it("P1/defect 5: response.failed → explicit error frame + [DONE], NO finish_reason=stop", () => {
    const proj = new OpenAiChatProjection({
      completionId: "chatcmpl_1",
      modelId: "scimanage-agent",
      includeUsage: false,
    });
    const failedEvents: AgentStreamEvent[] = [
      { ...BASE, type: "response.created", sequence_number: 0, created_at: 1 } as AgentStreamEvent,
      {
        ...BASE,
        type: "response.output_text.delta",
        sequence_number: 1,
        delta: "partial",
        created_at: 2,
      } as AgentStreamEvent,
      {
        ...BASE,
        type: "response.failed",
        sequence_number: 2,
        error: { message: "boom" },
        created_at: 3,
      } as AgentStreamEvent,
    ];
    const frames: string[] = [];
    for (const ev of failedEvents) frames.push(...proj.project(ev));
    // Stream terminates with [DONE].
    expect(frames[frames.length - 1]).toBe(DONE_FRAME);
    const blob = frames.join("");
    // NO tool_calls ever.
    expect(blob).not.toContain('"tool_calls"');
    // P1/defect 5: NO finish_reason=stop on the failure path (must not mask as success).
    expect(blob).not.toContain('"finish_reason":"stop"');
    // P1/defect 5: an explicit OpenAI-compatible error frame IS emitted.
    expect(blob).toContain('"error"');
    expect(blob).toContain('"message":"boom"');
    expect(blob).toContain('"type":"server_error"');
    // P1/defect 5: NO usage chunk disguising the failure as success.
    expect(blob).not.toContain('"prompt_tokens"');
    // Already-streamed content is NOT rolled back.
    expect(blob).toContain('"content":"partial"');
    // Projection reports failure state.
    expect(proj.failed).toBe(true);
    expect(proj.failure?.message).toBe("boom");
  });

  it("P1/defect 5: response.failed with error.code → error frame carries code", () => {
    const proj = new OpenAiChatProjection({
      completionId: "chatcmpl_1",
      modelId: "scimanage-agent",
      includeUsage: true,
    });
    const failedEvents: AgentStreamEvent[] = [
      {
        ...BASE,
        type: "response.failed",
        sequence_number: 0,
        error: { message: "model overloaded", code: "MODEL_OVERLOADED" },
        created_at: 1,
      } as AgentStreamEvent,
    ];
    const frames: string[] = [];
    for (const ev of failedEvents) frames.push(...proj.project(ev));
    const blob = frames.join("");
    expect(blob).toContain('"code":"MODEL_OVERLOADED"');
    expect(blob).toContain('"message":"model overloaded"');
    // No usage chunk (would disguise failure as success).
    expect(blob).not.toContain('"prompt_tokens"');
    expect(proj.failure?.code).toBe("MODEL_OVERLOADED");
  });

  it("P1/defect 5: completed path is unaffected (stop/usage/[DONE] still emitted)", () => {
    const proj = new OpenAiChatProjection({
      completionId: "chatcmpl_1",
      modelId: "scimanage-agent",
      includeUsage: true,
    });
    const frames: string[] = [];
    for (const ev of fixtureEvents({ withUsage: true })) frames.push(...proj.project(ev));
    const blob = frames.join("");
    // Normal completion still has finish_reason=stop.
    expect(blob).toContain('"finish_reason":"stop"');
    // Usage chunk present.
    expect(blob).toContain('"prompt_tokens":10');
    // No error frame on the success path.
    expect(blob).not.toContain('"error"');
    expect(proj.failed).toBe(false);
    expect(proj.failure).toBeNull();
  });

  it("isProjectedEventType: only delta/completed/failed produce wire output", () => {
    expect(isProjectedEventType("response.output_text.delta")).toBe(true);
    expect(isProjectedEventType("response.completed")).toBe(true);
    expect(isProjectedEventType("response.failed")).toBe(true);
    expect(isProjectedEventType("scimanage.tool_execution.started")).toBe(false);
    expect(isProjectedEventType("scimanage.activity.completed")).toBe(false);
    expect(isProjectedEventType("response.created")).toBe(false);
  });

  it("stream=false aggregation: toCompletion returns full text + usage", () => {
    const proj = new OpenAiChatProjection({
      completionId: "chatcmpl_1",
      modelId: "scimanage-agent",
      includeUsage: true,
    });
    for (const ev of fixtureEvents({ withUsage: true })) proj.project(ev);
    const completion = proj.toCompletion();
    expect(completion.object).toBe("chat.completion");
    expect(completion.choices[0].message.content).toBe("Hello world");
    expect(completion.choices[0].message.role).toBe("assistant");
    expect(completion.choices[0].finish_reason).toBe("stop");
    expect(completion.usage).toEqual({ prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 });
  });
});

// ── Route handler tests (with mocked runAgentTurn) ───────────────────────────

describe("Phase 6 facade route — /v1/models", () => {
  beforeEach(() => setFacadeEnv());
  afterEach(() => clearFacadeEnv());

  it("disabled → 404", async () => {
    clearFacadeEnv();
    process.env.AGENT_OPENAI_COMPAT_ENABLED = "false";
    process.env.AGENT_OPENAI_COMPAT_API_KEY = "test-key-123";
    process.env.AGENT_OPENAI_COMPAT_USER_ID = "user_facade_1";
    const { GET } = await import("@/app/v1/models/route");
    const req = new Request("http://localhost/v1/models", {
      headers: { authorization: "Bearer test-key-123" },
    });
    const res = await GET(req);
    expect(res.status).toBe(404);
  });

  it("missing key → 401", async () => {
    const { GET } = await import("@/app/v1/models/route");
    const req = new Request("http://localhost/v1/models");
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it("valid key → returns only configured model id", async () => {
    const { GET } = await import("@/app/v1/models/route");
    const req = new Request("http://localhost/v1/models", {
      headers: { authorization: "Bearer test-key-123" },
    });
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.object).toBe("list");
    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe("scimanage-agent");
    expect(body.data[0].owned_by).toBe("scimanage");
    // Never exposes a MiniMax model name.
    expect(JSON.stringify(body)).not.toContain("minimax");
    expect(JSON.stringify(body)).not.toContain("abab");
  });
});

describe("Phase 6 facade route — /v1/chat/completions", () => {
  beforeEach(() => {
    setFacadeEnv();
    mockState.events = fixtureEvents({ withUsage: true });
    mockState.lastCall = null;
  });
  afterEach(() => clearFacadeEnv());

  it("disabled → 404", async () => {
    clearFacadeEnv();
    process.env.AGENT_OPENAI_COMPAT_ENABLED = "false";
    process.env.AGENT_OPENAI_COMPAT_API_KEY = "test-key-123";
    process.env.AGENT_OPENAI_COMPAT_USER_ID = "user_facade_1";
    const { POST } = await import("@/app/v1/chat/completions/route");
    const req = new NextRequest("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        authorization: "Bearer test-key-123",
      },
      body: JSON.stringify({
        model: "scimanage-agent",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(404);
  });

  it("invalid key → 401", async () => {
    const { POST } = await import("@/app/v1/chat/completions/route");
    const req = new NextRequest("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        authorization: "Bearer wrong",
      },
      body: JSON.stringify({
        model: "scimanage-agent",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("model mismatch → 404", async () => {
    const { POST } = await import("@/app/v1/chat/completions/route");
    const req = new NextRequest("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        authorization: "Bearer test-key-123",
      },
      body: JSON.stringify({
        model: "gpt-4",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(404);
  });

  it("stream=true → SSE chunks with role/content/stop/usage/[DONE]", async () => {
    const { POST } = await import("@/app/v1/chat/completions/route");
    const req = new NextRequest("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        authorization: "Bearer test-key-123",
      },
      body: JSON.stringify({
        model: "scimanage-agent",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
        stream_options: { include_usage: true },
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    // [DONE] terminal present.
    expect(text).toContain("data: [DONE]");
    // role assistant in first content chunk.
    expect(text).toContain('"role":"assistant"');
    // content deltas.
    expect(text).toContain('"content":"Hello"');
    expect(text).toContain('"content":" world"');
    // stop finish_reason.
    expect(text).toContain('"finish_reason":"stop"');
    // usage chunk.
    expect(text).toContain('"prompt_tokens":10');
    // NO tool_calls, NO scimanage.*.
    expect(text).not.toContain("tool_calls");
    expect(text).not.toContain("scimanage.");

    // Runner was called with the read-only policy + OPENAI_COMPAT source.
    // (toolDispatch: "public_read_only" is derived inside the Runner from
    // toolPolicy=openai_read_only and tested at the runtime level in
    // agent-runtime-sse.test.ts.)
    expect(mockState.lastCall?.source).toBe("OPENAI_COMPAT");
    expect(mockState.lastCall?.toolPolicy).toBe("openai_read_only");
  });

  it("stream=false → single aggregated completion (same event stream)", async () => {
    const { POST } = await import("@/app/v1/chat/completions/route");
    const req = new NextRequest("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        authorization: "Bearer test-key-123",
      },
      body: JSON.stringify({
        model: "scimanage-agent",
        messages: [{ role: "user", content: "hi" }],
        stream: false,
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json();
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0].message.role).toBe("assistant");
    expect(body.choices[0].message.content).toBe("Hello world");
    expect(body.choices[0].finish_reason).toBe("stop");
    // No tool_calls, no scimanage.*.
    expect(JSON.stringify(body)).not.toContain("tool_calls");
    expect(JSON.stringify(body)).not.toContain("scimanage.");
  });

  // ── P1/defect 5: response.failed projection (streaming + non-streaming) ──

  it("P1/defect 5: stream=true failed → error frame, no stop finish_reason, no usage chunk", async () => {
    // Override the mocked events to end in response.failed (no completed).
    mockState.events = [
      { ...BASE, type: "response.created", sequence_number: 0, created_at: 1 } as AgentStreamEvent,
      {
        ...BASE,
        type: "response.output_text.delta",
        sequence_number: 1,
        delta: "partial reply",
        created_at: 2,
      } as AgentStreamEvent,
      {
        ...BASE,
        type: "response.failed",
        sequence_number: 2,
        error: { message: "model exploded" },
        created_at: 3,
      } as AgentStreamEvent,
    ];
    const { POST } = await import("@/app/v1/chat/completions/route");
    const req = new NextRequest("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        authorization: "Bearer test-key-123",
      },
      body: JSON.stringify({
        model: "scimanage-agent",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
        stream_options: { include_usage: true },
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    // [DONE] terminal present.
    expect(text).toContain("data: [DONE]");
    // P1/defect 5: explicit error frame present.
    expect(text).toContain('"error"');
    expect(text).toContain('"message":"model exploded"');
    expect(text).toContain('"type":"server_error"');
    // P1/defect 5: NO finish_reason=stop (must not mask failure as success).
    expect(text).not.toContain('"finish_reason":"stop"');
    // P1/defect 5: NO usage chunk disguising the failure as success.
    expect(text).not.toContain('"prompt_tokens"');
    // Already-streamed content is NOT rolled back.
    expect(text).toContain('"content":"partial reply"');
    // No tool_calls leak.
    expect(text).not.toContain("tool_calls");
  });

  it("P1/defect 5: stream=false failed → non-200 + OpenAI error JSON body", async () => {
    mockState.events = [
      { ...BASE, type: "response.created", sequence_number: 0, created_at: 1 } as AgentStreamEvent,
      {
        ...BASE,
        type: "response.output_text.delta",
        sequence_number: 1,
        delta: "partial",
        created_at: 2,
      } as AgentStreamEvent,
      {
        ...BASE,
        type: "response.failed",
        sequence_number: 2,
        error: { message: "upstream runtime down", code: "RUNTIME_UNAVAILABLE" },
        created_at: 3,
      } as AgentStreamEvent,
    ];
    const { POST } = await import("@/app/v1/chat/completions/route");
    const req = new NextRequest("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        authorization: "Bearer test-key-123",
      },
      body: JSON.stringify({
        model: "scimanage-agent",
        messages: [{ role: "user", content: "hi" }],
        stream: false,
      }),
    });
    const res = await POST(req);
    // P1/defect 5: non-200 (502 Bad Gateway).
    expect(res.status).toBe(502);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json();
    // OpenAI error JSON body shape.
    expect(body.error).toBeDefined();
    expect(body.error.message).toBe("upstream runtime down");
    expect(body.error.type).toBe("server_error");
    expect(body.error.code).toBe("RUNTIME_UNAVAILABLE");
    // NOT a normal completion object.
    expect(body.object).toBeUndefined();
    expect(body.choices).toBeUndefined();
  });

  it("P1/defect 5: stream=false completed → 200 + normal completion (no regression)", async () => {
    // Default fixtureEvents end in response.completed.
    mockState.events = fixtureEvents({ withUsage: true });
    const { POST } = await import("@/app/v1/chat/completions/route");
    const req = new NextRequest("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        authorization: "Bearer test-key-123",
      },
      body: JSON.stringify({
        model: "scimanage-agent",
        messages: [{ role: "user", content: "hi" }],
        stream: false,
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0].finish_reason).toBe("stop");
    expect(body.error).toBeUndefined();
  });

  // ── 400 rejections (§8.6) ──

  it("non-empty tools → 400 (not silently ignored)", async () => {
    const { POST } = await import("@/app/v1/chat/completions/route");
    const req = new NextRequest("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        authorization: "Bearer test-key-123",
      },
      body: JSON.stringify({
        model: "scimanage-agent",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "function", function: { name: "x" } }],
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain("client-provided tools");
  });

  it("tool_choice → 400", async () => {
    const { POST } = await import("@/app/v1/chat/completions/route");
    const req = new NextRequest("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        authorization: "Bearer test-key-123",
      },
      body: JSON.stringify({
        model: "scimanage-agent",
        messages: [{ role: "user", content: "hi" }],
        tool_choice: "auto",
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("functions → 400", async () => {
    const { POST } = await import("@/app/v1/chat/completions/route");
    const req = new NextRequest("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        authorization: "Bearer test-key-123",
      },
      body: JSON.stringify({
        model: "scimanage-agent",
        messages: [{ role: "user", content: "hi" }],
        functions: [{ name: "x" }],
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("function_call → 400", async () => {
    const { POST } = await import("@/app/v1/chat/completions/route");
    const req = new NextRequest("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        authorization: "Bearer test-key-123",
      },
      body: JSON.stringify({
        model: "scimanage-agent",
        messages: [{ role: "user", content: "hi" }],
        function_call: "auto",
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("tool/function role history → 400", async () => {
    const { POST } = await import("@/app/v1/chat/completions/route");
    const req = new NextRequest("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        authorization: "Bearer test-key-123",
      },
      body: JSON.stringify({
        model: "scimanage-agent",
        messages: [
          { role: "user", content: "hi" },
          { role: "tool", content: "result" },
        ],
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("message with tool_calls field → 400", async () => {
    const { POST } = await import("@/app/v1/chat/completions/route");
    const req = new NextRequest("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        authorization: "Bearer test-key-123",
      },
      body: JSON.stringify({
        model: "scimanage-agent",
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "", tool_calls: [{ id: "1" }] },
        ],
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("actor/role/scope injection field → 400", async () => {
    const { POST } = await import("@/app/v1/chat/completions/route");
    const req = new NextRequest("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        authorization: "Bearer test-key-123",
      },
      body: JSON.stringify({
        model: "scimanage-agent",
        messages: [{ role: "user", content: "hi" }],
        user: "admin",
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("passes external cold-start history to runner (not persisted)", async () => {
    const { POST } = await import("@/app/v1/chat/completions/route");
    const req = new NextRequest("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        authorization: "Bearer test-key-123",
      },
      body: JSON.stringify({
        model: "scimanage-agent",
        messages: [
          { role: "system", content: "You are helpful." },
          { role: "user", content: "what is 1+1" },
          { role: "assistant", content: "2" },
          { role: "user", content: "and 2+2" },
        ],
        stream: false,
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    // externalHistory = messages before the LAST user message.
    expect(mockState.lastCall?.externalHistory).toEqual([
      { role: "system", content: "You are helpful." },
      { role: "user", content: "what is 1+1" },
      { role: "assistant", content: "2" },
    ]);
  });
});

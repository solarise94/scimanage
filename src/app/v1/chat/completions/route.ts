/**
 * Phase 6 — OpenAI-compatible `POST /v1/chat/completions` (execution plan §8.6-8.9
 * / design §10).
 *
 * Thin facade over the single Agent turn executor `runAgentTurn()`. It:
 *  - authenticates via the OpenAI-compat gate (env API key → live BusinessActor).
 *  - validates the OpenAI request (rejects unsupported fields with 400, never
 *    silently ignoring them).
 *  - builds the last user message + external cold-start history.
 *  - calls runAgentTurn({ source: "OPENAI_COMPAT", toolPolicy: "openai_read_only" }).
 *  - projects the SAME canonical event stream to either streaming
 *    ChatCompletionChunk SSE or a single aggregated non-streaming completion.
 *
 * It does NOT:
 *  - call legacy /api/agent/chat;
 *  - re-execute the model for stream=false;
 *  - duplicate persistence (the runner owns it);
 *  - emit tool_calls (design §10.5);
 *  - trust body.user / role / scope.
 */
import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import type { Session } from "next-auth";
import { authenticateOpenAiCompatRequest } from "@/lib/agent-runtime/openai-compat-auth";
import {
  OPENAI_COMPAT_RUN_SOURCE,
} from "@/lib/agent-runtime/openai-compat-policy";
import {
  OpenAiChatProjection,
  DONE_FRAME,
  OPENAI_FACADE_FAILURE_STATUS,
  type OpenAiError,
} from "@/lib/agent-runtime/openai-chat-projection";
import {
  AgentActionError,
  AgentActionInputError,
} from "@/lib/agent-actions/errors";
import {
  AgentStreamTransportMismatchError,
  runAgentTurn,
} from "@/lib/agent-runtime/agent-turn-runner";

export const dynamic = "force-dynamic";

/** A validated OpenAI chat completion request (after rejecting unsupported). */
interface ParsedOpenAiRequest {
  model: string;
  messages: Array<{ role: string; content: unknown }>;
  stream: boolean;
  includeUsage: boolean;
  lastUserMessage: string;
  externalHistory: Array<{ role: "system" | "user" | "assistant"; content: string }>;
}

/** Rejection reason for unsupported request fields (§8.6). */
const UNSUPPORTED_TOOLS_MESSAGE =
  "scimanage-agent executes server-owned tools internally; client-provided tools are not supported";

/**
 * Validate the OpenAI request body. Throws AgentActionInputError (400) on any
 * unsupported / injected field. Never silently ignores.
 */
function parseAndValidateOpenAiRequest(body: unknown, expectedModel: string): ParsedOpenAiRequest {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new AgentActionInputError("Request body must be a JSON object");
  }
  const b = body as Record<string, unknown>;

  // ── model ──
  const model = typeof b.model === "string" ? b.model.trim() : "";
  if (!model) {
    throw new AgentActionInputError("model is required");
  }
  if (model !== expectedModel) {
    // §8.6: model mismatch. 404 is the OpenAI convention for unknown model.
    const err = new AgentActionInputError(`Model not found: ${model}`);
    err.status = 404;
    throw err;
  }

  // ── messages ──
  if (!Array.isArray(b.messages) || b.messages.length === 0) {
    throw new AgentActionInputError("messages must be a non-empty array");
  }
  const rawMessages = b.messages as unknown[];
  const messages: Array<{ role: string; content: unknown }> = [];
  for (const raw of rawMessages) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new AgentActionInputError("each message must be an object");
    }
    const msg = raw as Record<string, unknown>;
    const role = typeof msg.role === "string" ? msg.role : "";
    // Reject tool / function role history (§8.6).
    if (role === "tool" || role === "function") {
      throw new AgentActionInputError(
        "tool/function role messages are not supported; scimanage-agent runs server-owned tools",
      );
    }
    if (!["system", "user", "assistant"].includes(role)) {
      throw new AgentActionInputError(`Unsupported message role: ${role || "(missing)"}`);
    }
    // Reject messages carrying tool_calls / function_call / tool_call_id (§8.6).
    if ("tool_calls" in msg || "function_call" in msg || "tool_call_id" in msg || "name" in msg) {
      throw new AgentActionInputError(
        "tool_calls / function_call / name fields are not supported in messages",
      );
    }
    messages.push({ role, content: msg.content });
  }

  // ── explicitly rejected fields (§8.6) ──
  if ("tools" in b) {
    const tools = b.tools;
    if (Array.isArray(tools) && tools.length > 0) {
      throw new AgentActionInputError(UNSUPPORTED_TOOLS_MESSAGE);
    }
  }
  if ("tool_choice" in b && b.tool_choice !== undefined && b.tool_choice !== null) {
    throw new AgentActionInputError("tool_choice is not supported");
  }
  if ("functions" in b) {
    const functions = b.functions;
    if (Array.isArray(functions) && functions.length > 0) {
      throw new AgentActionInputError("functions are not supported");
    }
  }
  if ("function_call" in b && b.function_call !== undefined && b.function_call !== null) {
    throw new AgentActionInputError("function_call is not supported");
  }
  // Reject actor/role/scope injection fields (§8.6 / §11.3).
  for (const injectedField of ["user", "actor", "role", "scope", "department", "userId"]) {
    if (injectedField in b) {
      throw new AgentActionInputError(
        `Field "${injectedField}" is not accepted; identity is resolved server-side`,
      );
    }
  }

  // ── stream ──
  const stream = b.stream === true;

  // ── stream_options.include_usage ──
  let includeUsage = false;
  if (b.stream_options && typeof b.stream_options === "object" && !Array.isArray(b.stream_options)) {
    const opts = b.stream_options as Record<string, unknown>;
    if (opts.include_usage === true) includeUsage = true;
  } else if (!stream) {
    // Non-streaming always returns usage when available.
    includeUsage = true;
  }

  // ── extract last user message + cold-start external history ──
  // Find the last user message content; everything before it is external
  // cold-start context (design §8.7). We never persist external history; only
  // the real this-turn user message is persisted by the runner.
  let lastUserMessage = "";
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx < 0) {
    throw new AgentActionInputError("messages must contain at least one user message");
  }
  const lastContent = messages[lastUserIdx].content;
  lastUserMessage =
    typeof lastContent === "string"
      ? lastContent
      : Array.isArray(lastContent)
        ? lastContent
            .map((part) =>
              part && typeof part === "object" && "text" in part
                ? String((part as Record<string, unknown>).text ?? "")
                : "",
            )
            .join("")
        : "";
  if (!lastUserMessage.trim()) {
    throw new AgentActionInputError("last user message must have non-empty text content");
  }

  // External history = messages before the last user message (cold-start only).
  const externalHistory: Array<{ role: "system" | "user" | "assistant"; content: string }> = [];
  for (let i = 0; i < lastUserIdx; i++) {
    const m = messages[i];
    const role = m.role as "system" | "user" | "assistant";
    const content =
      typeof m.content === "string"
        ? m.content
        : Array.isArray(m.content)
          ? m.content
              .map((part) =>
                part && typeof part === "object" && "text" in part
                  ? String((part as Record<string, unknown>).text ?? "")
                  : "",
              )
              .join("")
          : "";
    if (content) externalHistory.push({ role, content });
  }

  return { model, messages, stream, includeUsage, lastUserMessage, externalHistory };
}

export async function POST(req: NextRequest): Promise<Response> {
  // ── auth (fail-closed 404 when disabled/misconfigured; 401 on bad key) ──
  const auth = await authenticateOpenAiCompatRequest(req.headers.get("authorization"));
  if (!auth.ok) {
    return NextResponse.json(
      { error: { message: auth.error, type: "invalid_request_error", code: auth.code } },
      { status: auth.status },
    );
  }
  const { actor, config } = auth;

  // ── parse + validate (400 on unsupported fields) ──
  let parsed: ParsedOpenAiRequest;
  try {
    const body = await req.json().catch(() => null);
    parsed = parseAndValidateOpenAiRequest(body, config.modelId);
  } catch (error) {
    if (error instanceof AgentActionError) {
      const status = error.status;
      return NextResponse.json(
        {
          error: {
            message: error.message,
            type: "invalid_request_error",
            code: error.code,
          },
        },
        { status },
      );
    }
    return NextResponse.json(
      { error: { message: "Invalid request body", type: "invalid_request_error" } },
      { status: 400 },
    );
  }

  const completionId = `chatcmpl-${randomUUID().replace(/-/g, "").slice(0, 24)}`;

  // ── run the single Agent turn ──
  // The facade always creates a new session (new run) per request in the first
  // iteration. The runner stamps source = OPENAI_COMPAT and injects only
  // discovery/context tools (toolPolicy = openai_read_only). externalHistory is
  // passed as cold-start context; server-side session is the source of truth.
  let turn: Awaited<ReturnType<typeof runAgentTurn>>;
  try {
    turn = await runAgentTurn({
      actor,
      // The runner uses session only for getOrCreateAgentRunFromSession which
      // reads session.user.id/role. We synthesize a minimal trusted session
      // from the live-resolved actor (the actor's role was just refreshed from
      // the DB by authenticateOpenAiCompatRequest).
      session: {
        user: {
          id: actor.userId,
          role: actor.role,
          name: actor.name,
          email: actor.email,
          department: actor.department,
        },
      } as Session,
      message: parsed.lastUserMessage,
      source: OPENAI_COMPAT_RUN_SOURCE,
      toolPolicy: "openai_read_only",
      externalHistory: parsed.externalHistory,
      signal: req.signal,
    });
  } catch (error) {
    return mapRunnerError(error);
  }

  const projection = new OpenAiChatProjection({
    completionId,
    modelId: config.modelId,
    includeUsage: parsed.includeUsage,
  });

  if (parsed.stream) {
    return streamResponse(turn, projection);
  }
  return nonStreamResponse(turn, projection);
}

/** Build the SSE streaming response from the canonical event stream. */
function streamResponse(
  turn: Awaited<ReturnType<typeof runAgentTurn>>,
  projection: OpenAiChatProjection,
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const event of turn.events) {
          for (const frame of projection.project(event)) {
            controller.enqueue(encoder.encode(frame));
          }
        }
      } catch (error) {
        console.error("[openai-compat] stream encoding failed:", error);
        // Best-effort terminal so the client doesn't hang.
        controller.enqueue(encoder.encode(DONE_FRAME));
      } finally {
        controller.close();
      }
    },
    cancel(reason) {
      console.warn("[openai-compat] client disconnected:", reason);
    },
  });
  return new Response(stream, {
    headers: {
      "Cache-Control": "no-cache, no-transform",
      "Content-Type": "text/event-stream; charset=utf-8",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

/** Aggregate the SAME event stream into a single non-streaming completion. */
async function nonStreamResponse(
  turn: Awaited<ReturnType<typeof runAgentTurn>>,
  projection: OpenAiChatProjection,
): Promise<Response> {
  try {
    for await (const event of turn.events) {
      // project() also accumulates text + usage internally for toCompletion().
      projection.project(event);
    }
  } catch (error) {
    console.error("[openai-compat] non-stream aggregation failed:", error);
    return NextResponse.json(
      {
        error: {
          message: "Agent turn failed",
          type: "server_error",
        },
      },
      { status: 500 },
    );
  }
  // P1 (defect 5): if the aggregated turn ended in response.failed, return a
  // non-200 OpenAI error JSON body instead of a normal completion. Clients can
  // then distinguish success from failure.
  if (projection.failed) {
    const error: OpenAiError = projection.failure ?? {
      message: "Agent turn failed",
      type: "server_error",
    };
    return NextResponse.json({ error }, { status: OPENAI_FACADE_FAILURE_STATUS });
  }
  const completion = projection.toCompletion();
  return NextResponse.json(completion);
}

/** Map runner pre-stream errors to OpenAI-style error responses. */
function mapRunnerError(error: unknown): Response {
  if (error instanceof AgentStreamTransportMismatchError) {
    return NextResponse.json(
      {
        error: {
          message: error.message,
          type: "server_error",
          code: error.code,
        },
      },
      { status: 503 },
    );
  }
  if (error instanceof AgentActionError) {
    return NextResponse.json(
      {
        error: {
          message: error.message,
          type: error.status >= 500 ? "server_error" : "invalid_request_error",
          code: error.code,
        },
      },
      { status: error.status },
    );
  }
  console.error("[openai-compat] runAgentTurn failed:", error);
  return NextResponse.json(
    { error: { message: "Agent turn failed", type: "server_error" } },
    { status: 500 },
  );
}

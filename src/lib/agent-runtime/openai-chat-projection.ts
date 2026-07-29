/**
 * Phase 6 — thin text projection from canonical Agent SSE events to
 * OpenAI-compatible Chat Completion chunks (execution plan §8.8 / design §10).
 *
 * Only three canonical event types map to wire output:
 *   response.output_text.delta → choices[0].delta.content
 *   response.completed         → finish_reason=stop (+ optional usage) + [DONE]
 *   response.failed            → OpenAI-compatible error frame + [DONE]
 *                                (P1/defect 5: NEVER finish_reason=stop)
 *
 * Everything else is filtered out and NEVER crosses the facade:
 *   scimanage.tool_execution.*  (internal tool state)
 *   scimanage.activity.*        (thinking)
 *   scimanage.context_compaction.*
 *   scimanage.memory.suggested
 *   scimanage.view_intent.created
 *   scimanage.proactive_task.suggested
 *   scimanage.usage.updated     (folded into the completed usage chunk)
 *   response.created / response.in_progress / response.output_text.done
 *   error                       (terminal only when followed by response.failed)
 *   internal ids
 *
 * CRITICAL: tool_calls are NEVER emitted. SciManage tools are executed
 * server-side; emitting tool_calls would let Open WebUI re-execute them
 * (double writes / state drift). Design §10.5.
 *
 * P1 (defect 5): a `response.failed` event is projected as an explicit
 * OpenAI-compatible error (streaming: a `data: {"error":{...}}\n\n` frame
 * followed by `[DONE]`, NO `finish_reason=stop`; non-streaming: HTTP 502 +
 * `{error:{message,type,code}}` body). Already-streamed content chunks are
 * NOT rolled back (HTTP streaming semantics); the error frame terminates
 * the stream so the client can distinguish success from failure.
 *
 * Pure module (no I/O, no env). Same approach as the native SSE encoder but
 * producing OpenAI Chat Completion shapes.
 */
import type { AgentStreamEvent, AgentUsage } from "../../../agent-runtime/src/stream-protocol";

/** OpenAI chat completion chunk shape (streaming). */
export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  system_fingerprint?: string;
  choices: Array<{
    index: number;
    delta: {
      role?: "assistant";
      content?: string;
    };
    finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null;
  }>;
  usage?:
    | {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
      }
    | undefined;
}

/** Non-streaming completion shape (aggregated from the same event stream). */
export interface ChatCompletion {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: "assistant"; content: string };
    finish_reason: "stop" | "length" | "tool_calls" | "content_filter";
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/** SSE `data: <json>\n\n` frame string for one chunk. */
export function encodeChunkFrame(chunk: ChatCompletionChunk): string {
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

/** The terminal `data: [DONE]\n\n` frame. */
export const DONE_FRAME = "data: [DONE]\n\n";

/**
 * P1 (defect 5): OpenAI-compatible error envelope shared by streaming error
 * frames and non-streaming error bodies. Mirrors the OpenAI API error shape
 * (`{error:{message,type,code, ...}}`).
 */
export interface OpenAiError {
  message: string;
  type: string;
  code?: string;
  param?: string | null;
}

/**
 * P1 (defect 5): HTTP status returned by the non-streaming facade when the
 * aggregated turn failed. 502 (Bad Gateway) signals an upstream (Agent runtime)
 * failure while keeping the response a valid JSON error body.
 */
export const OPENAI_FACADE_FAILURE_STATUS = 502;

/** Build the OpenAI-compatible error envelope from a response.failed event. */
function toOpenAiError(event: Extract<AgentStreamEvent, { type: "response.failed" }>): OpenAiError {
  const rawMessage =
    event.error && typeof event.error.message === "string" && event.error.message.length > 0
      ? event.error.message
      : "Agent turn failed";
  return {
    message: rawMessage,
    type: "server_error",
    ...(event.error && typeof event.error.code === "string" && event.error.code.length > 0
      ? { code: event.error.code }
      : {}),
  };
}

/** SSE `data: {"error":{...}}\n\n` frame string for the streaming failure path. */
function encodeErrorFrame(error: OpenAiError): string {
  return `data: ${JSON.stringify({ error })}\n\n`;
}

export interface OpenAiProjectionOptions {
  /** chat completion id (e.g. `chatcmpl_<id>`). */
  completionId: string;
  /** Facade model id (e.g. scimanage-agent). */
  modelId: string;
  /** When true (stream_options.include_usage), emit a usage chunk before [DONE]. */
  includeUsage: boolean;
}

/** Map AgentUsage → OpenAI usage object. Missing fields default to 0. */
function toOpenAiUsage(usage: AgentUsage | undefined): {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
} {
  const input = Math.max(0, Math.trunc(usage?.input_tokens ?? 0));
  const output = Math.max(0, Math.trunc(usage?.output_tokens ?? 0));
  const total =
    usage && typeof usage.total_tokens === "number"
      ? Math.max(0, Math.trunc(usage.total_tokens))
      : input + output;
  return { prompt_tokens: input, completion_tokens: output, total_tokens: total };
}

/**
 * Stateful projector: feed it canonical events in order, get back the
 * ChatCompletionChunk frames to write to the SSE response (or accumulate for
 * non-streaming).
 *
 * Returns an empty array for filtered events (no wire output).
 */
export class OpenAiChatProjection {
  private readonly completionId: string;
  private readonly modelId: string;
  private readonly includeUsage: boolean;
  private roleSent = false;
  private aggregatedText = "";
  private lastUsage: AgentUsage | undefined;
  private terminal = false;
  /** P1 (defect 5): captured when response.failed arrives; null otherwise. */
  private failureError: OpenAiError | null = null;

  constructor(opts: OpenAiProjectionOptions) {
    this.completionId = opts.completionId;
    this.modelId = opts.modelId;
    this.includeUsage = opts.includeUsage;
  }

  /** P1 (defect 5): true when the aggregated turn ended in response.failed. */
  get failed(): boolean {
    return this.failureError !== null;
  }

  /** P1 (defect 5): the captured failure envelope (only valid when `failed`). */
  get failure(): OpenAiError | null {
    return this.failureError;
  }

  private baseChunk(): ChatCompletionChunk {
    return {
      id: this.completionId,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: this.modelId,
      choices: [],
    };
  }

  /**
   * Project one canonical event into zero or more SSE frames.
   * Returns an array of frame strings (already `data: ...\n\n` terminated).
   */
  project(event: AgentStreamEvent): string[] {
    if (this.terminal) {
      // Defensive: ignore events after a terminal (completed/failed).
      return [];
    }
    switch (event.type) {
      case "response.output_text.delta": {
        const frames: string[] = [];
        if (!this.roleSent) {
          // First content chunk carries delta.role = "assistant".
          this.roleSent = true;
          const roleChunk = this.baseChunk();
          roleChunk.choices = [
            { index: 0, delta: { role: "assistant" }, finish_reason: null },
          ];
          frames.push(encodeChunkFrame(roleChunk));
        }
        this.aggregatedText += event.delta;
        const chunk = this.baseChunk();
        chunk.choices = [
          { index: 0, delta: { content: event.delta }, finish_reason: null },
        ];
        frames.push(encodeChunkFrame(chunk));
        return frames;
      }
      case "scimanage.usage.updated": {
        // Fold into the eventual completed usage chunk.
        this.lastUsage = event.usage;
        return [];
      }
      case "response.completed": {
        this.terminal = true;
        const frames: string[] = [];
        // If no text was ever streamed, still emit a role chunk so the client
        // sees a valid assistant message envelope.
        if (!this.roleSent) {
          this.roleSent = true;
          const roleChunk = this.baseChunk();
          roleChunk.choices = [
            { index: 0, delta: { role: "assistant" }, finish_reason: null },
          ];
          frames.push(encodeChunkFrame(roleChunk));
        }
        const stopChunk = this.baseChunk();
        stopChunk.choices = [{ index: 0, delta: {}, finish_reason: "stop" }];
        // Prefer response.completed.usage; fall back to last usage.updated.
        const usage = event.usage ?? this.lastUsage;
        if (this.includeUsage && usage) {
          stopChunk.usage = toOpenAiUsage(usage);
        }
        frames.push(encodeChunkFrame(stopChunk));
        frames.push(DONE_FRAME);
        return frames;
      }
      case "response.failed": {
        // P1 (defect 5): project an explicit OpenAI-compatible error. We do NOT
        // emit `finish_reason=stop` (that would mask the failure as success).
        // Already-streamed content chunks are NOT rolled back (HTTP streaming
        // semantics); the error frame terminates the stream so the client can
        // distinguish success from failure. We end with [DONE] so SSE clients
        // that wait for [DONE] do not hang.
        this.terminal = true;
        this.failureError = toOpenAiError(event);
        return [encodeErrorFrame(this.failureError), DONE_FRAME];
      }
      default:
        // Filtered out: activity / tool_execution / compaction / memory /
        // view_intent / proactive / created / in_progress / output_text.done /
        // error. None of these cross the facade.
        return [];
    }
  }

  /** Aggregate the streamed text + usage into a non-streaming completion. */
  toCompletion(): ChatCompletion {
    const usage = this.lastUsage;
    return {
      id: this.completionId,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: this.modelId,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: this.aggregatedText },
          finish_reason: this.terminal ? "stop" : "stop",
        },
      ],
      ...(usage ? { usage: toOpenAiUsage(usage) } : {}),
    };
  }
}

/**
 * Pure helper: does a canonical event type ever produce facade wire output?
 * Used by tests to assert the filter is exhaustive. Internal scimanage.* events
 * must NEVER be projected.
 */
export function isProjectedEventType(type: AgentStreamEvent["type"]): boolean {
  return (
    type === "response.output_text.delta" ||
    type === "response.completed" ||
    type === "response.failed"
  );
}

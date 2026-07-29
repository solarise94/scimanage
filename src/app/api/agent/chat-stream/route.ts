/**
 * Phase 3/5 slimmed native route (design §8 / plan §5.7).
 *
 * The route is now a thin shell. All Agent-turn business logic lives in
 * `runAgentTurn()` (src/lib/agent-runtime/agent-turn-runner.ts). This file only:
 *  - NextAuth → BusinessActor (+ RUNTIME_NOT_PI 409 classification)
 *  - parse the native request body
 *  - call runAgentTurn()
 *  - frame the canonical events as SSE (Phase 5: SSE is the only transport)
 *  - set response headers (session/run/response id + protocol headers)
 *  - map typed errors to JSON HTTP responses
 *
 * The route MUST NOT: duplicate the projector, execute CRM follow-up itself,
 * server-side fetch `/api/**`, or touch Prisma directly (design §5.7).
 */
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requireBusinessActorFromSession } from "@/lib/agent-actions/actor";
import { AgentActionError, AgentActionInputError } from "@/lib/agent-actions/errors";
import { requireAgentAccess } from "@/lib/agent-actions/require-agent-access";
import { isPiAgentRuntimeEnabled } from "@/lib/agent-runtime/config";
import {
  AGENT_STREAM_PROTOCOL,
  encodeSseEvent,
  type AgentStreamEvent,
} from "../../../../../agent-runtime/src/stream-protocol";
import {
  AgentStreamTransportMismatchError,
  getAppBuildVersion,
  runAgentTurn,
  type AgentMessageContextEnvelope,
} from "@/lib/agent-runtime/agent-turn-runner";

export const dynamic = "force-dynamic";

/** Frame one canonical event for the browser as an SSE frame. */
function frameEvent(event: AgentStreamEvent): Uint8Array {
  return new TextEncoder().encode(encodeSseEvent(event));
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const denied = requireAgentAccess(session);
  if (denied) return denied;
  // RUNTIME_NOT_PI 409 classification (kept at the route so the legacy fallback
  // boundary and tests stay anchored here; design §8 / plan §0.4).
  if (!isPiAgentRuntimeEnabled()) {
    return NextResponse.json(
      { error: "AGENT_RUNTIME is not set to pi", code: "RUNTIME_NOT_PI" },
      { status: 409 },
    );
  }

  let turn: Awaited<ReturnType<typeof runAgentTurn>>;
  try {
    const body = await req.json();
    if (!body || typeof body !== "object") {
      throw new AgentActionInputError("Request body must be an object");
    }
    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!message) {
      throw new AgentActionInputError("message is required");
    }

    const inputModeRaw = typeof body.inputMode === "string" ? body.inputMode : null;
    const inputMode =
      inputModeRaw === "voice" || inputModeRaw === "text" ? inputModeRaw : undefined;

    const messageContext =
      body.messageContext &&
      typeof body.messageContext === "object" &&
      !Array.isArray(body.messageContext)
        ? (body.messageContext as AgentMessageContextEnvelope)
        : undefined;

    const actor = requireBusinessActorFromSession(session);

    turn = await runAgentTurn({
      actor,
      session,
      message,
      sessionId: typeof body.sessionId === "string" ? body.sessionId.trim() : undefined,
      agentRunId: typeof body.agentRunId === "string" ? body.agentRunId.trim() : undefined,
      inputMode,
      messageContext,
      signal: req.signal,
    });
  } catch (error) {
    // Pre-stream typed errors → JSON HTTP responses (design §5.7).
    if (error instanceof AgentStreamTransportMismatchError) {
      return NextResponse.json(
        { error: error.message, code: error.code, details: error.details },
        { status: 503 },
      );
    }
    if (error instanceof AgentActionError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status },
      );
    }
    console.error("agent chat stream failed:", error);
    return NextResponse.json({ error: "Agent chat stream failed" }, { status: 500 });
  }

  const appBuildVersion = getAppBuildVersion();

  // Stream the canonical events as SSE frames. The ReadableStream pulls from the
  // runner's async generator so events flush as they are produced.
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const event of turn.events) {
          controller.enqueue(frameEvent(event));
        }
      } catch (error) {
        // The runner is responsible for surfacing post-stream failures as
        // canonical error/response.failed events; if the generator itself
        // throws, emit a best-effort terminal so the browser doesn't hang.
        console.error("agent chat stream encoding failed:", error);
        const message = error instanceof Error ? error.message : "Agent chat stream failed";
        const errEvent = {
          type: "error" as const,
          protocol: AGENT_STREAM_PROTOCOL,
          response_id: turn.responseId,
          sequence_number: Date.now(),
          error: { message },
        } as AgentStreamEvent;
        controller.enqueue(frameEvent(errEvent));
      } finally {
        controller.close();
      }
    },
    cancel(reason) {
      // Browser abort → propagates to the runner via req.signal (design §12.1).
      console.warn("[chat-stream] client disconnected:", reason);
    },
  });

  const headers: Record<string, string> = {
    "Cache-Control": "no-cache, no-transform",
    "Content-Type": "text/event-stream; charset=utf-8",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
    "X-Agent-Stream-Protocol": AGENT_STREAM_PROTOCOL,
    "X-Agent-App-Build-Version": appBuildVersion,
    "x-agent-session-id": turn.sessionId,
    "x-agent-run-id": turn.agentRunId,
    "x-agent-response-id": turn.responseId,
  };

  // Reuse the encoder variable so the import is exercised even if start() runs
  // synchronously empty (keeps tree-shaking honest).
  void encoder;

  return new Response(stream, { headers });
}

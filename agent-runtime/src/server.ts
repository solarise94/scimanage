import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { getRuntimeConfig } from "./config.js";
import { compactConversation, streamChat } from "./pi-runtime.js";
import type { RuntimeChatStreamRequest, RuntimeCompactRequest } from "./types.js";
import {
  AGENT_STREAM_PROTOCOL,
  encodeSseEvent,
  type AgentStreamEvent,
} from "./stream-protocol.js";

export type { AgentStreamEvent };

function sendJson(res: ServerResponse, status: number, payload: unknown) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * Phase 5: SSE is the only stream transport (plan §7).
 *
 * These headers are validated by Next.js BEFORE reading any runtime body byte:
 * Content-Type, X-Agent-Stream-Protocol, X-Agent-Runtime-Build-Version.
 * A mismatch → Next returns 503 STREAM_TRANSPORT_MISMATCH without forwarding.
 */
function streamHeaders(appBuildVersion: string) {
  return {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-agent-stream-protocol": AGENT_STREAM_PROTOCOL,
    "x-agent-runtime-build-version": appBuildVersion,
  } as const;
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf-8").trim();
  if (!raw) {
    throw new Error("Request body is required");
  }
  return JSON.parse(raw) as T;
}

function isAuthorized(req: IncomingMessage, token: string) {
  return req.headers["x-agent-runtime-token"] === token;
}

const config = getRuntimeConfig();
const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      // Phase 5: /health exposes service + protocol + build version so Next.js
      // readiness checks and deploy smoke can verify release consistency
      // (design §6.1 / plan §4.3). SSE is the only transport.
      return sendJson(res, 200, {
        ok: true,
        service: "scimanage-agent-runtime",
        protocol: AGENT_STREAM_PROTOCOL,
        transport: "sse",
        buildVersion: config.appBuildVersion,
      });
    }

    if (!isAuthorized(req, config.token)) {
      return sendJson(res, 401, { error: "Unauthorized" });
    }

    if (req.method === "POST" && req.url === "/chat-stream") {
      const payload = await readJson<RuntimeChatStreamRequest>(req);
      res.writeHead(200, streamHeaders(config.appBuildVersion));

      // Client disconnect → abort the Pi turn (design §6.1 / §12.1). We detect
      // a premature close (socket gone before the response finished writing)
      // via res 'close' + writableFinished check, and abort a controller that
      // is forwarded into streamChat → agent.abort() so the pending model fetch
      // is cancelled and the agent loop stops (defect 2).
      const abortController = new AbortController();
      const onClose = () => {
        if (!res.writableFinished) {
          try {
            abortController.abort();
          } catch {
            // ignore — already aborted
          }
        }
      };
      res.on("close", onClose);

      try {
        await streamChat(
          payload,
          (event) => {
            if (!res.writableEnded) {
              res.write(encodeSseEvent(event));
            }
          },
          abortController.signal,
        );
      } catch (error) {
        // Headers already sent: surface the error as a canonical `error` event
        // frame (design §5.7 open-stream error path), then close.
        const message = error instanceof Error ? error.message : "Unknown runtime error";
        if (!res.writableEnded) {
          // Minimal canonical error frame stamped with a fresh response_id-less
          // envelope is not allowed; instead emit via the same factory path by
          // constructing a wire error frame directly. The pi-runtime factory is
          // the authoritative sequencer, so post-factory errors here are rare
          // (network/IO). We send a best-effort error frame and close.
          const errorEvent = {
            type: "error" as const,
            protocol: AGENT_STREAM_PROTOCOL,
            response_id: `resp_error_${Date.now().toString(36)}`,
            sequence_number: 0,
            error: { message },
          };
          res.write(encodeSseEvent(errorEvent));
        }
      } finally {
        res.off("close", onClose);
        if (!res.writableEnded) {
          res.end();
        }
      }
      return;
    }

    if (req.method === "POST" && req.url === "/chat-compact") {
      const payload = await readJson<RuntimeCompactRequest>(req);
      return sendJson(res, 200, { ok: true, ...await compactConversation(payload) });
    }

    return sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown runtime error";
    if (!res.headersSent) {
      return sendJson(res, 500, { error: message });
    }
    res.end(JSON.stringify({ type: "error", error: message }));
  }
});

server.listen(config.port, config.host, () => {
  console.log(
    `scimanage-agent-runtime listening on http://${config.host}:${config.port} ` +
    `(transport=sse, build=${config.appBuildVersion})`,
  );
});

/**
 * Phase 6 — OpenAI-compatible `GET /v1/models` (execution plan §8.5 / design §10.2).
 *
 * Returns exactly the facade model id configured via env
 * (AGENT_OPENAI_COMPAT_MODEL_ID, default `scimanage-agent`). The underlying
 * MiniMax model name is never exposed.
 *
 * Auth: same gate as /v1/chat/completions.
 *  - disabled (or misconfigured) → 404 (fail-closed).
 *  - missing/invalid Bearer key → 401.
 */
import { NextResponse } from "next/server";
import { authenticateOpenAiCompatRequest } from "@/lib/agent-runtime/openai-compat-auth";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const auth = await authenticateOpenAiCompatRequest(req.headers.get("authorization"));
  if (!auth.ok) {
    return NextResponse.json(
      { error: { message: auth.error, type: "invalid_request_error", code: auth.code } },
      { status: auth.status },
    );
  }
  const { modelId } = auth.config;
  return NextResponse.json({
    object: "list",
    data: [
      {
        id: modelId,
        object: "model",
        created: 0,
        owned_by: "scimanage",
      },
    ],
  });
}

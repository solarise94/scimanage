import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requireAgentAccess } from "@/lib/agent-actions/require-agent-access";
import { requireBusinessActorFromSession } from "@/lib/agent-actions/actor";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "@/lib/application/errors";
import { AgentActionError, AgentActionInputError } from "@/lib/agent-actions/errors";
import {
  issueConfirmationEvent,
  IDEMPOTENCY_KEY_MAX_LEN,
  IDEMPOTENCY_KEY_MIN_LEN,
  TARGET_INTENT_MAX_LEN,
} from "@/lib/application/agent-confirmation-events";

/**
 * P1-3 allowProposal 可信前端事件颁发入口。
 *
 * 仅由已登录浏览器 UI 调用（GenUI 卡片在用户点击「确认生成/确认提交」类按钮时 mint 事件）。
 * 颁发的事件由模型驱动的 proposal 创建路径（channel="agent"）在同事务内一次性消费。
 * web channel（GenUI 点击本身就是可信用户动作）不消费事件。
 *
 * 鉴权顺序（与既有 agent route 一致）：
 *  1. NextAuth session → 401；
 *  2. requireAgentAccess（agent feature gate）→ 403；
 *  3. requireBusinessActorFromSession → 业务 actor；
 *  4. body 校验 → 400；
 *  5. issueConfirmationEvent（service 内校验 AgentRun 归属 / 幂等）。
 */
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const denied = requireAgentAccess(session);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON", code: "INVALID_INPUT" },
      { status: 400 },
    );
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json(
      { error: "Request body must be an object", code: "INVALID_INPUT" },
      { status: 400 },
    );
  }
  const obj = body as Record<string, unknown>;

  // 手写校验（与 service 内边界一致）：agentRunId / targetIntent / idempotencyKey。
  // 缺字段或非法长度 → 400 INVALID_INPUT。
  const agentRunIdRaw = obj.agentRunId;
  const targetIntentRaw = obj.targetIntent;
  const idempotencyKeyRaw = obj.idempotencyKey;

  if (typeof agentRunIdRaw !== "string" || !agentRunIdRaw.trim()) {
    return NextResponse.json(
      { error: "agentRunId is required", code: "INVALID_INPUT" },
      { status: 400 },
    );
  }
  if (typeof targetIntentRaw !== "string" || !targetIntentRaw.trim()) {
    return NextResponse.json(
      { error: "targetIntent is required", code: "INVALID_INPUT" },
      { status: 400 },
    );
  }
  if (typeof idempotencyKeyRaw !== "string") {
    return NextResponse.json(
      { error: "idempotencyKey is required", code: "INVALID_INPUT" },
      { status: 400 },
    );
  }
  const agentRunId = agentRunIdRaw.trim();
  const targetIntent = targetIntentRaw.trim();
  const idempotencyKey = idempotencyKeyRaw.trim();

  if (targetIntent.length > TARGET_INTENT_MAX_LEN) {
    return NextResponse.json(
      {
        error: `targetIntent must be 1..${TARGET_INTENT_MAX_LEN} chars`,
        code: "INVALID_INPUT",
      },
      { status: 400 },
    );
  }
  if (
    idempotencyKey.length < IDEMPOTENCY_KEY_MIN_LEN ||
    idempotencyKey.length > IDEMPOTENCY_KEY_MAX_LEN
  ) {
    return NextResponse.json(
      {
        error: `idempotencyKey must be ${IDEMPOTENCY_KEY_MIN_LEN}..${IDEMPOTENCY_KEY_MAX_LEN} chars`,
        code: "INVALID_INPUT",
      },
      { status: 400 },
    );
  }

  try {
    const actor = requireBusinessActorFromSession(session);
    const event = await issueConfirmationEvent({
      actor,
      agentRunId,
      targetIntent,
      idempotencyKey,
    });
    // 幂等命中既有未消费事件（idempotencyKey 已存在，created=false）→ 200；首次创建（created=true）→ 201。
    // issueConfirmationEvent 在事件已消费时抛 409，不会走到这里。
    const status = event.created ? 201 : 200;
    return NextResponse.json(
      {
        ok: true,
        event: {
          id: event.id,
          targetIntent: event.targetIntent,
          createdAt: event.createdAt.toISOString(),
        },
      },
      { status },
    );
  } catch (err) {
    return mapErrorToHttp(err);
  }
}

function mapErrorToHttp(err: unknown): NextResponse {
  if (err instanceof ValidationError) {
    return NextResponse.json(
      { error: err.message, code: "INVALID_INPUT" },
      { status: 400 },
    );
  }
  if (err instanceof ConflictError) {
    return NextResponse.json(
      { error: err.message, code: "ALREADY_CONSUMED" },
      { status: 409 },
    );
  }
  if (err instanceof ForbiddenError) {
    return NextResponse.json({ error: err.message }, { status: 403 });
  }
  if (err instanceof NotFoundError) {
    // AgentRun 不存在或越权合并 → 404（防存在性泄露）。
    return NextResponse.json({ error: err.message }, { status: 404 });
  }
  if (err instanceof AgentActionInputError) {
    return NextResponse.json(
      { error: err.message, code: err.code },
      { status: 400 },
    );
  }
  if (err instanceof AgentActionError) {
    return NextResponse.json(
      { error: err.message, code: err.code },
      { status: err.status },
    );
  }
  console.error("[confirmation-events] issue failed:", err);
  return NextResponse.json(
    { error: "Failed to issue confirmation event" },
    { status: 500 },
  );
}

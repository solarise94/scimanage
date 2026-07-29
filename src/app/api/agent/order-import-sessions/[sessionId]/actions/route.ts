/**
 * Phase D / P0-2：GenUI order-import-session actions route（不是模型工具）。
 *
 * POST /api/agent/order-import-sessions/[sessionId]/actions
 *   body: {
 *     action: "commit_row" | "skip_row" | "apply_column_mapping",
 *     expectedVersion?: number,         // commit_row / skip_row 必填（行级乐观锁）
 *     rowId?: string,                   // commit_row / skip_row 必填
 *     selectedOptionId?: string,        // commit_row 时选中的候选 profileId（USE_SUGGESTION/PICK_EXISTING）
 *     columnMapping?: Record<string,string>, // apply_column_mapping 必填（source→target）
 *     reason?: string,                  // skip_row 可选原因（缺省用「用户经 GenUI 跳过」）
 *     decision?: { type: "USE_SUGGESTION" | "PICK_EXISTING" | "CREATE_NEW"; profileId?: string },
 *   }
 *
 * 校验顺序（每步 fail-closed）：
 *  1. NextAuth session → 未登录 401；
 *  2. requireAgentAccess → 403 if agent 关闭；
 *  3. requireBusinessActorFromSession → 403 if 非 business actor；
 *  4. validateImportSessionUserActionForActor（canonical service，可访问 Prisma）：
 *     - session 归属（不存在/越权合并 404）；
 *     - action ∈ 白名单（非法 400）；
 *     - rowId 属于 session（否则 404）；
 *     - expectedVersion 一致（否则 409 VERSION_CONFLICT）。
 *  5. 按 action 路由：
 *     - commit_row / skip_row（riskLevel:confirm）→ createAgentProposal 产 PENDING proposal，
 *       返回 proposal 句柄供前端 /api/agent/proposals/[id]/confirm 确认；
 *     - apply_column_mapping（riskLevel:safe）→ 经 runAgentToolForActor 直接执行，
 *       需从 session 反查 stagingFileId/version（public input 禁带 verified-context）。
 *
 * 不是模型工具：route 不直连 Prisma，所有持久化经 canonical service / internal action。
 * 越权/不存在合并 404（防存在性泄露，与 canonical service 现状一致）。
 */
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requireBusinessActorFromSession } from "@/lib/agent-actions/actor";
import { requireAgentAccess } from "@/lib/agent-actions/require-agent-access";
import { buildAgentExecutionContext, buildInvocationContext } from "@/lib/application/actor";
import { AgentActionError, AgentActionInputError } from "@/lib/agent-actions/errors";
import { createAgentProposal } from "@/lib/agent-actions/proposals";
import { runAgentToolForActor } from "@/lib/agent-actions/execute-tool-for-run";
import {
  resolveImportSessionStagingContextForActor,
  validateImportSessionUserActionForActor,
} from "@/lib/orders/application/import-session";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "@/lib/application/errors";

type ImportActionBody = {
  action?: string;
  expectedVersion?: number | null;
  rowId?: string | null;
  selectedOptionId?: string | null;
  columnMapping?: Record<string, string> | null;
  reason?: string | null;
  decision?: { type?: string; profileId?: string | null } | null;
};

function mapDomainErrorToHttp(err: unknown): NextResponse {
  if (err instanceof ValidationError) {
    if (err.message.includes("版本不一致") || err.message.includes("VERSION_CONFLICT")) {
      return NextResponse.json({ error: err.message, code: "VERSION_CONFLICT" }, { status: 409 });
    }
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
  if (err instanceof ConflictError) {
    const code = (err as ConflictError & { code?: string }).code;
    return NextResponse.json(
      { error: err.message, code: code ?? "STATE_CONFLICT" },
      { status: 409 },
    );
  }
  if (err instanceof ForbiddenError) {
    return NextResponse.json({ error: err.message }, { status: 403 });
  }
  if (err instanceof NotFoundError) {
    return NextResponse.json({ error: err.message }, { status: 404 });
  }
  if (err instanceof AgentActionError) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
  }
  console.error("order-import-session action failed:", err);
  return NextResponse.json({ error: "Failed to perform import action" }, { status: 500 });
}

function readBody(raw: unknown): ImportActionBody {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AgentActionInputError("Request body must be an object");
  }
  const body = raw as Record<string, unknown>;
  const out: ImportActionBody = {};
  if (typeof body.action === "string") out.action = body.action;
  if (typeof body.expectedVersion === "number") out.expectedVersion = body.expectedVersion;
  if (typeof body.rowId === "string") out.rowId = body.rowId;
  if (typeof body.selectedOptionId === "string") out.selectedOptionId = body.selectedOptionId;
  if (typeof body.reason === "string") out.reason = body.reason;
  if (body.columnMapping && typeof body.columnMapping === "object" && !Array.isArray(body.columnMapping)) {
    const mapping: Record<string, string> = {};
    for (const [k, v] of Object.entries(body.columnMapping as Record<string, unknown>)) {
      if (typeof k === "string" && typeof v === "string") mapping[k] = v;
    }
    out.columnMapping = mapping;
  }
  if (body.decision && typeof body.decision === "object" && !Array.isArray(body.decision)) {
    const d = body.decision as Record<string, unknown>;
    out.decision = {
      type: typeof d.type === "string" ? d.type : undefined,
      profileId: typeof d.profileId === "string" ? d.profileId : null,
    };
  }
  return out;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  // 1. NextAuth session
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // 2. requireAgentAccess（agent feature gate）
  const denied = requireAgentAccess(session);
  if (denied) return denied;

  try {
    const { sessionId } = await params;
    if (!sessionId) {
      return NextResponse.json({ error: "sessionId is required" }, { status: 400 });
    }

    // 3. requireBusinessActorFromSession
    const actor = requireBusinessActorFromSession(session);

    // 解析 body
    const raw = await req.json().catch(() => null);
    const body = readBody(raw);
    if (!body.action) {
      return NextResponse.json({ error: "action is required" }, { status: 400 });
    }

    // 4. canonical service 校验（owner / action 白名单 / rowId / version）
    const validated = await validateImportSessionUserActionForActor(actor, sessionId, {
      action: body.action,
      rowId: body.rowId,
      expectedVersion: body.expectedVersion,
      selectedOptionId: body.selectedOptionId,
    });

    const ctx = buildAgentExecutionContext(actor, buildInvocationContext({ channel: "web" }));

    // 5. 按 action 路由
    if (validated.action === "apply_column_mapping") {
      // safe action：直接执行（经 runAgentToolForActor）。
      if (!body.columnMapping || Object.keys(body.columnMapping).length === 0) {
        return NextResponse.json(
          { error: "apply_column_mapping 需要 columnMapping（source→target）" },
          { status: 400 },
        );
      }
      const staging = await resolveImportSessionStagingContextForActor(actor, sessionId);
      const outcome = await runAgentToolForActor(ctx, "orders.apply_import_column_mapping", {
        stagingFileId: staging.stagingFileId,
        expectedVersion: staging.version,
        columnMapping: body.columnMapping,
      });
      return NextResponse.json({
        ok: true,
        mode: "result",
        action: "apply_column_mapping",
        result: outcome.result,
      });
    }

    // commit_row / skip_row → confirm proposal
    const validatedRowId = validated.rowId;
    const validatedVersion = validated.rowVersion;
    if (!validatedRowId || validatedVersion == null) {
      // validateImportSessionUserActionForActor 已保证这两个字段，这里是类型收窄。
      return NextResponse.json({ error: "内部错误：行上下文缺失" }, { status: 500 });
    }

    if (validated.action === "commit_row") {
      // 决策类型选择：
      //  - 前端显式 decision.type（PICK_EXISTING/CREATE_NEW）→ 用之；
      //  - selectedOptionId 提供 → PICK_EXISTING；
      //  - 否则按行候选集自动选：有候选 → USE_SUGGESTION（第一个候选）；无候选 → CREATE_NEW。
      const explicitType = body.decision?.type;
      const providedProfileId =
        body.selectedOptionId
        ?? (body.decision?.profileId && body.decision.profileId.length > 0 ? body.decision.profileId : undefined);

      let decisionType: "USE_SUGGESTION" | "PICK_EXISTING" | "CREATE_NEW";
      if (explicitType === "PICK_EXISTING" || explicitType === "CREATE_NEW") {
        decisionType = explicitType;
      } else if (providedProfileId) {
        decisionType = "PICK_EXISTING";
      } else {
        // 自动选：经 get_import_row 读候选集（runAgentToolForActor 走 owner gate）。
        const getOutcome = await runAgentToolForActor(ctx, "orders.get_import_row", {
          sessionId,
          rowId: validatedRowId,
        });
        const getResult = (getOutcome.result ?? {}) as {
          candidates?: Array<{ profileId?: string }>;
        };
        const firstCandidate = getResult.candidates?.[0]?.profileId;
        decisionType = firstCandidate ? "USE_SUGGESTION" : "CREATE_NEW";
      }

      const profileId = providedProfileId;
      // USE_SUGGESTION / PICK_EXISTING 必须有 profileId；若缺则 fallback 到 CREATE_NEW。
      if ((decisionType === "USE_SUGGESTION" || decisionType === "PICK_EXISTING") && !profileId) {
        decisionType = "CREATE_NEW";
      }

      const proposalInput = {
        sessionId,
        rowId: validatedRowId,
        expectedRowVersion: validatedVersion,
        decision: {
          type: decisionType,
          ...(profileId && (decisionType === "USE_SUGGESTION" || decisionType === "PICK_EXISTING")
            ? { profileId }
            : {}),
        },
      };
      const proposal = await createAgentProposal(ctx, "orders.import_order_row", proposalInput);
      return NextResponse.json(
        {
          ok: true,
          mode: "proposal",
          action: "commit_row",
          proposal,
          confirmUrl: `/api/agent/proposals/${proposal.id}/confirm`,
          rejectUrl: `/api/agent/proposals/${proposal.id}/reject`,
        },
        { status: 202 },
      );
    }

    // skip_row
    const reason = body.reason && body.reason.trim().length > 0 ? body.reason.trim() : "用户经 GenUI 跳过";
    const proposal = await createAgentProposal(ctx, "orders.skip_import_row", {
      sessionId,
      rowId: validatedRowId,
      expectedVersion: validatedVersion,
      reason,
    });
    return NextResponse.json(
      {
        ok: true,
        mode: "proposal",
        action: "skip_row",
        proposal,
        confirmUrl: `/api/agent/proposals/${proposal.id}/confirm`,
        rejectUrl: `/api/agent/proposals/${proposal.id}/reject`,
      },
      { status: 202 },
    );
  } catch (err) {
    return mapDomainErrorToHttp(err);
  }
}

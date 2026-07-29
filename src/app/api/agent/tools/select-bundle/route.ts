/**
 * Phase A: bundle selector endpoint（修正 4 双身份）。
 *
 * POST /api/agent/tools/select-bundle
 *
 * 双身份：
 *  - agent-runtime：`x-agent-internal-token` + agentRunId（服务端从 AgentRun 恢复权威 actor）。
 *  - 浏览器/GenUI：NextAuth session。
 *
 * 服务端权威：绝不信任 request body 的 userId/role/selectedRefs。run 状态（active workspace、
 * 已选 ref、上一结果、hopCount）从 AgentRun + 最近 tool 结果恢复；当前 Phase A 只接受请求体
 * 传来的"运行时 selector 提示"（lastToolResult/selectedRefs/activeWorkspaces/pageDomain/hopCount），
 * 但 actor 身份一律服务端解析。
 *
 * 返回 { tools, manifestVersion, bundleId, reason }，tools ≤ 15。
 */
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requireBusinessActorFromSession } from "@/lib/agent-actions/actor";
import {
  ensureAgentRunBelongsToSession,
  getExecutionContextFromAgentRun,
  isValidInternalToolToken,
} from "@/lib/agent-actions/run-context";
import { requireAgentAccess } from "@/lib/agent-actions/require-agent-access";
import { AgentActionError } from "@/lib/agent-actions/errors";
import {
  selectToolBundle,
  type ActiveWorkspace,
  type BundleSelectionInput,
  type LastToolResult,
  type SelectedEntity,
} from "@/lib/agent-actions/public/bundle-selector";

const VALID_ENTITY_TYPES = new Set<SelectedEntity>([
  "customer",
  "order",
  "project",
  "ticket",
  "contract",
  "invoice",
]);
const VALID_OPTION_TYPES = new Set<string>([
  "customer",
  "order",
  "project",
  "ticket",
  "contract",
  "invoice",
]);
const VALID_PAGE_DOMAINS = new Set<string>([
  "customer",
  "order",
  "project",
  "ticket",
  "contract",
  "invoice",
  "finance",
  "crm",
]);

function parseStringSet(values: unknown, label: string): SelectedEntity[] {
  if (!Array.isArray(values)) return [];
  const out: SelectedEntity[] = [];
  for (const v of values) {
    if (typeof v === "string" && VALID_ENTITY_TYPES.has(v as SelectedEntity)) {
      out.push(v as SelectedEntity);
    }
  }
  if (values != null && out.length !== (values as unknown[]).length) {
    throw new AgentActionError(`Invalid ${label} entry`, 400, "INVALID_SELECTOR_HINT");
  }
  return out;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      throw new AgentActionError("Request body must be an object", 400, "INVALID_BODY");
    }

    const agentRunId = typeof body.agentRunId === "string" ? body.agentRunId.trim() : "";
    const internalToken = req.headers.get("x-agent-internal-token");

    // ── 双身份解析 actor（绝不信任 body 的 userId/role） ──
    let actorUserId: string;
    let actorRole: string;
    let resolvedRunId: string | null = null;
    if (internalToken && isValidInternalToolToken(internalToken)) {
      if (!agentRunId) {
        throw new AgentActionError("agentRunId is required for internal bundle selection", 400, "MISSING_AGENT_RUN_ID");
      }
      const ctx = await getExecutionContextFromAgentRun(agentRunId);
      actorUserId = ctx.actor.userId;
      actorRole = ctx.actor.role;
      resolvedRunId = ctx.invocation.agentRunId ?? agentRunId;
    } else {
      const session = await getServerSession(authOptions);
      if (!session) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
      const denied = requireAgentAccess(session);
      if (denied) return denied;
      const actor = requireBusinessActorFromSession(session);
      actorUserId = actor.userId;
      actorRole = actor.role;
      if (agentRunId) {
        await ensureAgentRunBelongsToSession(agentRunId, session);
        const ctx = await getExecutionContextFromAgentRun(agentRunId);
        actorUserId = ctx.actor.userId;
        actorRole = ctx.actor.role;
        resolvedRunId = ctx.invocation.agentRunId ?? agentRunId;
      }
    }

    // ── selector hints（运行时提示，非身份） ──
    const aw = body.activeWorkspaces as Record<string, unknown> | undefined;
    const activeWorkspaces: ActiveWorkspace | undefined = aw
      ? {
          importSessionRef: typeof aw.importSessionRef === "string" ? aw.importSessionRef : undefined,
          bankFlowRef: typeof aw.bankFlowRef === "string" ? aw.bankFlowRef : undefined,
        }
      : undefined;

    const lt = body.lastToolResult as Record<string, unknown> | undefined;
    let lastToolResult: LastToolResult | undefined;
    if (lt && typeof lt === "object") {
      const kind = lt.kind;
      const optionType = lt.optionType;
      if (
        kind != null &&
        kind !== "needs_selection" &&
        kind !== "needs_user_input" &&
        kind !== "result" &&
        kind !== "proposal"
      ) {
        throw new AgentActionError(`Invalid lastToolResult.kind: ${kind}`, 400, "INVALID_SELECTOR_HINT");
      }
      if (optionType != null && !VALID_OPTION_TYPES.has(String(optionType))) {
        throw new AgentActionError(`Invalid lastToolResult.optionType: ${optionType}`, 400, "INVALID_SELECTOR_HINT");
      }
      lastToolResult = {
        kind: kind as LastToolResult["kind"],
        optionType: optionType as LastToolResult["optionType"],
      };
    }

    let pageDomain: BundleSelectionInput["pageDomain"];
    if (body.pageDomain != null) {
      const pd = String(body.pageDomain);
      if (!VALID_PAGE_DOMAINS.has(pd)) {
        throw new AgentActionError(`Invalid pageDomain: ${pd}`, 400, "INVALID_SELECTOR_HINT");
      }
      pageDomain = pd as BundleSelectionInput["pageDomain"];
    }

    const hopCountRaw = body.hopCount;
    const hopCount = typeof hopCountRaw === "number" && Number.isFinite(hopCountRaw) && hopCountRaw >= 0
      ? Math.floor(hopCountRaw)
      : 0;

    const selectionInput: BundleSelectionInput = {
      actor: { userId: actorUserId, role: actorRole },
      runId: resolvedRunId,
      activeWorkspaces,
      selectedRefs: parseStringSet(body.selectedRefs, "selectedRefs"),
      lastToolResult,
      pageDomain,
      hopCount,
    };

    const result = selectToolBundle(selectionInput);

    return NextResponse.json({
      ok: true,
      tools: result.tools,
      manifestVersion: result.manifestVersion,
      reason: result.reason,
      bundleId: `${result.reason}#${Date.now()}`,
    });
  } catch (error) {
    if (error instanceof AgentActionError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    console.error("select-bundle failed:", error);
    return NextResponse.json({ error: "Failed to select tool bundle" }, { status: 500 });
  }
}

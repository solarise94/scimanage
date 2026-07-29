import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { MinimaxChatProvider } from "@/lib/draft/providers/minimax-chat";
import { isMinimaxConfigured } from "@/lib/minimax";
import { AgentActionError, AgentActionInputError } from "@/lib/agent-actions/errors";
import { executeAgentAction, getAgentAction, listAvailableAgentActions } from "@/lib/agent-actions/registry";
import { buildModelFacingToolTextForAction } from "@/lib/agent-actions/format-tool-result-for-model";
import { getOrCreateAgentRunFromSession, getExecutionContextFromAgentRun } from "@/lib/agent-actions/run-context";
import type { AgentExecutionContext } from "@/lib/application/actor";
import { executeAgentToolForRun } from "@/lib/agent-actions/execute-tool-for-run";
import { listHotCustomersForActor } from "@/lib/crm/hot-customers";
import { shouldFollowCrmCustomerContext, extractCrmFollowUpProfileId } from "@/lib/agent-runtime/crm-follow-up";
import { listHotProjectsForActor } from "@/lib/agent-runtime/hot-projects";
import { listActiveEntityMemoriesForActor } from "@/lib/agent-runtime/entity-memory-access";
import { validateCustomerTarget } from "@/lib/crm/customer-target-validator";
import { requireAgentAccess } from "@/lib/agent-actions/require-agent-access";
import { buildCardToolNarration } from "@/lib/agent-actions/tool-adapter";
import {
  assertAndBindStagingToAgentRun,
  validateVerifiedInvoiceStagingContextList,
  type VerifiedInvoiceStagingContext,
} from "@/lib/finance/invoice-staging";
// C4: 多文件发票分析由后台 Job 驱动，浏览器关闭/chat abort 后仍可继续 safe OCR。
// 这里只创建调度信封（幂等），worker 负责 analyze；本路由的 continuation 仅作 UI 唤醒。
import { createInvoiceIngestJob } from "@/lib/finance/invoice-ingest-job";
import {
  assertAndBindImportStagingToAgentRun,
  validateVerifiedImportStagingContext,
  IMPORT_KIND,
  type VerifiedImportStagingContext,
} from "@/lib/import-staging";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface PlannedToolCall {
  actionKey: string;
  input: Record<string, unknown>;
  reason?: string;
}

/**
 * Follow-up execution outcome. Mirrors the tool run outcome plus a
 * `validation_error` mode used when `validateCustomerTarget` rejects the
 * CRM follow-up target (scope/existence gate, docs §9.2). The caller records
 * one error tool item and does not surface it as an exception.
 */
interface FollowUpToolResponse {
  mode: "result" | "proposal" | "validation_error";
  result?: unknown;
  proposal?: unknown;
  /** Used only for `validation_error`: human-readable reason from the validator. */
  validationError?: string;
  /** profileId that failed validation, so the caller can record it on the tool item. */
  profileId?: string;
}

async function normalizePlannedToolCall(
  ctx: AgentExecutionContext,
  toolCall: PlannedToolCall,
): Promise<PlannedToolCall> {
  if (toolCall.actionKey === "orders.get_finance_snapshot") {
    const rawOrderId = typeof toolCall.input.orderId === "string" ? toolCall.input.orderId.trim() : "";
    if (!rawOrderId) return toolCall;

    const search = await executeAgentAction(ctx, "orders.search", {
      query: rawOrderId,
      limit: 5,
    });
    const items = (search.result as { items?: Array<{ id: string; orderNo?: string | null; externalOrderNo?: string | null }> }).items ?? [];
    const exactMatches = items.filter((item) => item.id === rawOrderId || item.orderNo === rawOrderId || item.externalOrderNo === rawOrderId);
    if (exactMatches.length === 1) {
      return {
        ...toolCall,
        input: { orderId: exactMatches[0].id },
        reason: `${toolCall.reason || "解析订单摘要"}（已根据订单号解析内部 ID）`,
      };
    }
  }

  if (toolCall.actionKey === "projects.get_summary") {
    const rawProjectId = typeof toolCall.input.projectId === "string" ? toolCall.input.projectId.trim() : "";
    if (!rawProjectId) return toolCall;

    const search = await executeAgentAction(ctx, "projects.search", {
      query: rawProjectId,
      limit: 5,
    });
    const items = (search.result as { items?: Array<{ id: string; name?: string | null }> }).items ?? [];
    const exactMatches = items.filter((item) => item.id === rawProjectId || item.name === rawProjectId);
    if (exactMatches.length === 1) {
      return {
        ...toolCall,
        input: { projectId: exactMatches[0].id },
        reason: `${toolCall.reason || "解析项目摘要"}（已根据项目名称解析内部 ID）`,
      };
    }
  }

  return toolCall;
}

function shouldFollowProjectSummary(toolCall: PlannedToolCall) {
  if (toolCall.actionKey !== "projects.search") return false;
  return /摘要|详情|概览/.test(toolCall.reason ?? "");
}

/**
 * CRM customer resolution follow-up trigger keys (docs §9.2).
 *
 * Three branches, sharing one per-turn quota, mirroring chat-stream's
 * `maybeExecuteCrmCustomerContextFollowUp`:
 *  1. `crm.search_customers` returning exactly one hit (legacy behavior);
 *  2. `crm.resolve_customer_name` with resolution==="UNIQUE" (take
 *     candidates[0].profileId);
 *  3. `crm.search_customers_by_pinyin` with resolution==="UNIQUE" (唯一命中).
 *
 * Each branch fans out to `crm.get_customer_context` for the resolved
 * profileId so the user sees a full customer card. The follow-up target
 * profileId is extracted from each action's distinct output shape by
 * `extractCrmFollowUpProfileId`.
 */
// CRM follow-up 共享逻辑（提取到 @/lib/agent-runtime/crm-follow-up.ts）

/**
 * 同进程直调（docs §1.2：禁止 adapter 服务端 fetch("/api/**")）。
 * 由 agentRunId 重新解析当前 actor 后执行工具，等价于旧的
 * internal-token `/api/agent/tools/execute` 回调，但不再走内部 HTTP。
 */
async function executeToolViaInternalApi(
  agentRunId: string,
  toolCall: PlannedToolCall,
) {
  return executeAgentToolForRun({
    agentRunId,
    actionKey: toolCall.actionKey,
    input: toolCall.input,
  });
}

async function maybeExecuteFollowUpTool(
  agentRunId: string,
  toolCall: PlannedToolCall,
  toolResult: unknown,
  actor: { userId: string; role: string },
): Promise<FollowUpToolResponse | null> {
  if (shouldFollowProjectSummary(toolCall)) {
    const items = (toolResult as { items?: Array<{ id: string }> }).items ?? [];
    if (items.length === 1 && items[0]?.id) {
      const followUpToolCall: PlannedToolCall = {
        actionKey: "projects.get_summary",
        input: { projectId: items[0].id },
        reason: "已定位到唯一项目，继续读取项目摘要",
      };
      const toolData = await executeToolViaInternalApi(agentRunId, followUpToolCall);
      return { mode: toolData.mode, result: toolData.result, proposal: toolData.proposal };
    }
  }

  if (shouldFollowCrmCustomerContext(toolCall.actionKey)) {
    const profileId = extractCrmFollowUpProfileId(toolCall.actionKey, toolResult);
    if (profileId) {
      // Validator gate (docs §9.2 / §7.1, aligned with chat-stream):
      // re-check existence + scope before the follow-up. On ok:false skip
      // the follow-up and record one error tool item labeled 「客户校验失败」;
      // do not throw, do not block the main reply.
      const validation = await validateCustomerTarget(actor, profileId);
      if (!validation.ok) {
        return {
          mode: "validation_error",
          validationError: validation.reason,
          profileId,
        };
      }

      const followUpToolCall: PlannedToolCall = {
        actionKey: "crm.get_customer_context",
        input: { profileId },
        reason: "已定位到唯一客户，继续读取客户档案",
      };
      const toolData = await executeToolViaInternalApi(agentRunId, followUpToolCall);
      return { mode: toolData.mode, result: toolData.result, proposal: toolData.proposal };
    }
  }

  return null;
}

function isChatMessage(value: unknown): value is ChatMessage {
  return Boolean(
    value &&
      typeof value === "object" &&
      "role" in value &&
      "content" in value &&
      ((value as { role?: unknown }).role === "user" || (value as { role?: unknown }).role === "assistant") &&
      typeof (value as { content?: unknown }).content === "string",
  );
}

function stripFence(content: string) {
  return content
    .replace(/```json?\n?/g, "")
    .replace(/```/g, "")
    .trim();
}

function stripThought(content: string) {
  return content.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

function extractJsonCandidates(content: string) {
  const candidates: string[] = [];
  let depth = 0;
  let start = -1;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    if (char === "{") {
      if (depth === 0) {
        start = index;
      }
      depth += 1;
    } else if (char === "}") {
      if (depth > 0) {
        depth -= 1;
        if (depth === 0 && start >= 0) {
          candidates.push(content.slice(start, index + 1));
          start = -1;
        }
      }
    }
  }

  return candidates;
}

function findBalancedJsonObjectSegment(content: string, startPattern: RegExp) {
  const matched = startPattern.exec(content);
  if (!matched || matched.index < 0) return null;

  const openBraceIndex = content.indexOf("{", matched.index);
  if (openBraceIndex < 0) return null;

  let depth = 0;
  for (let index = openBraceIndex; index < content.length; index += 1) {
    const char = content[index];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return content.slice(openBraceIndex, index + 1);
      }
    }
  }

  return null;
}

function fallbackParsePlannerResponse(content: string): { reply?: string; tool_calls?: PlannedToolCall[] } {
  const cleaned = stripThought(stripFence(content));
  const replyMatch = cleaned.match(/"reply"\s*:\s*"((?:\\.|[^"\\])*)"/);
  const actionBlocks = cleaned.match(/"actionKey"\s*:\s*"[^"]+"[\s\S]*?"input"\s*:\s*\{[\s\S]*?\}/g) ?? [];
  const toolCalls: PlannedToolCall[] = [];

  for (const block of actionBlocks) {
    const actionKeyMatch = block.match(/"actionKey"\s*:\s*"([^"]+)"/);
    if (!actionKeyMatch) continue;

    const inputSegment = findBalancedJsonObjectSegment(block, /"input"\s*:/);
    if (!inputSegment) continue;

    try {
      const input = JSON.parse(inputSegment) as Record<string, unknown>;
      const reasonMatch = block.match(/"reason"\s*:\s*"([^"]*)"/);
      toolCalls.push({
        actionKey: actionKeyMatch[1],
        input,
        reason: reasonMatch?.[1],
      });
    } catch {
      continue;
    }
  }

  return {
    reply: replyMatch?.[1],
    tool_calls: toolCalls,
  };
}

function parsePlannerResponse(content: string): { reply?: string; tool_calls?: PlannedToolCall[] } {
  const cleaned = stripThought(stripFence(content));
  const candidates = extractJsonCandidates(cleaned);

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as { reply?: string; tool_calls?: PlannedToolCall[] };
    } catch {
      continue;
    }
  }

  return fallbackParsePlannerResponse(cleaned);
}

function safeParsePlannerResponse(content: string) {
  try {
    const parsed = parsePlannerResponse(content);
    if ((parsed.reply && parsed.reply.trim()) || (parsed.tool_calls && parsed.tool_calls.length > 0)) {
      return parsed;
    }
    throw new Error("Planner response did not contain structured content");
  } catch {
    return { reply: stripThought(stripFence(content)), tool_calls: [] as PlannedToolCall[] };
  }
}

function serializeHistory(messages: ChatMessage[]) {
  return messages.map((message) => `${message.role === "user" ? "用户" : "助手"}：${message.content}`).join("\n");
}

function toolPlanningPrompt(
  actions: Awaited<ReturnType<typeof listAvailableAgentActions>>,
  opts: {
    hotCustomers?: Array<{ profileId: string; name: string; namePinyin: string }>;
    hotProjects?: Array<{ projectId: string; name: string; projectNo: string | null }>;
    entityMemories?: Array<{
      entityType: string;
      entityId: string;
      name: string;
      summary: string;
    }>;
    inputMode?: "voice" | "text" | null;
  } = {},
) {
  const toolSpecs = actions
    .map((action) => ({
      key: action.key,
      title: action.title,
      riskLevel: action.riskLevel,
      description: action.description,
      inputSchema: action.inputSchema,
    }));

  const lines: string[] = [
    "你是 SciManage 的科研业务助理。你服务中文用户，场景是项目、订单、CRM、财务线索的查询和摘要，也可以为写操作生成待确认 proposal。",
    "",
    "你可以使用这些动作：",
    JSON.stringify(toolSpecs, null, 2),
    "",
    "输出必须是 JSON，不要写额外文字，格式固定为：",
    "{",
    '  "reply": "给用户的简短回应，若要先查数据可写正在查询的意图",',
    '  "tool_calls": [',
    "    {",
    '      "actionKey": "动作 key",',
    '      "input": { "参数": "值" },',
    '      "reason": "为什么需要这个动作"',
    "    }",
    "  ]",
    "}",
    "",
    "规则：",
    "1. 如无需查数据，tool_calls 返回空数组。",
    "2. 最多使用 3 个动作。",
    "3. 只能使用上面提供的动作 key。",
    "4. 参数必须严格贴合 inputSchema。",
    "5. riskLevel 为 safe 的动作会直接执行；riskLevel 为 confirm 的动作只会生成待用户确认的 proposal。",
    "6. projects.get_summary、orders.get_finance_snapshot 这类摘要动作必须使用内部 ID；如果用户只给名称、订单号或关键词，要先用 search 动作。",
    "7. 不得编造结果。",
  ];

  // 热客户 prompt 注入（docs §5.4 / §9.2）：legacy planning 也要看到热客户。
  // 仅渲染紧凑列表（姓名 拼音 (profileId)），不放敏感字段；最多 30 条。
  const hotCustomers = opts.hotCustomers ?? [];
  if (hotCustomers.length > 0) {
    const hotLines = hotCustomers.slice(0, 30).map(
      (c) => `${c.name} ${c.namePinyin} (profileId: ${c.profileId})`,
    );
    lines.push(
      "",
      "[当前可见的活跃客户 / hot customers]",
      ...hotLines,
      "约束：只能引用本列表中的 profileId，不得自行生成或猜测 profileId；列表未命中时调用 crm.search_customers_by_pinyin（拼音/同音）或 crm.resolve_customer_name（语音姓名解析）。",
    );
  }

  // 热项目 prompt 注入（梦境记忆 D1/D3 / parity with chat-stream）：紧凑列表，
  // 不放长文本字段；最多 30 条。与热客户同口径。
  const hotProjects = opts.hotProjects ?? [];
  if (hotProjects.length > 0) {
    const hotLines = hotProjects.slice(0, 30).map(
      (p) => `${p.name} ${p.projectNo ?? ""} (projectId: ${p.projectId})`.trim(),
    );
    lines.push(
      "",
      "[近期活跃项目 / hot projects]",
      ...hotLines,
      "约束：只能引用本列表中的 projectId，不得自行生成或猜测 projectId；列表未命中时调用 projects.search，或当热客户/热项目都未命中时用 agent.recall_memory 做向量记忆召回（查「最近接触过的项目/客户/偏好」）。",
    );
  }

  const entityMemories = opts.entityMemories ?? [];
  if (entityMemories.length > 0) {
    const memoryLines = entityMemories.slice(0, 15).map((memory) =>
      `- [${memory.entityType}] ${memory.name}：${memory.summary}`,
    );
    lines.push(
      "",
      "[近期活跃实体记忆 / entity memories]",
      ...memoryLines,
      "约束：这是历史上下文线索；项目或客户 ID 必须通过对应的服务端查询动作复核后使用。",
    );
  }

  // 语音输入细则（docs §9.2：与 chat-stream voice rules 口径一致）。
  if (opts.inputMode === "voice") {
    lines.push(
      "",
      "语音输入细则（本轮 inputMode=voice）：",
      "   - 客户姓名可能是同音错字（如「王小明」实为「王晓明」）；优先在上方「当前可见的活跃客户」列表里按同音/同字找候选，唯一明确时直接引用其 profileId 调 crm.get_customer_context；",
      "   - 列表未命中或候选不唯一时，使用 crm.resolve_customer_name（spokenName=姓名片段，尽量附 organizationHint/principalHint）或 crm.search_customers_by_pinyin（拼音/同音/拼音首字母兜底召回）；",
      "   - 禁止直接用转写文本调用 crm.search_customers 来代替解析，禁止凭姓名猜测 profileId。",
    );
  }

  return lines.join("\n");
}

function toolSummaryPrompt() {
  return `你是 SciManage 的科研业务助理。你会基于用户问题和工具结果，给出清晰、克制、可执行的中文回答。

输出必须是 JSON，不要写额外文字，格式固定为：
{
  "reply": "给用户的最终回答",
  "follow_ups": ["可选的后续追问 1", "可选的后续追问 2"]
}

要求：
1. 直接回答，不解释你是如何被提示的。
2. 如果结果为空，要明确说没查到，并给出下一步建议。
3. 如果有 proposal，要明确告诉用户需要确认才能执行。
4. 对金额、数量、状态使用简洁表述。
5. 若工具结果带有「业务卡片已展示 / 禁止复述 / 禁止推断」旁白，正文可为空或最多一句下一步；禁止复述卡片字段，禁止推断待回款、交付等未由工具证明的结论；工具失败、需要补充信息或没有对应卡片时才详细解释。`;
}

function buildLegacyModelToolRuns(toolRuns: Array<{
  actionKey: string;
  reason?: string;
  input: Record<string, unknown>;
  status: "done" | "error";
  result?: unknown;
  error?: string;
}>) {
  return toolRuns.map((toolRun) => {
    if (toolRun.status === "error") return toolRun;
    const action = getAgentAction(toolRun.actionKey);
    const narration = buildCardToolNarration(action?.presentation, "result", {
      actionKey: toolRun.actionKey,
      result: toolRun.result,
    });
    if (narration) {
      return {
        actionKey: toolRun.actionKey,
        status: toolRun.status,
        narration,
      };
    }
    return {
      actionKey: toolRun.actionKey,
      status: toolRun.status,
      // Money-formatted text for the summarizer only; UI still uses raw toolRuns.
      resultText: buildModelFacingToolTextForAction(action, {
        mode: "result",
        result: toolRun.result,
      }),
    };
  });
}

function buildLegacyModelProposals(proposals: unknown[]) {
  return proposals.map((proposal) => {
    if (!proposal || typeof proposal !== "object") return proposal;
    const record = proposal as Record<string, unknown>;
    const actionKey = typeof record.actionKey === "string" ? record.actionKey : "";
    const action = actionKey ? getAgentAction(actionKey) : undefined;
    const narration = buildCardToolNarration(action?.presentation, "proposal", {
      actionKey,
    });
    if (!narration) return proposal;
    return {
      actionKey,
      title: typeof record.title === "string" ? record.title : undefined,
      status: typeof record.status === "string" ? record.status : "PENDING",
      narration,
    };
  });
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const denied = requireAgentAccess(session);
  if (denied) return denied;
  if (!isMinimaxConfigured()) {
    return NextResponse.json({ error: "MiniMax API 未配置" }, { status: 503 });
  }

  try {
    const body = await req.json();
    if (!body || typeof body !== "object") {
      throw new AgentActionInputError("Request body must be an object");
    }

    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!message) {
      throw new AgentActionInputError("message is required");
    }

    // 解析 inputMode（与 chat-stream 口径一致，仅接受 voice/text）：语音输入时
    // 在 planning 上下文里提示 planner 优先用 crm.resolve_customer_name 处理同音错字。
    const inputModeRaw = typeof body.inputMode === "string" ? body.inputMode : null;
    const inputMode = inputModeRaw === "voice" || inputModeRaw === "text" ? inputModeRaw : null;

    const messageContext = body.messageContext && typeof body.messageContext === "object" && !Array.isArray(body.messageContext)
      ? body.messageContext as {
          verifiedCustomerProfileId?: unknown;
          verifiedInvoiceStaging?: unknown;
          verifiedInvoiceStagingFiles?: unknown;
          verifiedImportStagingFiles?: unknown;
        }
      : null;
    const rawVerifiedCustomerProfileId = typeof messageContext?.verifiedCustomerProfileId === "string"
      ? messageContext.verifiedCustomerProfileId.trim()
      : "";
    const rawVerifiedInvoiceStaging =
      messageContext?.verifiedInvoiceStaging
      && typeof messageContext.verifiedInvoiceStaging === "object"
      && !Array.isArray(messageContext.verifiedInvoiceStaging)
        ? messageContext.verifiedInvoiceStaging as Record<string, unknown>
        : null;
    const rawVerifiedInvoiceStagingFiles = Array.isArray(messageContext?.verifiedInvoiceStagingFiles)
      ? messageContext.verifiedInvoiceStagingFiles
      : null;
    const rawVerifiedImportStagingFiles = Array.isArray(messageContext?.verifiedImportStagingFiles)
      ? messageContext.verifiedImportStagingFiles
      : null;

    const requestedAgentRunId = typeof body.agentRunId === "string" ? body.agentRunId.trim() : "";

    const history = Array.isArray(body.history)
      ? body.history.filter(isChatMessage)
      : [];

    const agentRun = await getOrCreateAgentRunFromSession(session, requestedAgentRunId || null, "CHAT");
    const execCtx = await getExecutionContextFromAgentRun(agentRun.id);
    const actor = execCtx.actor;
    // 与 chat-stream 同口径：注入前校验 profileId，失败则忽略。
    let verifiedCustomerProfileId = "";
    if (rawVerifiedCustomerProfileId) {
      const validation = await validateCustomerTarget(actor, rawVerifiedCustomerProfileId);
      if (validation.ok) {
        verifiedCustomerProfileId = validation.profile.profileId;
      } else {
        console.warn(
          "[chat] ignored unverifiedCustomerProfileId:",
          validation.reason,
        );
      }
    }

    let verifiedInvoiceStagingFiles: VerifiedInvoiceStagingContext[] = [];
    let ingestJobError: string | null = null;
    if (actor.role === "ADMIN") {
      const rawItems: Array<{ stagingFileId?: unknown; sha256?: unknown; version?: unknown }> = [];
      if (rawVerifiedInvoiceStagingFiles) {
        for (const item of rawVerifiedInvoiceStagingFiles) {
          if (item && typeof item === "object" && !Array.isArray(item)) {
            rawItems.push(item as Record<string, unknown>);
          }
        }
      } else if (rawVerifiedInvoiceStaging) {
        rawItems.push(rawVerifiedInvoiceStaging);
      }
      if (rawItems.length > 0) {
        const candidates = await validateVerifiedInvoiceStagingContextList({
          userId: actor.userId,
          items: rawItems,
          agentRunId: agentRun.id,
        });
        if (candidates.length > 0) {
          // Phase 1: 绑定 staging 到 AgentRun（失败 = 拒绝附件）
          try {
            await assertAndBindStagingToAgentRun({
              stagingFileIds: candidates.map((f) => f.stagingFileId),
              userId: actor.userId,
              agentRunId: agentRun.id,
            });
            verifiedInvoiceStagingFiles = candidates;
          } catch (err) {
            console.warn(
              "[chat] refused invoice staging bind:",
              err instanceof Error ? err.message : err,
            );
            verifiedInvoiceStagingFiles = [];
          }
          // Phase 2: 创建 INVOICE_INGEST Job（失败保留绑定，记录错误供幂等重试）
          if (verifiedInvoiceStagingFiles.length > 0) {
            try {
              await createInvoiceIngestJob({
                ownerUserId: actor.userId,
                stagingFileIds: candidates.map((f) => f.stagingFileId),
                agentRunId: agentRun.id,
              });
            } catch (err) {
              console.error(
                "[chat] createInvoiceIngestJob failed (binding preserved):",
                err instanceof Error ? err.message : err,
              );
              ingestJobError = err instanceof Error ? err.message : "unknown";
            }
          }
        }
      }
    }

    // 订单导入 staging：与发票 staging 同口径，服务端重校验 + 绑定 AgentRun。
    let verifiedImportStagingFiles: VerifiedImportStagingContext[] = [];
    if (actor.role === "ADMIN" && rawVerifiedImportStagingFiles) {
      const rawItems: Array<{ stagingFileId?: unknown; sha256?: unknown; version?: unknown }> = [];
      for (const item of rawVerifiedImportStagingFiles) {
        if (item && typeof item === "object" && !Array.isArray(item)) {
          rawItems.push(item as Record<string, unknown>);
        }
      }
      const verified: VerifiedImportStagingContext[] = [];
      const seen = new Set<string>();
      for (const item of rawItems.slice(0, 10)) {
        const stagingFileId = typeof item.stagingFileId === "string" ? item.stagingFileId.trim() : "";
        if (!stagingFileId || seen.has(stagingFileId)) continue;
        seen.add(stagingFileId);
        const sha256 = typeof item.sha256 === "string" ? item.sha256.trim() : undefined;
        const version = typeof item.version === "number" ? item.version : undefined;
        const validated = await validateVerifiedImportStagingContext({
          userId: actor.userId,
          stagingFileId,
          expectedSha256: sha256,
          expectedVersion: version,
          importKind: IMPORT_KIND.ORDER,
          agentRunId: agentRun.id,
        });
        if (validated) verified.push(validated);
      }
      if (verified.length > 0) {
        try {
          await assertAndBindImportStagingToAgentRun({
            stagingFileIds: verified.map((f) => f.stagingFileId),
            userId: actor.userId,
            agentRunId: agentRun.id,
          });
          verifiedImportStagingFiles = verified;
        } catch (err) {
          console.warn(
            "[chat] refused import staging bind:",
            err instanceof Error ? err.message : err,
          );
          verifiedImportStagingFiles = [];
        }
      }
    }
    const actions = await listAvailableAgentActions(actor);
    const provider = new MinimaxChatProvider();

    // 热客户加载（docs §5 / §9.2）：legacy planning 也要看到热客户。
    // 失败降级为空数组，不阻断聊天（与 chat-stream 同口径）。
    const [hotCustomers, hotProjects, entityMemories] = await Promise.all([
      listHotCustomersForActor(actor).catch((err) => {
        console.error("listHotCustomersForActor failed:", err);
        return [];
      }),
      // 热项目加载（梦境记忆 D1/D3）：失败降级为空数组，不阻断聊天。
      listHotProjectsForActor(actor).catch((err) => {
        console.error("listHotProjectsForActor failed:", err);
        return [];
      }),
      listActiveEntityMemoriesForActor(actor, 15).catch((err) => {
        console.error("listActiveEntityMemoriesForActor failed:", err);
        return [];
      }),
    ]);

    const planningMessage = [
      history.length > 0 ? `历史对话：\n${serializeHistory(history)}` : "",
      inputMode === "voice"
        ? "（本次输入来自语音转写，客户姓名可能含同音错字；请按系统提示中的语音输入细则处理客户名查询。）"
        : "",
      `当前用户问题：${message}`,
      verifiedCustomerProfileId
        ? `[内部已确认客户上下文] 用户已在客户选择卡中确认 profileId=${verifiedCustomerProfileId}。直接使用该 profileId，不要把内部 ID 展示给用户。`
        : "",
      verifiedInvoiceStagingFiles.length > 0
        ? verifiedInvoiceStagingFiles.length === 1
          ? `[内部已确认发票附件] stagingFileId=${verifiedInvoiceStagingFiles[0].stagingFileId}；fileName=${verifiedInvoiceStagingFiles[0].fileName}；expectedSha256=${verifiedInvoiceStagingFiles[0].sha256}；expectedStagingVersion=${verifiedInvoiceStagingFiles[0].version}。先调用 finance.analyze_invoice_file，再对本张调用 finance.register_issued_invoice；必须使用这些已验证字段，禁止编造。`
          : `[内部已确认发票附件共 ${verifiedInvoiceStagingFiles.length} 张] 按顺序逐张：先 finance.analyze_invoice_file，再对本张 finance.register_issued_invoice；禁止批量落库。清单：${verifiedInvoiceStagingFiles.map((f, i) => `${i + 1}.${f.stagingFileId}/v${f.version}/${f.fileName}`).join("；")}`
        : "",
      verifiedImportStagingFiles.length > 0
        ? verifiedImportStagingFiles.length === 1
          ? `[内部已确认订单导入附件] stagingFileId=${verifiedImportStagingFiles[0].stagingFileId}；fileName=${verifiedImportStagingFiles[0].fileName}；expectedSha256=${verifiedImportStagingFiles[0].sha256}；expectedVersion=${verifiedImportStagingFiles[0].version}。先调用 orders.analyze_import_file；若返回 needsColumnMapping=true，与用户确认列映射后调用 orders.apply_import_column_mapping。必须使用这些已验证字段，禁止编造。`
          : `[内部已确认订单导入附件共 ${verifiedImportStagingFiles.length} 个] 按顺序逐个：先 orders.analyze_import_file；禁止批量落库。清单：${verifiedImportStagingFiles.map((f, i) => `${i + 1}.${f.stagingFileId}/v${f.version}/${f.fileName}`).join("；")}`
        : "",
    ].filter(Boolean).join("\n\n");

    const planResponse = await provider.chat({
      systemPrompt: toolPlanningPrompt(actions, {
        hotCustomers,
        hotProjects,
        entityMemories,
        inputMode,
      }),
      userMessage: planningMessage,
      temperature: 0.2,
      maxTokens: 1400,
    });

    const plan = safeParsePlannerResponse(planResponse.content);
    const plannedToolCalls = Array.isArray(plan.tool_calls) ? plan.tool_calls.slice(0, 3) : [];

    const toolRuns: Array<{
      actionKey: string;
      reason?: string;
      input: Record<string, unknown>;
      status: "done" | "error";
      result?: unknown;
      error?: string;
    }> = [];
    const proposals: Array<unknown> = [];

    for (const toolCall of plannedToolCalls) {
      try {
        const normalizedToolCall = await normalizePlannedToolCall(execCtx, toolCall);
        const action = getAgentAction(normalizedToolCall.actionKey);
        if (!action) {
          throw new AgentActionInputError(`Unknown action: ${normalizedToolCall.actionKey}`);
        }

        const toolData = await executeToolViaInternalApi(agentRun.id, normalizedToolCall);

        if (toolData.mode === "proposal") {
          proposals.push(toolData.proposal);
        } else {
          toolRuns.push({
            actionKey: normalizedToolCall.actionKey,
            reason: normalizedToolCall.reason,
            input: normalizedToolCall.input,
            status: "done",
            result: toolData.result,
          });

          const followUpToolData = await maybeExecuteFollowUpTool(
            agentRun.id,
            normalizedToolCall,
            toolData.result,
            actor,
          );
          if (followUpToolData?.mode === "proposal") {
            proposals.push(followUpToolData.proposal);
          } else if (followUpToolData?.mode === "result") {
            // Derive the follow-up actionKey + input from the source action so
            // this stays in sync with maybeExecuteFollowUpTool without
            // duplicating the mapping here.
            const isProjectFollowUp = normalizedToolCall.actionKey === "projects.search";
            const isCrmFollowUp = shouldFollowCrmCustomerContext(normalizedToolCall.actionKey);
            const followUpActionKey = isProjectFollowUp
              ? "projects.get_summary"
              : isCrmFollowUp
                ? "crm.get_customer_context"
                : normalizedToolCall.actionKey;
            const followUpInput = isProjectFollowUp
              ? {
                  projectId: (toolData.result as { items?: Array<{ id: string }> }).items?.[0]?.id,
                }
              : isCrmFollowUp
                ? {
                    profileId: extractCrmFollowUpProfileId(normalizedToolCall.actionKey, toolData.result),
                  }
                : normalizedToolCall.input;
            toolRuns.push({
              actionKey: followUpActionKey,
              reason: isCrmFollowUp
                ? "已定位到唯一客户，继续读取客户档案"
                : "已根据唯一匹配结果继续读取摘要",
              input: followUpInput,
              status: "done",
              result: followUpToolData.result,
            });
          } else if (followUpToolData?.mode === "validation_error") {
            // CRM follow-up target rejected by validateCustomerTarget
            // (scope/existence gate, docs §9.2). Mirror chat-stream: record
            // one error tool item labeled 「客户校验失败」, do not throw.
            toolRuns.push({
              actionKey: "crm.get_customer_context",
              reason: "客户校验失败",
              input: { profileId: followUpToolData.profileId },
              status: "error",
              error: followUpToolData.validationError,
            });
          }
        }
      } catch (error) {
        toolRuns.push({
          actionKey: toolCall.actionKey,
          reason: toolCall.reason,
          input: toolCall.input,
          status: "error",
          error: error instanceof Error ? error.message : "Tool execution failed",
        });
      }
    }

    let reply = (plan.reply || "").trim();
    let followUps: string[] = [];

    if (toolRuns.length > 0 || proposals.length > 0) {
      try {
        const summaryResponse = await provider.chat({
          systemPrompt: toolSummaryPrompt(),
          userMessage: `用户问题：${message}

历史对话：
${serializeHistory(history)}

工具结果：
${JSON.stringify(buildLegacyModelToolRuns(toolRuns), null, 2)}

待确认 proposal：
${JSON.stringify(buildLegacyModelProposals(proposals), null, 2)}`,
          temperature: 0.2,
          maxTokens: 1800,
        });

        const summary = safeParsePlannerResponse(summaryResponse.content) as { reply?: string; follow_ups?: string[] };
        reply = (summary.reply || reply || "我已经查完结果。").trim();
        followUps = Array.isArray(summary.follow_ups)
          ? summary.follow_ups.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, 3)
          : [];
      } catch (summaryError) {
        console.error("agent chat summary failed:", summaryError);
        if (proposals.length > 0 && toolRuns.length > 0) {
          reply = `我已经完成查询，并生成了 ${proposals.length} 条待确认动作。你可以先确认 proposal，再继续追问结果细节。`;
        } else if (proposals.length > 0) {
          reply = `我已经生成了 ${proposals.length} 条待确认动作。确认后系统才会真正执行写操作。`;
        } else if (toolRuns.some((toolRun) => toolRun.status === "done")) {
          reply = "我已经完成查询，但本次总结整理失败。你可以直接查看工具结果，或重试一次。";
        } else {
          reply = "我尝试执行了相关动作，但总结整理失败。你可以重试一次。";
        }
      }
    } else if (!reply) {
      reply = "我可以继续帮你查项目、订单、CRM 客户，或者根据现有内容做摘要。";
    }

    return NextResponse.json({
      ok: true,
      agentRunId: agentRun.id,
      reply,
      toolRuns,
      proposals,
      followUps,
      ...(ingestJobError ? { ingestJobError } : {}),
    });
  } catch (error) {
    if (error instanceof AgentActionError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }

    console.error("agent chat failed:", error);
    return NextResponse.json({ error: "Agent chat failed" }, { status: 500 });
  }
}

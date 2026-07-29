/**
 * Phase D: stateful workflow facade handlers（import / bank-flow）。
 *
 * §4.3：facade 读取 workspace 当前状态（经 internal action），按 public input 的
 * `operation` enum 调度到对应 internal action，返回**仅当前步**的 nextAction +
 * 所需用户决策。
 *
 * 保留 workspace version/lease/proposal/recovery（既有 internal action 已有，
 * controller 只编排）。每 turn 一个 nextAction，且必须是真实可执行的 operation。
 *
 * 授权边界留给 canonical service（requireOwnedImportSession /
 * loadBankFlowWorkspaceForActor / getOwnedStagingFile 等 id AND actorScope gate），
 * 经 internal action 调用，不在 facade 直连。
 *
 * 本文件零 Prisma（经 internal action）。
 */
import type { AgentExecutionContext } from "@/lib/agent-actions/types";
import { runAgentToolForActor } from "@/lib/agent-actions/execute-tool-for-run";
import type { PublicFacadeResult } from "../public-executor";

/** 读 publicInput 中的字符串 id 字段；空/缺失返回 ""（由下游 service 校验存在性 → 404）。 */
function readId(input: Record<string, unknown>, field: string): string {
  const v = input[field];
  return typeof v === "string" ? v : "";
}

/** 读可选的字符串字段；缺失返回 undefined。 */
function readOptionalString(input: Record<string, unknown>, field: string): string | undefined {
  const v = input[field];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** 读可选的非负整数；非法/缺失返回 undefined。 */
function readOptionalNonNegInt(input: Record<string, unknown>, field: string): number | undefined {
  const v = input[field];
  if (typeof v === "number" && Number.isInteger(v) && v >= 0) return v;
  return undefined;
}

/** 读可选的 string 数组；非法返回 undefined。 */
function readOptionalStringArray(input: Record<string, unknown>, field: string): string[] | undefined {
  const v = input[field];
  if (!Array.isArray(v)) return undefined;
  const out: string[] = [];
  for (const el of v) {
    if (typeof el !== "string" || el.length === 0) return undefined;
    out.push(el);
  }
  return out;
}

/** 读可选的非负整数数组；非法返回 undefined。 */
function readOptionalNonNegIntArray(input: Record<string, unknown>, field: string): number[] | undefined {
  const v = input[field];
  if (!Array.isArray(v)) return undefined;
  const out: number[] = [];
  for (const el of v) {
    if (typeof el !== "number" || !Number.isInteger(el) || el < 0) return undefined;
    out.push(el);
  }
  return out;
}

/** 读可选的 record<string,string>；非法返回 undefined。 */
function readOptionalStringRecord(input: Record<string, unknown>, field: string): Record<string, string> | undefined {
  const v = input[field];
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof k !== "string" || typeof val !== "string") return undefined;
    out[k] = val;
  }
  return out;
}

// ─────────────────────────── 订单导入 workflow ───────────────────────────

/**
 * start_order_import：verified upload context only。analyze_import_file 后返回 nextAction。
 *
 * analyze_import_file 直接返回顶层 `sessionId`（非嵌套 `result.session.id`），
 * 修复断链（旧实现读错字段导致 sessionId 恒 null）。
 *
 * 注意：analyze_import_file action 需 verified-context 字段（expectedSha256/expectedVersion），
 * public input 禁带这些（manifest FORBIDDEN_PUBLIC_INPUT_FIELDS）；facade 经
 * orders.get_import_staging_context internal action（owner gate 在内）解析后注入。
 *
 * 标准表头 → sessionId 非空，下一步 resume。
 * 非标准表头 → needsColumnMapping:true，sessionId 空串，下一步交给 GenUI 端点
 * （apply_column_mapping 需 staging 上下文，public input 禁带 verified-context 字段）。
 */
export async function startOrderImportFacade(
  ctx: AgentExecutionContext,
  input: Record<string, unknown>,
): Promise<PublicFacadeResult> {
  const stagingFileId = readId(input, "stagingFileId");
  if (!stagingFileId) {
    return badInputResult("stagingFileId 缺失");
  }
  // 解析 verified-context（public input 禁带，经 internal action + owner gate 解析）。
  const ctxOutcome = await runAgentToolForActor(ctx, "orders.get_import_staging_context", { stagingFileId });
  const ctxResult = (ctxOutcome.result ?? {}) as { sha256?: string; version?: number };
  const expectedSha256 = typeof ctxResult.sha256 === "string" ? ctxResult.sha256 : "";
  const expectedVersion = typeof ctxResult.version === "number" ? ctxResult.version : 0;

  const outcome = await runAgentToolForActor(ctx, "orders.analyze_import_file", {
    stagingFileId,
    expectedSha256,
    expectedVersion,
  });
  const result = (outcome.result ?? {}) as {
    sessionId?: string;
    needsColumnMapping?: boolean;
    nextRowId?: string;
  };

  const sessionId = typeof result.sessionId === "string" ? result.sessionId : "";
  const needsColumnMapping = Boolean(result.needsColumnMapping);

  // nextAction：始终给真实可执行 operation + 当前 sessionId。
  // 非标准表头（needsColumnMapping）sessionId 为空，提示走 GenUI 端点（端点有 staging 上下文）。
  const nextAction = needsColumnMapping
    ? {
        operation: "apply_column_mapping" as const,
        sessionId,
        requires: "column mapping decision（经 order-import-sessions 端点提交 columnMapping）",
      }
    : {
        operation: "resume" as const,
        sessionId,
      };

  return {
    mode: "result",
    modelFacing: {
      analysis: outcome.result,
      nextAction,
    },
    internalActionsCalled: ["orders.get_import_staging_context", "orders.analyze_import_file"],
  };
}

/** 订单导入 operation → internal action 调度结果。 */
type OrderImportDispatch =
  | { kind: "ok"; modelFacing: Record<string, unknown>; internalActionsCalled: string[] }
  | { kind: "bad_input"; message: string };

/**
 * operate_order_import：sessionId + operation enum。
 * 按 operation 调度到对应 internal action，每步返回真实可执行 nextAction。
 *
 * commit_row / skip_row 为 confirm action，runAgentToolForActor 会自动产 PENDING proposal。
 */
export async function operateOrderImportFacade(
  ctx: AgentExecutionContext,
  input: Record<string, unknown>,
): Promise<PublicFacadeResult> {
  const sessionId = readId(input, "sessionId");
  const operation = typeof input.operation === "string" ? input.operation : "";
  const rowId = readOptionalString(input, "rowId");
  const selectedOptionId = readOptionalString(input, "selectedOptionId");
  const columnMapping = readOptionalStringRecord(input, "columnMapping");
  const rowPatch = readOptionalStringRecord(input, "rowPatch");

  if (!sessionId) {
    return badInputResult("sessionId 缺失");
  }

  const dispatch = await dispatchOrderImportOperation(ctx, {
    operation,
    sessionId,
    rowId,
    selectedOptionId,
    columnMapping,
    rowPatch,
  });
  if (dispatch.kind === "bad_input") {
    return badInputResult(dispatch.message);
  }

  // 每条 operation 执行后，调 resume 读最新状态，给出与状态机一致的可执行 nextAction。
  const resumeOutcome = await runAgentToolForActor(ctx, "orders.resume_import_session", { sessionId });
  const resumeResult = (resumeOutcome.result ?? {}) as {
    sessionId?: string;
    sessionStatus?: string;
    hasPendingProposal?: boolean;
    pendingProposal?: { id?: string; title?: string; actionKey?: string } | null;
    importingRowId?: string | null;
    nextRowId?: string | null;
    counts?: {
      total?: number;
      imported?: number;
      failed?: number;
      dropped?: number;
      confirmed?: number;
      unresolved?: number;
    };
  };

  const nextAction = buildOrderImportNextAction(resumeResult);

  // commit_row / skip_row 产 PENDING proposal（dispatch.modelFacing 含 commitRowProposal/skipRowProposal）。
  const producedProposal =
    "commitRowProposal" in dispatch.modelFacing || "skipRowProposal" in dispatch.modelFacing;

  return {
    mode: producedProposal ? "proposal" : "result",
    modelFacing: {
      ...dispatch.modelFacing,
      sessionState: resumeOutcome.result,
      nextAction,
    },
    internalActionsCalled: [...dispatch.internalActionsCalled, "orders.resume_import_session"],
  };
}

/** 按 operation 调度到 internal action（不含 resume）。 */
async function dispatchOrderImportOperation(
  ctx: AgentExecutionContext,
  args: {
    operation: string;
    sessionId: string;
    rowId?: string;
    selectedOptionId?: string;
    columnMapping?: Record<string, string>;
    rowPatch?: Record<string, string>;
  },
): Promise<OrderImportDispatch> {
  const { operation, sessionId } = args;

  switch (operation) {
    case "resume": {
      // resume 只读，由外层统一调用；这里直接返回，不重复调。
      return {
        kind: "ok",
        modelFacing: {},
        internalActionsCalled: [],
      };
    }

    case "apply_column_mapping": {
      // 需要从 session 反查 stagingFileId/version（public input 禁带 verified-context）。
      if (!args.columnMapping || Object.keys(args.columnMapping).length === 0) {
        return { kind: "bad_input", message: "apply_column_mapping 需 columnMapping（source→target）" };
      }
      const ctxOutcome = await runAgentToolForActor(ctx, "orders.get_import_staging_context", { sessionId });
      const ctxResult = (ctxOutcome.result ?? {}) as { stagingFileId?: string; version?: number };
      const stagingFileId = typeof ctxResult.stagingFileId === "string" ? ctxResult.stagingFileId : "";
      const expectedVersion = typeof ctxResult.version === "number" ? ctxResult.version : 0;
      const outcome = await runAgentToolForActor(ctx, "orders.apply_import_column_mapping", {
        stagingFileId,
        expectedVersion,
        columnMapping: args.columnMapping,
      });
      const result = (outcome.result ?? {}) as { sessionId?: string; nextRowId?: string };
      const newSessionId = typeof result.sessionId === "string" && result.sessionId ? result.sessionId : sessionId;
      return {
        kind: "ok",
        modelFacing: { applyColumnMappingResult: outcome.result, sessionId: newSessionId },
        internalActionsCalled: ["orders.get_import_staging_context", "orders.apply_import_column_mapping"],
      };
    }

    case "get_row": {
      const outcome = await runAgentToolForActor(ctx, "orders.get_import_row", {
        sessionId,
        rowId: args.rowId,
      });
      return {
        kind: "ok",
        modelFacing: { row: outcome.result },
        internalActionsCalled: ["orders.get_import_row"],
      };
    }

    case "update_row_draft": {
      if (!args.rowId) return { kind: "bad_input", message: "update_row_draft 需 rowId" };
      if (!args.rowPatch || Object.keys(args.rowPatch).length === 0) {
        return { kind: "bad_input", message: "update_row_draft 需 rowPatch（字段→值）" };
      }
      // 取当前行 version：先 get_import_row 拿 version，再 update（保持乐观锁语义）。
      const getOutcome = await runAgentToolForActor(ctx, "orders.get_import_row", {
        sessionId,
        rowId: args.rowId,
      });
      const getResult = (getOutcome.result ?? {}) as { version?: number };
      const version = typeof getResult.version === "number" ? getResult.version : null;
      if (version == null) {
        return { kind: "bad_input", message: "无法解析当前行 version" };
      }
      const outcome = await runAgentToolForActor(ctx, "orders.update_import_row_draft", {
        sessionId,
        rowId: args.rowId,
        expectedVersion: version,
        patch: args.rowPatch,
      });
      return {
        kind: "ok",
        modelFacing: { updateRowDraftResult: outcome.result },
        internalActionsCalled: ["orders.get_import_row", "orders.update_import_row_draft"],
      };
    }

    case "commit_row": {
      if (!args.rowId) return { kind: "bad_input", message: "commit_row 需 rowId" };
      // confirm action：runAgentToolForActor 自动经 buildProposal + createAgentProposal 产 PENDING。
      // 先取当前行 version + 候选 冻结进 proposalInput。
      const getOutcome = await runAgentToolForActor(ctx, "orders.get_import_row", {
        sessionId,
        rowId: args.rowId,
      });
      const getResult = (getOutcome.result ?? {}) as {
        version?: number;
        candidates?: Array<{ profileId?: string }>;
      };
      const version = typeof getResult.version === "number" ? getResult.version : null;
      if (version == null) {
        return { kind: "bad_input", message: "无法解析当前行 version" };
      }
      // 智能选择 decision：有候选 → USE_SUGGESTION（用第一个候选 profileId）；
      // 无候选 → CREATE_NEW（buildProposal 会用行内 receiverName 等创建客户草稿）。
      // 具体 decision 也可由 GenUI 端点提交（端点接受 selectedOptionId / decision）。
      const firstCandidate = getResult.candidates?.[0]?.profileId;
      const decision = firstCandidate
        ? { type: "USE_SUGGESTION" as const, profileId: firstCandidate }
        : { type: "CREATE_NEW" as const };
      const proposalOutcome = await runAgentToolForActor(ctx, "orders.import_order_row", {
        sessionId,
        rowId: args.rowId,
        expectedRowVersion: version,
        decision,
      });
      return {
        kind: "ok",
        modelFacing: { commitRowProposal: proposalOutcome.proposal ?? proposalOutcome.result },
        internalActionsCalled: ["orders.get_import_row", "orders.import_order_row"],
      };
    }

    case "skip_row": {
      if (!args.rowId) return { kind: "bad_input", message: "skip_row 需 rowId" };
      const getOutcome = await runAgentToolForActor(ctx, "orders.get_import_row", {
        sessionId,
        rowId: args.rowId,
      });
      const getResult = (getOutcome.result ?? {}) as { version?: number };
      const version = typeof getResult.version === "number" ? getResult.version : null;
      if (version == null) {
        return { kind: "bad_input", message: "无法解析当前行 version" };
      }
      const proposalOutcome = await runAgentToolForActor(ctx, "orders.skip_import_row", {
        sessionId,
        rowId: args.rowId,
        expectedVersion: version,
        reason: "用户经 operate_order_import 跳过",
      });
      return {
        kind: "ok",
        modelFacing: { skipRowProposal: proposalOutcome.proposal ?? proposalOutcome.result },
        internalActionsCalled: ["orders.get_import_row", "orders.skip_import_row"],
      };
    }

    default:
      return { kind: "bad_input", message: `未知 operation：${operation}` };
  }
}

/** 由 resume 结果推导下一个真实可执行 operation（与状态机一致）。 */
function buildOrderImportNextAction(resume: {
  sessionId?: string;
  sessionStatus?: string;
  hasPendingProposal?: boolean;
  pendingProposal?: { id?: string; title?: string; actionKey?: string } | null;
  importingRowId?: string | null;
  nextRowId?: string | null;
  counts?: { unresolved?: number; imported?: number; total?: number };
}): Record<string, unknown> {
  const sessionId = resume.sessionId ?? "";

  // 有 PENDING proposal：禁止再建新 proposal，提示确认/拒绝。
  if (resume.hasPendingProposal && resume.pendingProposal?.id) {
    return {
      operation: "resume",
      sessionId,
      requires: "已有待确认 proposal，请先确认或拒绝后再继续",
      pendingProposalId: resume.pendingProposal.id,
    };
  }

  // 无未解决行 → complete。
  const unresolved = resume.counts?.unresolved ?? 0;
  if (unresolved === 0) {
    return { operation: "complete", sessionId, summary: resume.counts };
  }

  // 有未解决行：取下一条；具体 commit/skip 由用户经端点或下一跳决策。
  const nextRowId = resume.nextRowId ?? null;
  return {
    operation: "get_row",
    sessionId,
    rowId: nextRowId,
    requires: "review row then commit_row or skip_row",
    remainingUnresolved: unresolved,
  };
}

// ─────────────────────────── 银行流水 workflow ───────────────────────────

/**
 * start_bank_flow：verified upload context only。
 *
 * analyze_bank_flow_file 直接返回顶层 `workspaceId`（修复断链：旧实现不返回 workspaceId）。
 * phase=MAPPED（自动猜到 payerName/amount）→ 下一步 match_bank_flow_rows。
 * phase=PARSED（未猜到）→ 下一步 apply_bank_flow_mapping（需用户补 mapping）。
 */
export async function startBankFlowFacade(
  ctx: AgentExecutionContext,
  input: Record<string, unknown>,
): Promise<PublicFacadeResult> {
  const stagingFileId = readId(input, "stagingFileId");
  const outcome = await runAgentToolForActor(ctx, "finance.analyze_bank_flow_file", { stagingFileId });
  const result = (outcome.result ?? {}) as {
    workspaceId?: string;
    rowCount?: number;
    version?: number;
    mapping?: { payerName?: string; amount?: string } | null;
  };

  const workspaceId = typeof result.workspaceId === "string" ? result.workspaceId : "";
  const mappingReady = Boolean(result.mapping?.payerName && result.mapping?.amount);

  const nextAction = {
    operation: mappingReady ? ("match_bank_flow_rows" as const) : ("apply_bank_flow_mapping" as const),
    workspaceId,
    expectedVersion: typeof result.version === "number" ? result.version : null,
  };

  return {
    mode: "result",
    modelFacing: {
      analysis: outcome.result,
      nextAction,
    },
    internalActionsCalled: ["finance.analyze_bank_flow_file"],
  };
}

/** 银行流水 operation → internal action 调度结果。 */
type BankFlowDispatch =
  | { kind: "ok"; modelFacing: Record<string, unknown>; internalActionsCalled: string[] }
  | { kind: "bad_input"; message: string };

/**
 * operate_bank_flow：workspaceId + operation enum。
 * 按 operation 调度，每步返回真实可执行 nextAction。
 *
 * confirm_bank_flow_batch 为 confirm action，自动产 PENDING proposal。
 * workspace version 由 finance.get_bank_flow_workspace_state internal action 读取
 * （owner gate 在内；workspace 不存在/越权 → NotFoundError 穿透到 public-executor 翻 404）。
 */
export async function operateBankFlowFacade(
  ctx: AgentExecutionContext,
  input: Record<string, unknown>,
): Promise<PublicFacadeResult> {
  const workspaceId = readId(input, "workspaceId");
  const operation = typeof input.operation === "string" ? input.operation : "";
  const rowIndex = readOptionalNonNegInt(input, "rowIndex");
  const selectedOptionId = readOptionalString(input, "selectedOptionId");
  const combinationIndex = readOptionalNonNegInt(input, "combinationIndex");
  const skip = typeof input.skip === "boolean" ? input.skip : undefined;
  const rowIndices = readOptionalNonNegIntArray(input, "rowIndices");
  const stagingFileIds = readOptionalStringArray(input, "stagingFileIds");
  const mapping = readOptionalStringRecord(input, "mapping");

  if (!workspaceId) {
    return badInputResult("workspaceId 缺失");
  }

  // 读当前 workspace version（经 internal action；workspace 不存在/越权 → NotFoundError 穿透 404）。
  // ocr_bank_flow_receipts 不依赖 workspace version（它创建新 workspace）。
  const version = operation === "ocr_bank_flow_receipts"
    ? undefined
    : await readBankFlowWorkspaceVersion(ctx, workspaceId);

  const dispatch = await dispatchBankFlowOperation(ctx, {
    operation,
    workspaceId,
    version,
    rowIndex,
    selectedOptionId,
    combinationIndex,
    skip,
    rowIndices,
    stagingFileIds,
    mapping,
  });
  if (dispatch.kind === "bad_input") {
    return badInputResult(dispatch.message);
  }

  // 读最新 phase/version 推 nextAction。
  const phase = await readBankFlowWorkspacePhase(ctx, workspaceId);
  const nextAction = buildBankFlowNextAction(workspaceId, phase, dispatch.modelFacing);

  // confirm_bank_flow_batch 产 PENDING proposal（dispatch.modelFacing 含 confirmBatchProposal）。
  const producedProposal = "confirmBatchProposal" in dispatch.modelFacing;

  return {
    mode: producedProposal ? "proposal" : "result",
    modelFacing: {
      ...dispatch.modelFacing,
      workspacePhase: phase,
      nextAction,
    },
    internalActionsCalled: dispatch.internalActionsCalled,
  };
}

/**
 * 经 internal action 读 workspace 当前 version。
 * workspace 不存在/越权 → internal action 抛 NotFoundError，**不 catch**，由 public-executor
 * 翻成 404 RESOURCE_NOT_FOUND（错误分层规范：资源级错误不降级为 bad_input）。
 */
async function readBankFlowWorkspaceVersion(
  ctx: AgentExecutionContext,
  workspaceId: string,
): Promise<number> {
  const outcome = await runAgentToolForActor(ctx, "finance.get_bank_flow_workspace_state", { workspaceId });
  const result = (outcome.result ?? {}) as { version?: number };
  const version = result.version;
  // version 在 schema 必填，理论上总有；若 internal action 返回异常缺字段，让 bad_input 路径兜底。
  if (typeof version !== "number") {
    throw new Error("workspace state 缺 version 字段（internal action 返回异常）");
  }
  return version;
}

/** 经 internal action 读 workspace 当前 phase。 */
async function readBankFlowWorkspacePhase(
  ctx: AgentExecutionContext,
  workspaceId: string,
): Promise<string | null> {
  const outcome = await runAgentToolForActor(ctx, "finance.get_bank_flow_workspace_state", { workspaceId });
  const result = (outcome.result ?? {}) as { phase?: string };
  return typeof result.phase === "string" ? result.phase : null;
}

/** 按 operation 调度到 internal action。 */
async function dispatchBankFlowOperation(
  ctx: AgentExecutionContext,
  args: {
    operation: string;
    workspaceId: string;
    version?: number;
    rowIndex?: number;
    selectedOptionId?: string;
    combinationIndex?: number;
    skip?: boolean;
    rowIndices?: number[];
    stagingFileIds?: string[];
    mapping?: Record<string, string>;
  },
): Promise<BankFlowDispatch> {
  const { operation, workspaceId, version } = args;
  if (version == null && operation !== "ocr_bank_flow_receipts") {
    // readBankFlowWorkspaceVersion 已在不存在时抛 NotFoundError；到这里的唯一可能是 version 字段缺失。
    return { kind: "bad_input", message: "无法解析 workspace version（workspace 不存在或无权访问）" };
  }

  switch (operation) {
    case "apply_bank_flow_mapping": {
      if (!args.mapping || !args.mapping.payerName || !args.mapping.amount) {
        return {
          kind: "bad_input",
          message: "apply_bank_flow_mapping 需 mapping（payerName + amount 必填）",
        };
      }
      const outcome = await runAgentToolForActor(ctx, "finance.apply_bank_flow_mapping", {
        workspaceId,
        mapping: args.mapping,
        expectedVersion: version,
      });
      return {
        kind: "ok",
        modelFacing: { applyMappingResult: outcome.result },
        internalActionsCalled: ["finance.apply_bank_flow_mapping"],
      };
    }

    case "match_bank_flow_rows": {
      const outcome = await runAgentToolForActor(ctx, "finance.match_bank_flow_rows", {
        workspaceId,
        expectedVersion: version,
      });
      return {
        kind: "ok",
        modelFacing: { matchResult: outcome.result },
        internalActionsCalled: ["finance.match_bank_flow_rows"],
      };
    }

    case "get_bank_flow_row": {
      if (args.rowIndex == null) {
        return { kind: "bad_input", message: "get_bank_flow_row 需 rowIndex" };
      }
      const outcome = await runAgentToolForActor(ctx, "finance.get_bank_flow_row", {
        workspaceId,
        rowIndex: args.rowIndex,
      });
      return {
        kind: "ok",
        modelFacing: { row: outcome.result },
        internalActionsCalled: ["finance.get_bank_flow_row"],
      };
    }

    case "update_bank_flow_selection": {
      if (args.rowIndex == null) {
        return { kind: "bad_input", message: "update_bank_flow_selection 需 rowIndex" };
      }
      const outcome = await runAgentToolForActor(ctx, "finance.update_bank_flow_selection", {
        workspaceId,
        rowIndex: args.rowIndex,
        organizationId: args.selectedOptionId,
        combinationIndex: args.combinationIndex,
        skip: args.skip,
        expectedVersion: version,
      });
      return {
        kind: "ok",
        modelFacing: { updateSelectionResult: outcome.result },
        internalActionsCalled: ["finance.update_bank_flow_selection"],
      };
    }

    case "reopen_bank_flow_rows": {
      if (!args.rowIndices || args.rowIndices.length === 0) {
        return { kind: "bad_input", message: "reopen_bank_flow_rows 需 rowIndices（至少 1 个）" };
      }
      const outcome = await runAgentToolForActor(ctx, "finance.reopen_bank_flow_rows", {
        workspaceId,
        rowIndices: args.rowIndices,
        expectedVersion: version,
      });
      return {
        kind: "ok",
        modelFacing: { reopenResult: outcome.result },
        internalActionsCalled: ["finance.reopen_bank_flow_rows"],
      };
    }

    case "ocr_bank_flow_receipts": {
      if (!args.stagingFileIds || args.stagingFileIds.length === 0) {
        return { kind: "bad_input", message: "ocr_bank_flow_receipts 需 stagingFileIds" };
      }
      const outcome = await runAgentToolForActor(ctx, "finance.ocr_bank_flow_receipts", {
        stagingFileIds: args.stagingFileIds,
      });
      const result = (outcome.result ?? {}) as { workspaceId?: string };
      const ocrWorkspaceId = typeof result.workspaceId === "string" ? result.workspaceId : workspaceId;
      return {
        kind: "ok",
        modelFacing: { ocrResult: outcome.result, workspaceId: ocrWorkspaceId },
        internalActionsCalled: ["finance.ocr_bank_flow_receipts"],
      };
    }

    case "confirm_bank_flow_batch": {
      // confirm action：自动产 PENDING proposal。
      const proposalOutcome = await runAgentToolForActor(ctx, "finance.confirm_bank_flow_batch", {
        workspaceId,
        expectedVersion: version,
      });
      return {
        kind: "ok",
        modelFacing: { confirmBatchProposal: proposalOutcome.proposal ?? proposalOutcome.result },
        internalActionsCalled: ["finance.confirm_bank_flow_batch"],
      };
    }

    default:
      return { kind: "bad_input", message: `未知 operation：${operation}` };
  }
}

/** 由 workspace phase 推下一个真实可执行 operation。 */
function buildBankFlowNextAction(
  workspaceId: string,
  phase: string | null,
  dispatchResult: Record<string, unknown>,
): Record<string, unknown> {
  // 若刚产了 PENDING proposal（confirm_bank_flow_batch），提示用户确认。
  if (dispatchResult.confirmBatchProposal) {
    return {
      operation: "confirm_bank_flow_batch",
      workspaceId,
      requires: "proposal 已创建，请确认或拒绝后再继续",
    };
  }

  switch (phase) {
    case "PARSED":
      return { operation: "apply_bank_flow_mapping", workspaceId };
    case "MAPPED":
    case "OCR_PENDING":
      return { operation: "match_bank_flow_rows", workspaceId };
    case "MATCHED":
      return {
        operation: "get_bank_flow_row",
        workspaceId,
        requires: "review rows then update_bank_flow_selection，最终 confirm_bank_flow_batch",
      };
    case "MATCHING":
    case "EXECUTING":
      return { operation: "match_bank_flow_rows", workspaceId, requires: "后台处理中，稍后再读" };
    case "CONFIRMED":
      return { operation: "complete", workspaceId };
    case "PARTIAL_FAILED":
      return { operation: "reopen_bank_flow_rows", workspaceId, requires: "部分失败，可重开重试" };
    default:
      return { operation: "match_bank_flow_rows", workspaceId };
  }
}

// ─────────────────────────── 通用辅助 ───────────────────────────

/** bad input → PublicFacadeResult（标记 needsUserInput，由 selector 注入消费工具）。 */
function badInputResult(message: string): PublicFacadeResult {
  return {
    mode: "needs_input",
    modelFacing: { error: message },
    needsUserInput: true,
    internalActionsCalled: [],
  };
}

/**
 * inspect_attachment：verified attachment context；hash/version 注入。
 */
export async function inspectAttachmentFacade(
  ctx: AgentExecutionContext,
  input: Record<string, unknown>,
): Promise<PublicFacadeResult> {
  const attachmentId = readId(input, "attachmentId");
  const outcome = await runAgentToolForActor(ctx, "agent.inspect_attachments", { stagingFileId: attachmentId });
  return {
    mode: "result",
    modelFacing: { inspection: outcome.result },
    internalActionsCalled: ["agent.inspect_attachments"],
  };
}

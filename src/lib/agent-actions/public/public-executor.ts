/**
 * Phase A: public tool 执行分发层（修正 3）。
 *
 * 铁律（已拍板）：
 *  - runtime 不能把 public tool 名当 actionKey 调既有 /api/agent/tools/execute；
 *    否则模型可绕过 manifest 直提交内部 action key。本分发层只认 manifest 的 publicToolKey。
 *  - 流程：查 manifest → 校 implemented → 校角色 → 调 internal action
 *    （runAgentToolForActor / executeAgentAction）→ 透传结果（真实 id 直给模型）。绝不直连 canonical service。
 *  - propose_* 经 createAgentProposal（confirm 链），不在 propose 阶段做终态业务写。
 *
 * 授权边界完全留给 canonical service 层（getOrderScopeWhere / canReadProject /
 * requireOwnedImportSession 等 id AND actorScope gate）。public layer 不再做 id 包装/解密；
 * 资源不存在或越权都被 service 合并成同一 404（防存在性泄露），由本层 errorToOutcome 统一翻译。
 *
 * Phase A：facade handler 尚未实现（manifest 全部 implemented:false）。
 * 本分发层提供框架 + 安全门（拒未知 key / 拒 internal actionKey 直提交 / 拒非 implemented），
 * 实际 facade handler 注册随各 Phase 逐个填充（registerPublicFacade）。
 *
 * 本模块零 Prisma。
 */
import type { AgentExecutionContext } from "@/lib/agent-actions/types";
import {
  AgentActionConflictError,
  AgentActionError,
  AgentActionForbiddenError,
  AgentActionInputError,
  AgentActionNeedsConfirmationError,
  AgentActionNotFoundError,
} from "../errors";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "@/lib/application/errors";
import { getPublicToolManifestEntry, type PublicToolManifestEntry } from "./manifest";
import { formatZodIssueMessage, getPublicInputSchema } from "./input-schemas";

/**
 * 单个 facade handler：接收已校验的 publicInput（对象），返回 facade 结果。
 * handler 内部负责：直读 publicInput 的真实 id、组装 internal action 输入、调 runAgentToolForActor、透传结果。
 *
 * 为避免循环依赖，handler 用 `AgentExecutionContext` 入参（由 executePublicTool 注入），
 * 内部按需 import execute-tool-for-run（不在本文件顶层 import，防 boundary 误判）。
 */
export type PublicFacadeHandler = (
  ctx: AgentExecutionContext,
  publicInput: Record<string, unknown>,
) => Promise<PublicFacadeResult>;

/**
 * facade 结果的语义模式（P2-3）。
 *  - result：纯结果（读操作、workflow 推进等无 PENDING proposal 的成功结果）。
 *  - needs_input：需要用户补输入/选卡（needsUserInput / needsSelection）。
 *  - preview：纯 preview（已产预览但未产 PENDING proposal；如 prepare_order 草稿）。
 *  - proposal：已产 PENDING proposal（confirm action 经 createAgentProposal 落库）。
 *
 * HTTP 映射（execute-public route）：result/preview/needs_input → 200；proposal → 202。
 * 不再按 internal action 名是否含 "propose" 猜测。
 */
export type PublicFacadeMode = "result" | "needs_input" | "preview" | "proposal";

export type PublicFacadeResult = {
  /**
   * P2-3：必填语义模式。facade 必须显式标注：
   *  - 纯结果 → result
   *  - needsSelection / needsUserInput → needs_input
   *  - preview 已产 PENDING proposal → proposal
   *  - 纯 preview 未产 proposal → preview
   */
  mode: PublicFacadeMode;
  /** 给模型的模型可见结果（真实 id 直给模型）。 */
  modelFacing: Record<string, unknown>;
  /** 是否需要选卡 / 补输入（触发 selector 注入消费工具）。 */
  needsSelection?: boolean;
  needsUserInput?: boolean;
  optionType?: string;
  /** 审计用：实际调了哪些 internal action。 */
  internalActionsCalled?: string[];
};

declare global {
  // standalone 构建按 route 分包可能产生多个 public-executor 模块实例
  // （chat-stream chunk 与 execute-public chunk 各一份）。模块级 Map 会让
  // 一个 chunk 注册的 handler 在另一个 chunk 不可见 → FACADE_HANDLER_MISSING
  // （2026-07-27 demo flag-on 实测命中）。与 action registry 同模式挂 globalThis。
  var __agentPublicFacadeRegistry: Map<string, PublicFacadeHandler> | undefined;
  var __agentPublicFacadesRegistered: boolean | undefined;
}

const FACADE_REGISTRY: Map<string, PublicFacadeHandler> =
  (globalThis.__agentPublicFacadeRegistry ??= new Map<string, PublicFacadeHandler>());

/**
 * P2-2：只读访问已注册的 facade handler key 集合（供 assertManifestFacadeParity 校验）。
 * 不暴露 handler 本身（避免外部直接调用绕过 executePublicTool 安全门）。
 */
export function getRegisteredFacadeKeys(): Set<string> {
  return new Set(FACADE_REGISTRY.keys());
}

/**
 * 注册一个 public facade handler。随 Phase B+ 各 facade 实现时调用。
 * 注册后对应 manifest entry 的 implemented 应由 facade 实现方同步翻 true。
 */
export function registerPublicFacade(publicToolKey: string, handler: PublicFacadeHandler): void {
  if (!getPublicToolManifestEntry(publicToolKey)) {
    throw new Error(`[public-executor] cannot register facade for unknown public tool: ${publicToolKey}`);
  }
  FACADE_REGISTRY.set(publicToolKey, handler);
}

/** 测试辅助：清空 registry（隔离测试）。 */
export function __clearPublicFacadeRegistryForTests(): void {
  FACADE_REGISTRY.clear();
}

export interface ExecutePublicToolParams {
  actor: AgentExecutionContext["actor"];
  invocation: AgentExecutionContext["invocation"];
  /** 模型提交的 public tool 名。 */
  publicToolKey: string;
  /** 模型提交的 public input（原始）。 */
  publicInput: unknown;
}

export type ExecutePublicToolOutcome =
  | { ok: true; result: PublicFacadeResult }
  | {
      ok: false;
      error: string;
      status: number;
      code: string;
      retryable?: boolean;
      /**
       * P1-3 UI 接线：NEEDS_USER_CONFIRMATION 分支透出的 confirm actionKey，
       * 让前端 needs-user-confirmation 卡片能 mint 匹配的 AgentUserConfirmationEvent。
       * 仅在 code === "NEEDS_USER_CONFIRMATION" 时有意义；其余失败分支省略。
       */
      targetIntent?: string;
    };

/**
 * 主分发入口。
 *
 * 安全门（按序，任一失败 fail-closed）：
 *  1. publicToolKey 必须在 manifest；
 *  2. implemented 必须为 true（Phase A 全 false → 全拒，安全）；
 *  3. actor 角色必须在 entry.roles（空数组 = 全角色）；
 *  4. P1-1 严格 Zod 校验 publicInput（在 handler 查找前，因输入合法性独立于 handler）；
 *  5. 必须有已注册 facade handler；
 *  6. handler 直读真实 id / 调 internal action。
 */
export async function executePublicTool(
  params: ExecutePublicToolParams,
): Promise<ExecutePublicToolOutcome> {
  const publicToolKey = typeof params.publicToolKey === "string" ? params.publicToolKey.trim() : "";
  if (!publicToolKey) {
    return { ok: false, error: "publicToolKey is required", status: 400, code: "INVALID_PUBLIC_TOOL_KEY" };
  }

  const entry = getPublicToolManifestEntry(publicToolKey);
  if (!entry) {
    // 关键安全门：未知 publicToolKey 一律拒。绝不回退当 actionKey 处理。
    return { ok: false, error: `Unknown public tool: ${publicToolKey}`, status: 404, code: "UNKNOWN_PUBLIC_TOOL" };
  }

  if (!entry.implemented) {
    // Phase A：所有 facade implemented:false → 这里拒绝，selector 也不会注入，
    // 但若 runtime 误传仍 fail-closed。
    return {
      ok: false,
      error: `Public tool not yet implemented: ${publicToolKey}`,
      status: 501,
      code: "PUBLIC_TOOL_NOT_IMPLEMENTED",
    };
  }

  if (!isRoleAllowed(entry, params.actor.role)) {
    return { ok: false, error: "Forbidden for this role", status: 403, code: "ROLE_FORBIDDEN" };
  }

  // P1-1：严格 Zod 校验。每个 public tool 一个 strict schema（input-schemas.ts），
  // 拒绝：未知字段 / 缺失必填 / 非法枚举 / 非法金额 / 互斥参数同时出现 / 空字符串 / 超长文本。
  // schema 不存在（理论不会发生，因 28 个工具全覆盖）时退回 object-shape 兜底检查。
  // 放在 handler 查找前：输入合法性独立于 handler 是否注册（即使 handler 缺失，
  // 非法输入也应在更早的安全门被拒，便于 agent 看到清晰的 400 而非 500）。
  const schema = getPublicInputSchema(publicToolKey);
  if (!schema) {
    if (typeof params.publicInput !== "object" || params.publicInput === null || Array.isArray(params.publicInput)) {
      return { ok: false, error: "publicInput must be an object", status: 400, code: "INVALID_PUBLIC_INPUT" };
    }
  } else {
    const parsed = schema.safeParse(params.publicInput);
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0];
      const message = formatZodIssueMessage(schema, firstIssue);
      return {
        ok: false,
        error: message,
        status: 400,
        code: "INVALID_PUBLIC_INPUT",
        retryable: false,
      };
    }
  }

  const handler = FACADE_REGISTRY.get(publicToolKey);
  if (!handler) {
    // implemented=true 但没注册 handler = 配置 bug。
    return {
      ok: false,
      error: `Public tool ${publicToolKey} marked implemented but no handler registered`,
      status: 500,
      code: "FACADE_HANDLER_MISSING",
    };
  }

  const ctx: AgentExecutionContext = {
    actor: params.actor,
    // publicToolKey 仅服务端注入，贯穿后续 runAgentToolForActor → ActionLog / proposal 审计。
    invocation: { ...params.invocation, publicToolKey },
  };
  try {
    const result = await handler(ctx, params.publicInput as Record<string, unknown>);
    return { ok: true, result };
  } catch (err) {
    return errorToOutcome(err);
  }
}

function isRoleAllowed(entry: PublicToolManifestEntry, role: string): boolean {
  if (entry.roles.length === 0) return true;
  return (entry.roles as readonly string[]).includes(role);
}

/**
 * 把 service / internal action 抛的领域错误统一翻译成给认证 agent 的结构化错误。
 *
 * 分层规范（docs/agent-public-surface-cleanup-plan-2026-07-26.md §3）：
 *  - NotFoundError（资源不存在或越权合并）→ 404 RESOURCE_NOT_FOUND，retryable:false。
 *    service 层现状就是合并语义（不在 NotFoundError 内区分越权/不存在），本层保持不动，
 *    避免破坏对 HTTP 调用者的防存在性泄露。
 *  - ForbiddenError → 403 FORBIDDEN，retryable:false（能力级拒绝，与资源级 404 区分）。
 *  - ValidationError → 400 INVALID_INPUT，retryable:false。
 *  - 冲突类（版本/状态机冲突，ConflictError / AgentActionConflictError）→ 409，retryable:false。
 *
 * 已在 executePublicTool 顶层安全门处理的（404 UNKNOWN_PUBLIC_TOOL / 403 ROLE_FORBIDDEN /
 * 501 PUBLIC_TOOL_NOT_IMPLEMENTED / 500 FACADE_HANDLER_MISSING）不会进这里。
 *
 * agent 看到 retryable:false 不会盲目重试同 id；suggestedNextTool 在能稳定推断时给出
 * 对应 find_* 工具名，否则省略。
 */
function errorToOutcome(err: unknown): ExecutePublicToolOutcome {
  // 0. P1-3 UI 接线：NEEDS_USER_CONFIRMATION 单独先处理，透出 targetIntent。
  //    createAgentProposal 在抛该错误时已填好 targetIntent（= action.key），
  //    本层把它带到 outcome，再经 execute-public route 409 响应体传给 runtime。
  if (err instanceof AgentActionNeedsConfirmationError) {
    return {
      ok: false,
      error: err.message,
      status: 409,
      code: "NEEDS_USER_CONFIRMATION",
      retryable: false,
      ...(err.targetIntent ? { targetIntent: err.targetIntent } : {}),
    };
  }

  // 1. agent-action 层自有错误（已带 status/code）——直接透传。
  if (
    err instanceof AgentActionNotFoundError ||
    err instanceof AgentActionForbiddenError ||
    err instanceof AgentActionConflictError ||
    err instanceof AgentActionInputError ||
    err instanceof AgentActionError
  ) {
    // 把 404 / 403 / 409 语义规整到分层 code；400 保持 INVALID_INPUT。
    if (err instanceof AgentActionConflictError) {
      return { ok: false, error: err.message, status: 409, code: err.code || "STATE_CONFLICT", retryable: false };
    }
    if (err.status === 404) {
      return { ok: false, error: err.message, status: 404, code: "RESOURCE_NOT_FOUND", retryable: false };
    }
    if (err.status === 403) {
      return { ok: false, error: err.message, status: 403, code: "FORBIDDEN", retryable: false };
    }
    if (err.status === 400) {
      return { ok: false, error: err.message, status: 400, code: "INVALID_INPUT", retryable: false };
    }
    // P1-3：NEEDS_USER_CONFIRMATION（409）透传 code，retryable:false，message 保留。
    if (err.code === "NEEDS_USER_CONFIRMATION") {
      return { ok: false, error: err.message, status: 409, code: "NEEDS_USER_CONFIRMATION", retryable: false };
    }
    return { ok: false, error: err.message, status: err.status, code: err.code };
  }

  // 2. canonical service 层命名错误（ApplicationError 体系）——按语义翻译。
  if (err instanceof NotFoundError) {
    return { ok: false, error: err.message, status: 404, code: "RESOURCE_NOT_FOUND", retryable: false };
  }
  if (err instanceof ForbiddenError) {
    return { ok: false, error: err.message, status: 403, code: "FORBIDDEN", retryable: false };
  }
  if (err instanceof ConflictError) {
    return { ok: false, error: err.message, status: 409, code: "STATE_CONFLICT", retryable: false };
  }
  if (err instanceof ValidationError) {
    return { ok: false, error: err.message, status: 400, code: "INVALID_INPUT", retryable: false };
  }

  // 3. 兜底：未知错误不泄露内部细节。
  // 服务端记录原始错误（含 stack），对外返回固定通用消息（不透传 err.message，
  // 防止内部路径/SQL/敏感字段经模型回流给用户）。
  console.error("[public-executor] unhandled error in public tool", err);
  return {
    ok: false,
    error: "工具执行失败，请稍后重试或联系管理员",
    status: 500,
    code: "PUBLIC_TOOL_ERROR",
  };
}

// 保留命名导出便于测试 import 不被 tree-shake 警告。
export { getPublicToolManifestEntry };

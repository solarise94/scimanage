/**
 * Phase A: deterministic dynamic tool-bundle selector（§7.1）。
 *
 * 铁律（已拍板）：
 *  - 单轮 bundle ≤ 15 tools（MAX_TOOLS_PER_BUNDLE）。超限即抛错，不静默截断。
 *  - 初始 bootstrap 只给必要 discovery + 不依赖已有实体的新项目入口。
 *  - 按 actor role / 已选 ref / workspace / 上一结果 / 页面领域 确定性切换。
 *  - 硬过滤 implemented:false 的 manifest entry（绝不把 skeleton tool 发给模型）。
 *  - 没有任何"否则注入全部 primary"的分支。
 *
 * selector 只读可审计的运行时状态，不做自然语言意图分类、不猜模型工具。
 * 本模块零 Prisma。
 *
 * P2-4 边界声明（核对结论）：
 *  selector **不属于安全边界，不承担权限判断**。它只根据以下输入决定给模型看哪些工具：
 *    1. actor role（manifest.roles 投影 + REPRESENTATIVE/RM 专用 bundle）；
 *    2. 当前页面领域（pageDomain）；
 *    3. 当前 workflow 类型（activeWorkspaces.importSessionRef/bankFlowRef）；
 *    4. 上一 public result 的 mode（lastToolResult.kind：needs_selection/needs_user_input/result/proposal）；
 *    5. 已选实体类型（selectedRefs：customer/order/project/ticket/contract/invoice）。
 *  上述 role 过滤是"工具展示提示"，不是服务端权威权限事实——真正的授权（资源可见性、
 *  写权限、technical owner gate）100% 由 executePublicTool → internal action → canonical
 *  service 的 id AND actorScope gate 在执行时校验。即使 selector 误把某工具注入 bundle，
 *  service 层仍会 fail-closed 拒绝越权调用（返回 404/403）。
 */
import type { BusinessActor } from "@/lib/application/actor";
import { isRegionalManager, isRepresentative, isInternalStaff } from "@/lib/role-guards";
import {
  PUBLIC_TOOL_MANIFEST,
  getPublicToolManifestEntry,
  type PublicToolManifestEntry,
} from "./manifest";

export const MAX_TOOLS_PER_BUNDLE = 15;

/** 已选实体的类型集合（来自上一步结果或消息上下文）。 */
export type SelectedEntity =
  | "customer"
  | "order"
  | "project"
  | "ticket"
  | "contract"
  | "invoice";

export interface ActiveWorkspace {
  importSessionRef?: string;
  bankFlowRef?: string;
}

export interface LastToolResult {
  /** needs_selection / needs_user_input 触发只注入消费 options 的 contextual 工具。 */
  kind?: "needs_selection" | "needs_user_input" | "result" | "proposal";
  /** 上一结果涉及的实体类型。 */
  optionType?: SelectedEntity;
}

export interface BundleSelectionInput {
  actor: Pick<BusinessActor, "userId" | "role">;
  runId?: string | null;
  /** 当前 active workflow（import/bank-flow）。激活时只注入该 workflow 的 nextAction + 必要 context。 */
  activeWorkspaces?: ActiveWorkspace;
  /** 已持有的 capability ref 实体类型。 */
  selectedRefs?: SelectedEntity[];
  /** 上一工具结果。 */
  lastToolResult?: LastToolResult;
  /** 页面/动作卡领域（若可确定）。 */
  pageDomain?: SelectedEntity | "finance" | "crm";
  /** 当前用户请求内已自动执行的 hop 数。 */
  hopCount?: number;
}

export interface PublicToolSpec {
  name: string;
  description: string;
  input_schema: PublicToolManifestEntry["publicInput"];
  kind: PublicToolManifestEntry["kind"];
}

export interface BundleSelectionResult {
  tools: PublicToolSpec[];
  manifestVersion: number;
  /** selector 决策的可审计 hint（写日志，便于排查 bundle 异常）。 */
  reason: string;
}

/** 某角色是否允许该 entry。roles 为空 = 全角色可见。 */
function roleAllowed(entry: PublicToolManifestEntry, role: string): boolean {
  if (entry.roles.length === 0) return true;
  return (entry.roles as readonly string[]).includes(role);
}

/** implemented + role + exposure 过滤后的 candidate pool（按 exposure 分桶）。 */
function candidatePool(role: string): {
  primary: PublicToolManifestEntry[];
  contextual: PublicToolManifestEntry[];
  workflow: PublicToolManifestEntry[];
} {
  const primary: PublicToolManifestEntry[] = [];
  const contextual: PublicToolManifestEntry[] = [];
  const workflow: PublicToolManifestEntry[] = [];
  for (const entry of PUBLIC_TOOL_MANIFEST) {
    if (!entry.implemented) continue; // 硬过滤 skeleton
    if (!roleAllowed(entry, role)) continue;
    if (entry.exposure === "workflow_step") workflow.push(entry);
    else if (entry.exposure === "contextual") contextual.push(entry);
    else primary.push(entry);
  }
  return { primary, contextual, workflow };
}

function toSpec(entry: PublicToolManifestEntry): PublicToolSpec {
  return {
    name: entry.publicTool,
    description: entry.description,
    input_schema: entry.publicInput,
    kind: entry.kind,
  };
}

/** 去重插入；保持 manifest 顺序。 */
function pushUnique(out: PublicToolSpec[], entry: PublicToolManifestEntry | undefined): void {
  if (!entry) return;
  if (out.some((t) => t.name === entry.publicTool)) return;
  out.push(toSpec(entry));
}

function assertBundleLimit(tools: PublicToolSpec[], reason: string): void {
  if (tools.length > MAX_TOOLS_PER_BUNDLE) {
    throw new Error(
      `[bundle-selector] bundle exceeded limit: ${tools.length} > ${MAX_TOOLS_PER_BUNDLE} (reason=${reason}). ` +
        `This is a selector bug — primary tools must not be injected wholesale.`,
    );
  }
}

/**
 * 主选择函数。按 §7.1 优先级确定性返回 ≤15 工具的 bundle。
 */
export function selectToolBundle(input: BundleSelectionInput): BundleSelectionResult {
  const role = input.actor.role;
  const pool = candidatePool(role);

  // ── 1. REPRESENTATIVE bundle（最受限） ──
  // §4.4：仅 scoped find_orders（不含 financialView）、受限 get_order、find_contracts、get_contract。
  // 不含 get_invoice、模板、开票、回款、发票登记、合同 prepare/generate 或任何 finance workflow。
  if (isRepresentative(role)) {
    const tools: PublicToolSpec[] = [];
    pushUnique(tools, pool.primary.find((e) => e.publicTool === "find_orders"));
    pushUnique(tools, pool.primary.find((e) => e.publicTool === "get_order"));
    pushUnique(tools, pool.primary.find((e) => e.publicTool === "find_contracts"));
    pushUnique(tools, pool.primary.find((e) => e.publicTool === "get_contract"));
    assertBundleLimit(tools, "representative-bootstrap");
    return { tools, manifestVersion: 1, reason: "representative-scoped-read-only" };
  }

  // ── 2. active workflow（import/bank-flow）优先：只注入 nextAction + 必要 context + 确认链 ──
  if (input.activeWorkspaces?.importSessionRef) {
    const tools: PublicToolSpec[] = [];
    pushUnique(tools, getPublicToolManifestEntry("operate_order_import"));
    // 必要 context：find_orders/get_order（确认导入结果时可查）
    pushUnique(tools, pool.primary.find((e) => e.publicTool === "find_orders"));
    assertBundleLimit(tools, "active-import-workflow");
    return { tools, manifestVersion: 1, reason: "active-order-import-workflow" };
  }
  if (input.activeWorkspaces?.bankFlowRef) {
    const tools: PublicToolSpec[] = [];
    pushUnique(tools, getPublicToolManifestEntry("operate_bank_flow"));
    pushUnique(tools, pool.primary.find((e) => e.publicTool === "find_orders"));
    assertBundleLimit(tools, "active-bankflow-workflow");
    return { tools, manifestVersion: 1, reason: "active-bank-flow-workflow" };
  }

  // ── 3. needs_selection / needs_user_input：只注入消费 options 的 contextual 工具 ──
  if (input.lastToolResult?.kind === "needs_selection" || input.lastToolResult?.kind === "needs_user_input") {
    const tools: PublicToolSpec[] = [];
    // 按上一结果 optionType 注入对应领域 propose 工具（消费 selectedOptionId）。
    switch (input.lastToolResult.optionType) {
      case "customer":
        pushUnique(tools, pool.primary.find((e) => e.publicTool === "get_customer"));
        pushUnique(tools, pool.primary.find((e) => e.publicTool === "propose_follow_up"));
        pushUnique(tools, pool.primary.find((e) => e.publicTool === "prepare_order"));
        break;
      case "order":
        pushUnique(tools, pool.primary.find((e) => e.publicTool === "get_order"));
        pushUnique(tools, pool.primary.find((e) => e.publicTool === "propose_invoice"));
        pushUnique(tools, pool.primary.find((e) => e.publicTool === "prepare_contract"));
        pushUnique(tools, pool.primary.find((e) => e.publicTool === "link_order_project"));
        break;
      case "project":
        pushUnique(tools, pool.primary.find((e) => e.publicTool === "get_project"));
        pushUnique(tools, pool.primary.find((e) => e.publicTool === "propose_ticket"));
        break;
      case "invoice":
        pushUnique(tools, pool.primary.find((e) => e.publicTool === "get_invoice"));
        break;
      default:
        // 未知 optionType → 退回 bootstrap（但不全量 primary）。
        break;
    }
    if (tools.length === 0) {
      tools.push(...bootstrapBundle(pool, role));
    }
    assertBundleLimit(tools, "needs-selection");
    return { tools, manifestVersion: 1, reason: `needs-selection-${input.lastToolResult.optionType ?? "unknown"}` };
  }

  // ── 4. 已选实体 ref：注入该实体所属领域 bundle ──
  const selected = input.selectedRefs ?? [];
  if (selected.length > 0) {
    const tools: PublicToolSpec[] = [];
    // 始终带 bootstrap discovery（用户可能切换话题）。
    pushBootstrapDiscovery(tools, pool, role);
    for (const entity of dedupe(selected)) {
      switch (entity) {
        case "customer":
          pushUnique(tools, pool.primary.find((e) => e.publicTool === "get_customer"));
          pushUnique(tools, pool.primary.find((e) => e.publicTool === "propose_follow_up"));
          pushUnique(tools, pool.primary.find((e) => e.publicTool === "propose_visit_checkin"));
          pushUnique(tools, pool.primary.find((e) => e.publicTool === "prepare_order"));
          break;
        case "order":
          pushUnique(tools, pool.primary.find((e) => e.publicTool === "get_order"));
          pushUnique(tools, pool.primary.find((e) => e.publicTool === "propose_invoice"));
          pushUnique(tools, pool.primary.find((e) => e.publicTool === "prepare_contract"));
          pushUnique(tools, pool.primary.find((e) => e.publicTool === "link_order_project"));
          break;
        case "project":
          pushUnique(tools, pool.primary.find((e) => e.publicTool === "get_project"));
          pushUnique(tools, pool.primary.find((e) => e.publicTool === "find_tickets"));
          pushUnique(tools, pool.primary.find((e) => e.publicTool === "propose_ticket"));
          pushUnique(tools, pool.primary.find((e) => e.publicTool === "propose_project"));
          break;
        case "ticket":
          pushUnique(tools, pool.primary.find((e) => e.publicTool === "propose_ticket_reply"));
          break;
        case "contract":
          pushUnique(tools, pool.primary.find((e) => e.publicTool === "get_contract"));
          pushUnique(tools, pool.contextual.find((e) => e.publicTool === "list_contract_templates"));
          break;
        case "invoice":
          pushUnique(tools, pool.primary.find((e) => e.publicTool === "get_invoice"));
          break;
      }
    }
    // RM：剥离所有写工具（propose_*/prepare_*）。
    if (isRegionalManager(role)) stripWriteTools(tools);
    assertBundleLimit(tools, "selected-ref-domain");
    return { tools, manifestVersion: 1, reason: `domain-${dedupe(selected).join(",")}` };
  }

  // ── 5. pageDomain / 动作卡领域（无 ref 但领域明确） ──
  if (input.pageDomain) {
    const tools: PublicToolSpec[] = [];
    pushBootstrapDiscovery(tools, pool, role);
    switch (input.pageDomain) {
      case "crm":
        pushUnique(tools, pool.primary.find((e) => e.publicTool === "find_customers"));
        pushUnique(tools, pool.primary.find((e) => e.publicTool === "get_customer"));
        pushUnique(tools, pool.primary.find((e) => e.publicTool === "propose_follow_up"));
        break;
      case "order":
        pushUnique(tools, pool.primary.find((e) => e.publicTool === "find_orders"));
        pushUnique(tools, pool.primary.find((e) => e.publicTool === "get_order"));
        pushUnique(tools, pool.primary.find((e) => e.publicTool === "propose_invoice"));
        break;
      case "finance":
        pushUnique(tools, pool.primary.find((e) => e.publicTool === "get_invoice"));
        break;
      case "project":
        pushUnique(tools, pool.primary.find((e) => e.publicTool === "find_projects"));
        pushUnique(tools, pool.primary.find((e) => e.publicTool === "propose_project"));
        break;
      default:
        break;
    }
    if (isRegionalManager(role)) stripWriteTools(tools);
    assertBundleLimit(tools, "page-domain");
    return { tools, manifestVersion: 1, reason: `page-${input.pageDomain}` };
  }

  // ── 6. bootstrap（默认） ──
  const tools = bootstrapBundle(pool, role);
  assertBundleLimit(tools, "bootstrap");
  return { tools, manifestVersion: 1, reason: "bootstrap" };
}

function dedupe<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

/** 从 pool 取 discovery 工具子集（bootstrap 用）。 */
function pushBootstrapDiscovery(
  out: PublicToolSpec[],
  pool: ReturnType<typeof candidatePool>,
  role: string,
): void {
  pushUnique(out, pool.primary.find((e) => e.publicTool === "find_customers"));
  pushUnique(out, pool.primary.find((e) => e.publicTool === "find_projects"));
  pushUnique(out, pool.primary.find((e) => e.publicTool === "find_orders"));
  if (isRepresentative(role)) return; // REP bundle 在更早的分支已收敛
  if (isRegionalManager(role)) {
    // §4.4：RM bundle 含 financialView find_orders（已加）、get_order 完整财务摘要、
    // get_invoice、find_contracts、get_contract 与既有 CRM 读工具；无写工具。
    pushUnique(out, pool.primary.find((e) => e.publicTool === "get_invoice"));
    pushUnique(out, pool.primary.find((e) => e.publicTool === "find_contracts"));
    pushUnique(out, pool.primary.find((e) => e.publicTool === "get_contract"));
    return;
  }
  // 内部员工 bootstrap：加新项目/订单入口（写）。
  pushUnique(out, pool.primary.find((e) => e.publicTool === "prepare_order"));
  pushUnique(out, pool.primary.find((e) => e.publicTool === "propose_project"));
}

/** bootstrap bundle：discovery + 不依赖实体的新项目/订单入口。 */
function bootstrapBundle(
  pool: ReturnType<typeof candidatePool>,
  role: string,
): PublicToolSpec[] {
  const tools: PublicToolSpec[] = [];
  pushBootstrapDiscovery(tools, pool, role);
  return tools;
}

/** 移除所有写意图工具（propose、prepare 类），RM 专用。 */
function stripWriteTools(tools: PublicToolSpec[]): void {
  const writeKinds = new Set(["propose", "preview", "preview_then_confirm_generate", "workflow"]);
  // 只保留 discovery/context
  const filtered = tools.filter((t) => t.kind === "discovery" || t.kind === "context");
  tools.length = 0;
  tools.push(...filtered);
  void writeKinds; // 保留语义占位：当前按 kind 字段过滤，未直接用 writeKinds，避免误导。
}

/** 单次用户请求内自动 hop 上限。超过即停止自动链，返回当前 preview/draft。 */
export const MAX_AUTO_HOPS = 3;

/**
 * 自动 hop 准入判断（§7.1）：只有 discovery/context/preview-draft 可自动执行。
 * propose_*、createAgentProposal、任何终态业务写与 confirm 绝不在自动链中执行。
 */
export function isAutoHopEligible(kind: PublicToolManifestEntry["kind"]): boolean {
  return kind === "discovery" || kind === "context" || kind === "preview";
}

export { isInternalStaff };

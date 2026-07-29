/**
 * Phase A: 61 internal action → exposure 台账。
 *
 * 设计文档 §4.4 / §7 要求：所有 internal action（以及新增 action）都必须登记
 * exposure 归属（primary / contextual / workflow_step / internal / legacy），
 * 不得因 public 面收敛而静默丢能力。本台账是防回归的权威映射。
 *
 * - `level`：exposure 归类（见 ExposureLevel）。
 * - `publicTool`：该 action 被哪个 public facade 覆盖（可空 = 不直接面向模型，
 *   仅作为 internal 供其它 action/facade 调用）。
 * - `notes`：归类理由或迁移备注。
 *
 * 本模块零 Prisma。台账完整性由 assertAllActionsLedgered() 在运行期 + 测试断言守护。
 */
import type { AgentActionDefinition } from "../types";
import { listAgentActions } from "../registry";

export type ExposureLevel = "primary" | "contextual" | "workflow_step" | "internal" | "legacy";

export interface ExposureEntry {
  level: ExposureLevel;
  publicTool?: string;
  notes?: string;
}

/**
 * 全部 61 个既有 internal action 的 exposure 归属。
 * 新增 internal action 必须在此登记，否则 assertAllActionsLedgered() 抛错。
 *
 * 归类依据 docs/agent-tool-surface-simplification-design-2026-07-26.md §4.4：
 *  - crm.create_interaction → contextual（高频跟进记录）
 *  - crm.list_my_organizations / binding / customer application* → contextual（代表自助）
 *  - projects.add_note / get_notes / draft_from_text → contextual
 *  - tickets.update_status → contextual（status enum only）
 *  - orders.link_to_project → contextual（需 orderRef+projectRef，且技术负责人双匹配）
 *  - contracts.check_coverage → internal（prepare/generate 路径内调用）
 *  - contracts.list_templates → contextual（用户要换模板时返回 options）
 *  - bank-flow / import 细步 → workflow_step
 *  - agent.recall_memory / attachment detail → internal（运行时回退）
 *  - resolve/pinyin / finance_snapshot → legacy（已被 find_orders/get_order 收敛）
 */
export const ACTION_EXPOSURE: Record<string, ExposureEntry> = {
  // ── agent 域 ──
  "agent.recall_memory": { level: "internal", notes: "运行时记忆回退，不作为主意图工具注入" },
  "agent.inspect_attachments": { level: "workflow_step", publicTool: "inspect_attachment", notes: "附件工作流步骤" },
  "agent.get_attachment_detail": { level: "internal", notes: "verified attachment ref 内部解析" },

  // ── contracts 域 ──
  "contracts.check_coverage": { level: "internal", notes: "prepare/generate 路径内调用" },
  "contracts.prepare_draft": { level: "workflow_step", publicTool: "prepare_contract", notes: "preview_then_confirm_generate 链路 prepare 步" },
  "contracts.generate": { level: "workflow_step", publicTool: "prepare_contract", notes: "preview_then_confirm_generate 链路 confirm generate 步" },
  "contracts.get_detail": { level: "primary", publicTool: "get_contract" },
  "contracts.list_templates": { level: "contextual", publicTool: "list_contract_templates", notes: "用户要换模板时返回 options" },
  "contracts.list": { level: "primary", publicTool: "find_contracts" },

  // ── crm 域 ──
  "crm.search_customers": { level: "primary", publicTool: "find_customers" },
  "crm.resolve_customer_name": { level: "legacy", publicTool: "find_customers", notes: "折叠进 find_customers；保留 resolution 契约" },
  "crm.search_customers_by_pinyin": { level: "legacy", publicTool: "find_customers", notes: "折叠进 find_customers" },
  "crm.get_customer_context": { level: "primary", publicTool: "get_customer" },
  "crm.create_followup_task": { level: "workflow_step", publicTool: "propose_follow_up", notes: "propose 链 confirm 步" },
  "crm.prepare_visit_checkin": { level: "workflow_step", publicTool: "propose_visit_checkin", notes: "prepare 步" },
  "crm.create_visit_checkin": { level: "workflow_step", publicTool: "propose_visit_checkin", notes: "confirm 步" },
  "crm.create_interaction": { level: "contextual", notes: "高频跟进记录；happenedAt 服务端默认" },
  "crm.list_my_organizations": { level: "contextual", notes: "代表自助" },
  "crm.request_organization_binding": { level: "contextual", notes: "代表自助" },
  "crm.submit_customer_application": { level: "contextual", notes: "代表自助" },
  "crm.list_my_customer_applications": { level: "contextual", notes: "代表自助" },

  // ── finance 域 ──
  "finance.prepare_invoice_draft": { level: "workflow_step", publicTool: "propose_invoice", notes: "订单开票 confirm action" },
  "finance.match_payment": { level: "workflow_step", publicTool: "propose_receipt", notes: "回款匹配 → propose 链只读步" },
  "finance.create_receipt": { level: "workflow_step", publicTool: "propose_receipt", notes: "回款 confirm 步" },
  "finance.get_invoice_detail": { level: "primary", publicTool: "get_invoice" },
  "finance.analyze_invoice_file": { level: "workflow_step", publicTool: "propose_invoice_registration", notes: "analyse → register 链" },
  "finance.register_issued_invoice": { level: "workflow_step", publicTool: "propose_invoice_registration", notes: "register confirm 步" },
  "finance.get_invoice_staging_context": { level: "workflow_step", publicTool: "propose_invoice_registration", notes: "P0-4：facade 上下文供给，解析 staging sha256/version（owner gate 在内）" },
  "finance.adopt_agent_attachment_as_invoice": { level: "workflow_step", publicTool: "propose_invoice_registration" },
  "finance.plan_project_invoice_requests": { level: "workflow_step", publicTool: "propose_invoice", notes: "项目开票 plan 只读 → submit" },
  "finance.submit_invoice_request": { level: "workflow_step", publicTool: "propose_invoice", notes: "项目开票 confirm 步" },
  "finance.analyze_bank_flow_file": { level: "workflow_step", publicTool: "start_bank_flow" },
  "finance.apply_bank_flow_mapping": { level: "workflow_step", publicTool: "operate_bank_flow" },
  "finance.match_bank_flow_rows": { level: "workflow_step", publicTool: "operate_bank_flow" },
  "finance.get_bank_flow_row": { level: "workflow_step", publicTool: "operate_bank_flow" },
  "finance.update_bank_flow_selection": { level: "workflow_step", publicTool: "operate_bank_flow" },
  "finance.reopen_bank_flow_rows": { level: "workflow_step", publicTool: "operate_bank_flow" },
  "finance.confirm_bank_flow_batch": { level: "workflow_step", publicTool: "operate_bank_flow", notes: "confirm 步" },
  "finance.ocr_bank_flow_receipts": { level: "workflow_step", publicTool: "operate_bank_flow" },
  "finance.get_bank_flow_workspace_state": { level: "workflow_step", publicTool: "operate_bank_flow", notes: "P0-3：facade 上下文供给，读 workspace version/phase" },

  // ── orders 域 ──
  "orders.search": { level: "primary", publicTool: "find_orders", notes: "financialView=any 走此口径" },
  "orders.list_pending_receipts": { level: "legacy", publicTool: "find_orders", notes: "被 find_orders(financialView=pending_receipt) 收敛" },
  "orders.find_with_financial_view": { level: "primary", publicTool: "find_orders", notes: "Phase B 新增：public find_orders 的内部 action，调 canonical queryOrderReceivables + listPendingReceiptOrders" },
  "orders.prepare_draft": { level: "workflow_step", publicTool: "prepare_order", notes: "Phase C：order draft canonical service 入口（facade 经此调度）" },
  "orders.get_draft": { level: "workflow_step", publicTool: "propose_order", notes: "Phase C：草稿只读校验" },
  "orders.create_from_draft": { level: "workflow_step", publicTool: "propose_order", notes: "Phase C：草稿确认落单（lifecycle 锁定+consume）" },
  "orders.get_finance_snapshot": { level: "legacy", notes: "并入 get_order 详情；待回款清单走 financialView" },
  "orders.link_to_project": { level: "contextual", publicTool: "link_order_project", notes: "需 orderRef+projectRef，技术负责人双匹配" },
  "orders.create": { level: "workflow_step", publicTool: "propose_order", notes: "由 order draft → propose → confirm 链消费" },
  "orders.get_detail": { level: "primary", publicTool: "get_order" },
  "orders.analyze_import_file": { level: "workflow_step", publicTool: "start_order_import" },
  "orders.apply_import_column_mapping": { level: "workflow_step", publicTool: "operate_order_import" },
  "orders.get_import_row": { level: "workflow_step", publicTool: "operate_order_import" },
  "orders.update_import_row_draft": { level: "workflow_step", publicTool: "operate_order_import" },
  "orders.import_order_row": { level: "workflow_step", publicTool: "operate_order_import", notes: "confirm 步" },
  "orders.skip_import_row": { level: "workflow_step", publicTool: "operate_order_import", notes: "confirm 步" },
  "orders.resume_import_session": { level: "workflow_step", publicTool: "operate_order_import" },
  "orders.get_import_staging_context": { level: "workflow_step", publicTool: "start_order_import", notes: "P0-2：facade 上下文供给，解析 staging sha256/version" },

  // ── projects 域 ──
  "projects.search": { level: "primary", publicTool: "find_projects" },
  "projects.get_summary": { level: "primary", publicTool: "get_project" },
  "projects.add_note": { level: "contextual", notes: "对话点名备注时" },
  "projects.get_notes": { level: "contextual", notes: "对话点名备注时" },
  "projects.draft_from_text": { level: "contextual", notes: "对话点名草稿时" },
  "projects.create": { level: "workflow_step", publicTool: "propose_project", notes: "confirm 步" },

  // ── tickets 域 ──
  "tickets.create_from_text": { level: "workflow_step", publicTool: "propose_ticket", notes: "confirm 步" },
  "tickets.update_status": { level: "contextual", notes: "status enum only" },
  "tickets.reply": { level: "workflow_step", publicTool: "propose_ticket_reply", notes: "confirm 步" },
  "tickets.list": { level: "primary", publicTool: "find_tickets" },
};

/**
 * 校验：注册表里每个 action 都必须在本台账有归属。
 * 缺一个即抛错（测试断言 + 运行期 selector 调用前自检）。
 *
 * 反向（台账里多了不存在的 action）不在此校验 —— 因为 Phase A manifest 先登记
 * 占位 entry（publicTool 尚未实现），这些 entry 引用的 internal action 必须存在，
 * 但台账允许包含尚未注册的新增 action（如 orders.find_with_financial_view 在 Phase B 才注册）。
 */
export function assertAllActionsLedgered(): void {
  const actions = listAgentActions();
  const missing: string[] = [];
  for (const action of actions) {
    if (!ACTION_EXPOSURE[action.key]) {
      missing.push(action.key);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `[exposure-ledger] ${missing.length} action(s) missing exposure entry: ${missing.sort().join(", ")}`,
    );
  }
}

/**
 * 返回某 action 的 exposure entry；未登记返回 null（不抛错，便于 selector 容错）。
 */
export function getActionExposure(actionKey: string): ExposureEntry | null {
  return ACTION_EXPOSURE[actionKey] ?? null;
}

/** 仅供测试：按 level 分组统计（便于断言各档数量）。 */
export function countExposureByLevel(): Record<ExposureLevel, number> {
  const counts: Record<ExposureLevel, number> = {
    primary: 0,
    contextual: 0,
    workflow_step: 0,
    internal: 0,
    legacy: 0,
  };
  for (const entry of Object.values(ACTION_EXPOSURE)) {
    counts[entry.level] += 1;
  }
  return counts;
}

// 保留对 AgentActionDefinition 类型的引用（避免未使用 import lint）。
export type { AgentActionDefinition };

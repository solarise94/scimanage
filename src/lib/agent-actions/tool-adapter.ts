import type { AgentActionDefinition, AgentActionPresentation, AgentToolDefinition } from "./types";

export function actionToTool(action: AgentActionDefinition<unknown, unknown>): AgentToolDefinition {
  return {
    name: action.key,
    description: action.description,
    input_schema: action.inputSchema,
    presentation: action.presentation,
  };
}

const MINIMAL_PROPOSAL_NARRATION =
  "已生成待确认操作，具体字段已由业务卡片展示。"
  + "请只提醒用户确认；禁止复述 proposal 或卡片字段，禁止补充未由工具证明的业务结论。";

const MINIMAL_RESULT_NARRATION =
  "工具结果已由业务卡片展示。"
  + "禁止复述卡片字段与金额；禁止推断未返回的业务结论（如待回款、交付状态、订单草稿等）。"
  + "正文可为空；最多一句下一步建议。";

/**
 * Action-specific fixed narration for card/minimal results.
 * Prefer deterministic constraints over letting the model invent conclusions.
 */
export function buildActionSpecificMinimalNarration(
  actionKey: string,
  result: unknown,
): string | null {
  switch (actionKey) {
    case "orders.get_finance_snapshot":
      return (
        "订单财务摘要已由业务卡片展示。"
        + "卡片「未结清」=已开票−已回款，不代表待回款；"
        + "待回款必须另调 orders.list_pending_receipts 查询。"
        + "禁止复述卡片数字，禁止推断交付或其他未返回字段；正文可为空。"
      );
    case "orders.list_pending_receipts": {
      const items = result && typeof result === "object" && Array.isArray((result as { items?: unknown }).items)
        ? (result as { items: unknown[] }).items
        : [];
      if (items.length === 0) {
        return "待回款列表已展示：当前无待回款订单。不要编造欠款金额；正文可为空。";
      }
      const truncated = result && typeof result === "object" && (result as { truncated?: unknown }).truncated === true;
      return (
        `待回款列表已展示（${items.length} 笔${truncated ? "，可能未扫全" : ""}）。`
        + "禁止复述卡片字段与金额；正文可为空或一句下一步。"
      );
    }
    case "finance.get_invoice_detail":
      return (
        "发票详情已由业务卡片展示。"
        + "禁止复述卡片字段与金额；禁止推断未返回的业务结论；正文可为空。"
      );
    case "orders.get_detail":
      return (
        "订单详情已由业务卡片展示。"
        + "禁止复述卡片字段；订单状态以卡片为准，不要另推交付或回款结论；正文可为空。"
      );
    default:
      return null;
  }
}

/**
 * Shared instruction used by both the Pi tool adapter and the legacy summarizer.
 * When `actionKey`/`result` are provided, prefers action-specific fixed narration.
 */
export function buildCardToolNarration(
  presentation: AgentActionPresentation | undefined,
  mode: "result" | "proposal",
  opts?: { actionKey?: string; result?: unknown },
) {
  if (presentation?.type !== "card" || presentation.narration !== "minimal") return null;
  if (mode === "proposal") return MINIMAL_PROPOSAL_NARRATION;
  if (opts?.actionKey) {
    const fixed = buildActionSpecificMinimalNarration(opts.actionKey, opts.result);
    if (fixed) return fixed;
  }
  return MINIMAL_RESULT_NARRATION;
}

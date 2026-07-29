/**
 * CRM 客户上下文 follow-up 共享逻辑。
 *
 * 从 chat/route.ts 和 chat-stream/route.ts 提取，消除 ~160 行完整重复。
 * 当搜索/解析返回唯一客户时，自动追加 get_customer_context 调用。
 */

const CRM_CUSTOMER_CONTEXT_TRIGGER_KEYS = new Set([
  "crm.search_customers",
  "crm.resolve_customer_name",
  "crm.search_customers_by_pinyin",
]);

export function shouldFollowCrmCustomerContext(actionKey: string): boolean {
  return CRM_CUSTOMER_CONTEXT_TRIGGER_KEYS.has(actionKey);
}

/**
 * 从工具执行结果中提取唯一客户的 profileId。
 * - search_customers: 仅 items.length === 1 时提取
 * - resolve_customer_name / search_customers_by_pinyin: 仅 resolution === "UNIQUE" 时提取
 */
export function extractCrmFollowUpProfileId(actionKey: string, result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const output = result as Record<string, unknown>;

  if (actionKey === "crm.search_customers") {
    const items = Array.isArray(output.items) ? output.items : [];
    if (items.length !== 1) return null;
    const hit = items[0];
    if (!hit || typeof hit !== "object") return null;
    const profileId = (hit as Record<string, unknown>).profileId;
    return typeof profileId === "string" && profileId ? profileId : null;
  }

  if (actionKey === "crm.resolve_customer_name" || actionKey === "crm.search_customers_by_pinyin") {
    const resolution = typeof output.resolution === "string" ? output.resolution : "";
    if (resolution !== "UNIQUE") return null;
    const candidates = Array.isArray(output.candidates) ? output.candidates : [];
    const first = candidates[0];
    if (!first || typeof first !== "object") return null;
    const profileId = (first as Record<string, unknown>).profileId;
    return typeof profileId === "string" && profileId ? profileId : null;
  }

  return null;
}

import type { AgentTimelineItem } from "./types";

type CustomerRef = {
  profileId: string;
  name: string;
  organization: string | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function unwrapToolResult(output: unknown): Record<string, unknown> | null {
  const outer = asRecord(output);
  if (!outer) return null;
  const details = asRecord(outer.details);
  const detailsResult = details ? asRecord(details.result) : null;
  if (detailsResult) return detailsResult;
  const result = asRecord(outer.result);
  return result ?? outer;
}

function toCustomerRef(value: unknown): CustomerRef | null {
  const item = asRecord(value);
  const profileId = typeof item?.profileId === "string" ? item.profileId.trim() : "";
  if (!profileId) return null;
  const nameValue = item?.customerName ?? item?.name;
  return {
    profileId,
    name: typeof nameValue === "string" && nameValue.trim() ? nameValue.trim() : "未命名客户",
    organization: typeof item?.organization === "string" && item.organization.trim()
      ? item.organization.trim()
      : null,
  };
}

/**
 * Preserve only scope-checked CRM identities from persisted tool timelines.
 * Assistant prose intentionally omits internal IDs, but later turns still need
 * the exact profileId to resolve a user's natural-language disambiguation.
 */
export function buildVerifiedCustomerHistoryContext(timeline: AgentTimelineItem[] | undefined): string {
  if (!timeline?.length) return "";

  const customers = new Map<string, CustomerRef>();
  for (const item of timeline) {
    if (item.kind !== "tool" || item.status !== "done" || !item.toolName.startsWith("crm.")) continue;
    const output = unwrapToolResult(item.output);
    if (!output) continue;

    const collections = [output.items, output.candidates];
    for (const collection of collections) {
      if (!Array.isArray(collection)) continue;
      for (const candidate of collection) {
        const ref = toCustomerRef(candidate);
        if (ref) customers.set(ref.profileId, ref);
      }
    }

    const direct = toCustomerRef(output);
    if (direct) customers.set(direct.profileId, direct);
  }

  if (customers.size === 0) return "";
  const lines = [...customers.values()].slice(0, 20).map((customer) => (
    `- ${customer.name}${customer.organization ? `（${customer.organization}）` : ""} | profileId: ${customer.profileId}`
  ));
  return [
    "[已由服务端工具验证的 CRM 客户候选，仅供后续工具调用]",
    ...lines,
    "约束：用户后续用姓名或机构确认候选时，必须原样复用对应 profileId；不得生成、猜测或改写 ID。",
  ].join("\n");
}

export function appendVerifiedCustomerHistoryContext(
  content: string,
  timeline: AgentTimelineItem[] | undefined,
): string {
  const context = buildVerifiedCustomerHistoryContext(timeline);
  return context ? `${content}\n\n${context}` : content;
}

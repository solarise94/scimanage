/**
 * Agent UI 卡片 props 运行时 schema 校验（H7 可观测性增强）。
 *
 * 注意：这是运行时可观测性层，不是完整的 discriminated union 类型安全重构。
 * AgentUiDescriptor.props 仍为 Record<string, unknown>。
 * 完整类型安全（28 个 UI 类型的 discriminated union + 卡片接收类型化 props）需要独立 PR。
 *
 * 当前能力：
 * - 11 个高频卡片类型有 zod schema（其余跳过校验）
 * - 所有环境 console.error 报告缺失的必需字段
 * - 不阻断渲染（返回原始 props）
 */
import { z } from "zod";
import type { AgentUiType } from "./agent-ui-types";

// ─── 各卡片 props schema ───

const crmCustomerListProps = z.object({
  items: z.array(z.object({
    profileId: z.string(),
    name: z.string().nullish(),
  })),
}).passthrough();

const crmCustomerDetailProps = z.object({
  profileId: z.string(),
  customerName: z.string().nullish(),
}).passthrough();

const crmCustomerChoiceProps = z.object({
  items: z.array(z.object({
    profileId: z.string(),
    customerName: z.string(),
  })),
}).passthrough();

const crmInteractionDraftProps = z.object({
  customerName: z.string(),
  profileId: z.string().nullish(),
}).passthrough();

const orderCreateDraftProps = z.object({
  customerName: z.string(),
  title: z.string().nullish(),
}).passthrough();

const financeReceiptDraftProps = z.object({
  organizationName: z.string(),
  amountYuan: z.number().nullish(),
}).passthrough();

const ticketCreateDraftProps = z.object({
  projectName: z.string(),
  title: z.string().nullish(),
}).passthrough();

const ticketReplyDraftProps = z.object({
  ticketTitle: z.string(),
}).passthrough();

const ticketStatusUpdateProps = z.object({
  ticketTitle: z.string(),
}).passthrough();

const projectCreateDraftProps = z.object({
  customerName: z.string().nullish(),
  title: z.string().nullish(),
}).passthrough();

const crmCheckinResultProps = z.object({
  profileId: z.string().nullish(),
}).passthrough();

// ─── 注册表 ───

const PROP_SCHEMAS: Partial<Record<AgentUiType, z.ZodType>> = {
  "crm.customer-list": crmCustomerListProps,
  "crm.customer-detail": crmCustomerDetailProps,
  "crm.customer-choice": crmCustomerChoiceProps,
  "crm.interaction-draft": crmInteractionDraftProps,
  "crm.checkin-result": crmCheckinResultProps,
  "orders.create-draft": orderCreateDraftProps,
  "finance.receipt-draft": financeReceiptDraftProps,
  "tickets.create-draft": ticketCreateDraftProps,
  "tickets.reply-draft": ticketReplyDraftProps,
  "tickets.status-update": ticketStatusUpdateProps,
  "projects.create-draft": projectCreateDraftProps,
};

/**
 * 在 adapter 边界验证 props。
 * 验证失败时 log warning（不阻断渲染），返回 safeParse 结果供调用方决策。
 */
export function validateAgentUiProps(
  uiType: AgentUiType,
  props: Record<string, unknown>,
): { valid: boolean; warnings: string[] } {
  const schema = PROP_SCHEMAS[uiType];
  if (!schema) return { valid: true, warnings: [] };

  const result = schema.safeParse(props);
  if (result.success) return { valid: true, warnings: [] };

  const warnings = result.error.issues.map(
    (issue) => `[AgentUI:${uiType}] props.${issue.path.join(".")}: ${issue.message}`,
  );
  return { valid: false, warnings };
}

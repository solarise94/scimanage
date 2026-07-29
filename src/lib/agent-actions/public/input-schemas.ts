/**
 * Phase A P1-1：public tool 输入严格校验 schema（单一事实源：执行器授权层）。
 *
 * 设计目标（docs/agent-public-surface-cleanup-plan-2026-07-26.md §六 P1-1）：
 *  - 每个 public tool 一个 Zod schema，全部 `.strict()`（拒未知字段）；
 *  - executor 在调用 facade 前 `safeParse`，失败返回 400 INVALID_PUBLIC_INPUT
 *    + 中文可读消息（含字段路径与期望），retryable:false；
 *  - id 类字段：`z.string().min(1)`（拒空字符串）；可选 id 用 `.optional()`；
 *  - 文本类：`z.string().min(1).max(上限)`；
 *  - 金额类：`z.number().positive().max(MAX_AMOUNT_YUAN)`
 *    （与 order-drafts MAX_UNIT_PRICE_YUAN=10_000_000 口径一致）；
 *  - 枚举类：`z.enum([...])`，取值以 manifest JSON Schema 与 facade 实现为准；
 *  - 数组类：`z.array(z.string().min(1)).min(1).max(50)`；
 *  - propose_invoice 必须 orderId XOR projectId（用 `.refine()`）。
 *
 * 与 manifest 的关系：manifest 的 `publicInput` JSON Schema 是给模型的
 * 提示（含丰富中文 description），本文件是执行器授权层的权威约束。
 * 两者由 `tests/public-input-schemas.test.ts` 的 parity 测试守护
 * （properties key 集 + required 集一致，防漂移）。
 *
 * 本模块零 Prisma（仅 Zod，无任何业务模型访问）。
 */
import { z } from "zod";

// ── 共享约束（与 canonical service 既有口径一致） ──

/** 金额上限：与 order-drafts MAX_UNIT_PRICE_YUAN=10_000_000 口径一致（1000 万元）。 */
export const MAX_PUBLIC_AMOUNT_YUAN = 10_000_000;

/** id 类字段：非空字符串。授权由 canonical service scope gate 校验，不在此做格式断言。 */
const idField = z.string().min(1);

/** 可选 id 字段。 */
const optionalIdField = z.string().min(1).optional();

/** 通用文本上限：参照 CRM/工单 facade 的 title/text/content 字段现状。 */
const TEXT_MAX = 2000;
/** 长文本上限：备注/回复正文等可能较长。 */
const LONG_TEXT_MAX = 5000;

const textField = z.string().min(1).max(TEXT_MAX);
const longTextField = z.string().min(1).max(LONG_TEXT_MAX);

/** 金额（元）：正数且不超过 MAX_PUBLIC_AMOUNT_YUAN。 */
const amountYuanField = z.number().positive().max(MAX_PUBLIC_AMOUNT_YUAN);

/** ordered order ids 数组：至少 1 个，最多 50 个。 */
const orderIdsField = z.array(idField).min(1).max(50);

// ── Always-available discovery / context ──

export const FIND_CUSTOMERS_INPUT = z
  .object({
    query: textField,
    stage: z.enum(["PROSPECT", "ACTIVE", "DORMANT", "LOST"]).optional(),
  })
  .strict();

export const GET_CUSTOMER_INPUT = z
  .object({
    customerId: idField,
  })
  .strict();

export const FIND_PROJECTS_INPUT = z
  .object({
    // manifest 未列具体 enum 值（业务状态 enum），facade 直传 service；保持 string 不强约束枚举。
    query: z.string().min(1).max(TEXT_MAX).optional(),
    status: z.string().min(1).max(64).optional(),
  })
  .strict();

export const GET_PROJECT_INPUT = z
  .object({
    projectId: idField,
  })
  .strict();

export const FIND_ORDERS_INPUT = z
  .object({
    query: z.string().min(1).max(TEXT_MAX).optional(),
    status: z.string().min(1).max(64).optional(),
    financialView: z.enum(["any", "pending_receipt", "settled"]).optional(),
  })
  .strict();

export const GET_ORDER_INPUT = z
  .object({
    orderId: idField,
  })
  .strict();

export const FIND_TICKETS_INPUT = z
  .object({
    projectId: idField,
    status: z.string().min(1).max(64).optional(),
  })
  .strict();

export const FIND_CONTRACTS_INPUT = z
  .object({
    orderId: optionalIdField,
    customerId: optionalIdField,
    status: z.string().min(1).max(64).optional(),
  })
  .strict()
  // facade 现状：orderId / customerId 至少提供一个（否则 contracts.list 无过滤条件）。
  .refine((input) => Boolean(input.orderId) || Boolean(input.customerId), {
    message: "orderId 与 customerId 至少提供一个（不能都为空）",
    path: ["orderId"],
  });

export const GET_CONTRACT_INPUT = z
  .object({
    contractId: idField,
  })
  .strict();

export const GET_INVOICE_INPUT = z
  .object({
    invoiceId: idField,
  })
  .strict();

export const LIST_CONTRACT_TEMPLATES_INPUT = z
  .object({
    category: z.string().min(1).max(64).optional(),
  })
  .strict();

// ── Propose / preview ──

export const PREPARE_ORDER_INPUT = z
  .object({
    customerId: idField,
  })
  .strict();

export const PROPOSE_ORDER_INPUT = z
  .object({
    orderDraftId: idField,
  })
  .strict();

export const PROPOSE_PROJECT_INPUT = z
  .object({
    name: z.string().min(1).max(TEXT_MAX),
    budgetAmountYuan: amountYuanField.optional(),
  })
  .strict();

export const PROPOSE_TICKET_INPUT = z
  .object({
    projectId: idField,
    text: longTextField,
  })
  .strict();

export const PROPOSE_TICKET_REPLY_INPUT = z
  .object({
    ticketId: idField,
    content: longTextField,
  })
  .strict();

export const PROPOSE_FOLLOW_UP_INPUT = z
  .object({
    customerId: idField,
    title: z.string().min(1).max(TEXT_MAX),
    taskType: z.enum(["CONTACT", "VISIT", "OTHER"]).optional(),
    dueAt: z.string().min(1).max(64).optional(),
  })
  .strict();

export const PROPOSE_VISIT_CHECKIN_INPUT = z
  .object({
    customerId: idField,
  })
  .strict();

/**
 * propose_invoice：orderId XOR projectId（不能同时、不能都无）。
 * facade 现状：orderId 优先；都无 → 需求错误（facade 返回 needsUserInput）。
 * 严格校验层在 executor 拒绝，给模型可操作错误。
 */
export const PROPOSE_INVOICE_INPUT = z
  .object({
    orderId: optionalIdField,
    projectId: optionalIdField,
    amountYuan: amountYuanField.optional(),
    // manifest 未列具体 enum 值（可选票种 enum），facade 直传 service；保持 string 不强约束枚举。
    invoiceType: z.string().min(1).max(64).optional(),
    // 项目路径：多张可执行计划时，用户选定一张后用其 planKey 重新调用（与 projectId 一起）。
    planKey: z.string().min(1).max(64).optional(),
  })
  .strict()
  .refine(
    (input) => Boolean(input.orderId) !== Boolean(input.projectId),
    {
      message: "orderId 与 projectId 必须二选一（不能同时提供，也不能都不提供）",
      path: ["orderId"],
    },
  );

export const PROPOSE_RECEIPT_INPUT = z
  .object({
    organizationId: idField,
    amountYuan: amountYuanField,
    selectedOptionId: optionalIdField,
    receivedAt: z.string().min(1).max(64).optional(),
  })
  .strict();

export const PREPARE_CONTRACT_INPUT = z
  .object({
    orderIds: orderIdsField,
    templateOptionId: optionalIdField,
    sellerOptionId: optionalIdField,
  })
  .strict();

export const PROPOSE_INVOICE_REGISTRATION_INPUT = z
  .object({
    attachmentId: idField,
    selectedOptionId: optionalIdField,
  })
  .strict();

// ── contextual 写 ──

export const LINK_ORDER_PROJECT_INPUT = z
  .object({
    orderId: idField,
    projectId: idField,
  })
  .strict();

// ── workflow ──

export const START_ORDER_IMPORT_INPUT = z
  .object({
    stagingFileId: idField,
  })
  .strict();

export const OPERATE_ORDER_IMPORT_INPUT = z
  .object({
    sessionId: idField,
    operation: z.enum([
      "apply_column_mapping",
      "get_row",
      "update_row_draft",
      "commit_row",
      "skip_row",
      "resume",
    ]),
    rowId: optionalIdField,
    selectedOptionId: optionalIdField,
    columnMapping: z.record(z.string().min(1).max(TEXT_MAX), z.string().min(1).max(TEXT_MAX)).optional(),
    rowPatch: z.record(z.string().min(1).max(LONG_TEXT_MAX), z.string().max(LONG_TEXT_MAX)).optional(),
  })
  .strict();

export const START_BANK_FLOW_INPUT = z
  .object({
    stagingFileId: idField,
  })
  .strict();

export const OPERATE_BANK_FLOW_INPUT = z
  .object({
    workspaceId: idField,
    operation: z.enum([
      "apply_bank_flow_mapping",
      "match_bank_flow_rows",
      "get_bank_flow_row",
      "update_bank_flow_selection",
      "reopen_bank_flow_rows",
      "ocr_bank_flow_receipts",
      "confirm_bank_flow_batch",
    ]),
    rowIndex: z.number().int().min(0).nonnegative().optional(),
    selectedOptionId: optionalIdField,
    combinationIndex: z.number().int().min(0).optional(),
    skip: z.boolean().optional(),
    rowIndices: z.array(z.number().int().min(0)).min(1).max(500).optional(),
    stagingFileIds: z.array(idField).min(1).max(20).optional(),
    mapping: z
      .object({
        payerName: z.string().min(1).max(TEXT_MAX),
        amount: z.string().min(1).max(TEXT_MAX),
        date: z.string().min(1).max(TEXT_MAX).optional(),
        remark: z.string().min(1).max(TEXT_MAX).optional(),
        payerAccount: z.string().min(1).max(TEXT_MAX).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const INSPECT_ATTACHMENT_INPUT = z
  .object({
    attachmentId: idField,
  })
  .strict();

// ── 索引：publicToolKey → Zod schema（执行器授权层单一事实源） ──

export const PUBLIC_INPUT_SCHEMAS: Record<string, z.ZodType> = {
  find_customers: FIND_CUSTOMERS_INPUT,
  get_customer: GET_CUSTOMER_INPUT,
  find_projects: FIND_PROJECTS_INPUT,
  get_project: GET_PROJECT_INPUT,
  find_orders: FIND_ORDERS_INPUT,
  get_order: GET_ORDER_INPUT,
  find_tickets: FIND_TICKETS_INPUT,
  find_contracts: FIND_CONTRACTS_INPUT,
  get_contract: GET_CONTRACT_INPUT,
  get_invoice: GET_INVOICE_INPUT,
  list_contract_templates: LIST_CONTRACT_TEMPLATES_INPUT,
  prepare_order: PREPARE_ORDER_INPUT,
  propose_order: PROPOSE_ORDER_INPUT,
  propose_project: PROPOSE_PROJECT_INPUT,
  propose_ticket: PROPOSE_TICKET_INPUT,
  propose_ticket_reply: PROPOSE_TICKET_REPLY_INPUT,
  propose_follow_up: PROPOSE_FOLLOW_UP_INPUT,
  propose_visit_checkin: PROPOSE_VISIT_CHECKIN_INPUT,
  propose_invoice: PROPOSE_INVOICE_INPUT,
  propose_receipt: PROPOSE_RECEIPT_INPUT,
  prepare_contract: PREPARE_CONTRACT_INPUT,
  propose_invoice_registration: PROPOSE_INVOICE_REGISTRATION_INPUT,
  link_order_project: LINK_ORDER_PROJECT_INPUT,
  start_order_import: START_ORDER_IMPORT_INPUT,
  operate_order_import: OPERATE_ORDER_IMPORT_INPUT,
  start_bank_flow: START_BANK_FLOW_INPUT,
  operate_bank_flow: OPERATE_BANK_FLOW_INPUT,
  inspect_attachment: INSPECT_ATTACHMENT_INPUT,
};

/**
 * 取某 public tool 的 Zod schema；不存在返回 undefined（执行器视为无 schema 约束，
 * 由既有 object-shape 兜底检查处理）。
 */
export function getPublicInputSchema(publicToolKey: string): z.ZodType | undefined {
  return PUBLIC_INPUT_SCHEMAS[publicToolKey];
}

// ── 中文可读错误消息构造 ──

/**
 * 把 Zod issue path + code + 期望信息翻成「给认证 agent 的可操作中文消息」。
 *
 * 输出形如：
 *  - "参数 customerId 缺失或为空字符串（期望非空字符串）"
 *  - "参数 amountYuan 非法（期望正数且 <= 10000000）"
 *  - "未知字段 foo（允许的字段：orderId, projectId）"
 *  - "参数 status 非法（期望枚举值之一：any, pending_receipt, settled）"
 *  - "orderId 与 projectId 必须二选一（不能同时提供，也不能都不提供）"
 */
export function formatZodIssueMessage(
  schema: z.ZodType,
  issue: z.ZodIssue,
): string {
  // refine 自定义消息（如 propose_invoice XOR、find_contracts 至少一个）→ 直接用。
  if (issue.code === "custom" && typeof issue.message === "string" && issue.message.trim()) {
    return issue.message;
  }

  const pathStr = issue.path.length > 0 ? issue.path.join(".") : "(根)";

  // 未知字段（strict 模式触发）。
  if (issue.code === "unrecognized_keys") {
    const keys = issue.keys.map((k) => String(k)).join(", ");
    const allowed = describeAllowedKeys(schema);
    return `未知字段 ${keys}（不允许；${allowed}）`;
  }

  if (issue.code === "invalid_type") {
    const expected = String(issue.expected);
    // zod v4 issue 不携带 received 字段；undefined path + invalid_type 在中文里
    // 表达为「缺失」，其它表达为「类型非法」。
    const isMissing = issue.path.length > 0 && issue.message.toLowerCase().includes("undefined");
    if (expected === "string") {
      return isMissing
        ? `参数 ${pathStr} 缺失（期望非空字符串）`
        : `参数 ${pathStr} 类型非法（期望字符串）`;
    }
    if (expected === "number") {
      return isMissing
        ? `参数 ${pathStr} 缺失（期望数字）`
        : `参数 ${pathStr} 类型非法（期望数字）`;
    }
    if (expected === "array") {
      return isMissing
        ? `参数 ${pathStr} 缺失（期望数组）`
        : `参数 ${pathStr} 类型非法（期望数组）`;
    }
    if (expected === "object") {
      return `参数 ${pathStr} 类型非法（期望对象）`;
    }
    return `参数 ${pathStr} 类型非法（期望 ${expected}）`;
  }

  if (issue.code === "too_small") {
    if (issue.origin === "string") {
      return `参数 ${pathStr} 为空字符串（期望非空字符串）`;
    }
    if (issue.origin === "array") {
      return `参数 ${pathStr} 元素过少（期望至少 ${issue.minimum} 个）`;
    }
    if (issue.origin === "number") {
      return `参数 ${pathStr} 数值过小（期望 ${issue.inclusive ? ">= " : "> "}${issue.minimum}）`;
    }
  }

  if (issue.code === "too_big") {
    if (issue.origin === "string") {
      return `参数 ${pathStr} 过长（期望长度 <= ${issue.maximum}）`;
    }
    if (issue.origin === "array") {
      return `参数 ${pathStr} 元素过多（期望至多 ${issue.maximum} 个）`;
    }
    if (issue.origin === "number") {
      return `参数 ${pathStr} 数值过大（期望 ${issue.inclusive ? "<= " : "< "}${issue.maximum}）`;
    }
  }

  // enum（zod v4: invalid_value；含 values 数组）
  if (issue.code === "invalid_value") {
    const opts = issue.values.map((o) => String(o)).join(", ");
    return `参数 ${pathStr} 非法（期望枚举值之一：${opts}）`;
  }

  // 兜底：附原始 message（已含 zod 默认描述）。
  return `参数 ${pathStr} 非法（${issue.message}）`;
}

/**
 * 描述某 schema 允许的顶层字段（用于未知字段错误的可操作提示）。
 *
 * zod v4：`.strict()` 与 `.refine()` 对 ZodObject 是就地扩展，返回值仍是 ZodObject
 * （shape 可直接访问），故无需 unwrap。本函数只面向 PUBLIC_INPUT_SCHEMAS 的顶层
 * object schema。
 */
function describeAllowedKeys(schema: z.ZodType): string {
  if (schema instanceof z.ZodObject) {
    const keys = Object.keys(schema.shape);
    return `允许的字段：${keys.length > 0 ? keys.join(", ") : "(无)"}`;
  }
  return "";
}

// Order source types
// ⚠️ 下单代表邮件通知资格（docs/order-rep-notify-email-design-2026-07-26.md §5.4）：
//   资格模型是「默认通知 + 显式排除名单」而非白名单（source 取值不封闭，导入可自由填写，
//   normalizeOrderSource 对未知值原样保留）。ACCRUAL_REVERSAL / CONTRACT_LEDGER 已在
//   扫描 SQL 与旁路创建点显式排除。今后新增**非业务** source（类似冲正/补录性质）时，
//   必须同步把它加入该设计 §5.4 排除名单：①创建点显式写 repNotifyStatus='SKIPPED'；
//   ②扫描 SQL 的 source NOT IN (...) 与第 0 步批量终结。新增**业务** source 默认通知，无需动作。
export const ORDER_SOURCE = {
  MANUAL: "MANUAL",
  PINGOODMICE: "PINGOODMICE",
  OTHER_IMPORT: "OTHER_IMPORT",
  CONTRACT_LEDGER: "CONTRACT_LEDGER", // 合同台账导入（非业务：历史补录，下单通知排除）
  ACCRUAL_REVERSAL: "ACCRUAL_REVERSAL", // 计提冲回影子订单（非业务：财务冲正，下单通知排除）
} as const;
export type OrderSource = (typeof ORDER_SOURCE)[keyof typeof ORDER_SOURCE];

// Order category
export const ORDER_CATEGORY = {
  SERVICE: "SERVICE",
  PRODUCT: "PRODUCT",
  MIXED: "MIXED",
  UNKNOWN: "UNKNOWN",
} as const;
export type OrderCategory = (typeof ORDER_CATEGORY)[keyof typeof ORDER_CATEGORY];

export function normalizeOrderCategory(raw: string | null | undefined): OrderCategory {
  if (raw === ORDER_CATEGORY.SERVICE) return ORDER_CATEGORY.SERVICE;
  if (raw === ORDER_CATEGORY.PRODUCT) return ORDER_CATEGORY.PRODUCT;
  if (raw === ORDER_CATEGORY.MIXED) return ORDER_CATEGORY.MIXED;
  if (raw === ORDER_CATEGORY.UNKNOWN) return ORDER_CATEGORY.UNKNOWN;
  return ORDER_CATEGORY.SERVICE;
}

export class OrderCategoryValidationError extends Error {}

/**
 * category 写入前校验。MIXED 已封堵（历史无数据），返回 400 提示。
 * SERVICE / PRODUCT 放行；其余（含 MIXED、UNKNOWN、空值）拒绝。
 *
 * 与 normalizeOrderCategory 的区别：后者是读取归一化（保留 MIXED/UNKNOWN 兼容历史），
 * 本函数是写入闸门（拒绝 MIXED 进入新数据）。
 */
export function assertValidOrderCategory(raw: string | null | undefined): asserts raw is "SERVICE" | "PRODUCT" {
  if (raw === ORDER_CATEGORY.SERVICE || raw === ORDER_CATEGORY.PRODUCT) return;
  throw new OrderCategoryValidationError(
    raw === ORDER_CATEGORY.MIXED
      ? "不再支持「混合」订单类型，请明确选择「服务」或「商品」"
      : `不支持的订单类型：${raw || "空值"}，请选择「服务」或「商品」`,
  );
}

export function normalizeOrderFinanceTreatment(raw: string | null | undefined): OrderFinanceTreatment {
  if (raw === ORDER_FINANCE_TREATMENT.AUTO) return ORDER_FINANCE_TREATMENT.AUTO;
  if (raw === ORDER_FINANCE_TREATMENT.STANDALONE) return ORDER_FINANCE_TREATMENT.STANDALONE;
  if (raw === ORDER_FINANCE_TREATMENT.PROJECT_INCLUDED) return ORDER_FINANCE_TREATMENT.PROJECT_INCLUDED;
  if (raw === ORDER_FINANCE_TREATMENT.EXCLUDED) return ORDER_FINANCE_TREATMENT.EXCLUDED;
  return ORDER_FINANCE_TREATMENT.AUTO;
}

// Order status (单一状态机，合并原 status + deliveryStatus —— 见 docs/orders-ui-review-round3.md)
export const ORDER_STATUS = {
  DRAFT: "DRAFT",
  CONFIRMED: "CONFIRMED",
  DELIVERED: "DELIVERED",
  CLOSED: "CLOSED", // 终态：吸收原 CANCELLED + CLOSED，用 OrderStatusHistory.note 区分原因
} as const;
export type OrderStatus = (typeof ORDER_STATUS)[keyof typeof ORDER_STATUS];

// Order finance treatment
export const ORDER_FINANCE_TREATMENT = {
  AUTO: "AUTO",
  STANDALONE: "STANDALONE",
  PROJECT_INCLUDED: "PROJECT_INCLUDED",
  EXCLUDED: "EXCLUDED",
} as const;
export type OrderFinanceTreatment = (typeof ORDER_FINANCE_TREATMENT)[keyof typeof ORDER_FINANCE_TREATMENT];

// Allowed status transitions (四态单状态机)
// CLOSED 为终态（含取消）；DRAFT/CONFIRMED 可关闭，CONFIRMED 可交付，CLOSED 仅 ADMIN 可重新确认。
export const ORDER_STATUS_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ["CONFIRMED", "CLOSED"],
  CONFIRMED: ["DELIVERED", "CLOSED"],
  DELIVERED: ["CLOSED"],
  CLOSED: ["CONFIRMED"], // ADMIN only（重开）
};

// Order No prefixes
export const ORDER_NO_PREFIX = {
  MANUAL: "SO",
  PINGOODMICE: "PO",
  OTHER_IMPORT: "IO",
  CONTRACT_LEDGER: "CO",
} as const;

const SOURCE_ALIASES: Record<string, string> = {
  PINGOODMICE: "PINGOODMICE",
  "微信小商店": "PINGOODMICE",
  "拼好鼠": "PINGOODMICE",
  CONTRACT_LEDGER: "CONTRACT_LEDGER",
  "合同台账": "CONTRACT_LEDGER",
  "生物收入": "CONTRACT_LEDGER",
};

export function normalizeOrderSource(raw: string): string {
  return SOURCE_ALIASES[raw] ?? raw;
}

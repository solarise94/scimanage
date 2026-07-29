/**
 * 商务邮件通知 — 常量与配置
 * 见 docs/business-email-notification-design-2026-06-26.md
 */

/** 邮件 / 站内通知类型枚举（A–G + 可归档提醒） */
export const BUSINESS_EMAIL_TYPE = {
  MILESTONE_DUE_SOON: "MILESTONE_DUE_SOON", // A 节点到期前提醒（项目成员）
  MILESTONE_OVERDUE_NUDGE: "MILESTONE_OVERDUE_NUDGE", // B 节点逾期自动催办（外部部门）
  MILESTONE_MANUAL_NUDGE: "MILESTONE_MANUAL_NUDGE", // C 节点手动催办（外部部门）
  MILESTONE_COMPLETED: "MILESTONE_COMPLETED", // D 逾期后完成通知（外部部门）
  INVOICE_REQUESTED: "INVOICE_REQUESTED", // E 发票申请提交（财务部）
  INVOICE_ADJUSTED: "INVOICE_ADJUSTED", // F 发票冲红/重开（财务部）
  INVOICE_OVERDUE_NUDGE: "INVOICE_OVERDUE_NUDGE", // F2 发票超期催办（财务部）
  PROJECT_ARCHIVED: "PROJECT_ARCHIVED", // G 项目归档通知（项目成员）
  ARCHIVE_READY: "ARCHIVE_READY", // 可归档站内提醒（项目 owner）
  ORDER_REP_NOTIFIED: "ORDER_REP_NOTIFIED", // H 下单代表通知（Representative）
} as const;

export type BusinessEmailType =
  (typeof BUSINESS_EMAIL_TYPE)[keyof typeof BUSINESS_EMAIL_TYPE];

/** 财务部收件人标识：固定 department 值，不靠 name 模糊匹配（风险点 8） */
export const FINANCE_DEPARTMENT = "FINANCE";

/** 自动催办 24h 去重（节点级，基于 nudgeLastSentAt） */
export const AUTO_NUDGE_DEDUP_MS = 24 * 60 * 60 * 1000;

/** 手动催办 1h 软限速（与自动催办共用 nudgeLastSentAt） */
export const MANUAL_NUDGE_RATELIMIT_MS = 60 * 60 * 1000;

/** 发票 REQUESTED 超过 N 天未 ISSUED 触发催办 */
export const INVOICE_OVERDUE_DAYS = 7;
export const INVOICE_OVERDUE_MS = INVOICE_OVERDUE_DAYS * 24 * 60 * 60 * 1000;

/** 发票超期催办两次之间的最小间隔（基于 overdueNudgeLastSentAt） */
export const INVOICE_OVERDUE_NUDGE_INTERVAL_MS = INVOICE_OVERDUE_MS;

/** PROCESSING 锁超时回收阈值（对标 reminder.ts recoverStuck） */
export const STUCK_LOCK_MS = 10 * 60 * 1000;

/** 单次扫描批量上限 */
export const SCAN_BATCH_LIMIT = 200;

/** 归档就绪判定：订单终态集合（CLOSED / DELIVERED） */
export const ARCHIVE_READY_ORDER_STATUSES = ["CLOSED", "DELIVERED"] as const;

// ── H 下单代表邮件通知（见 docs/order-rep-notify-email-design-2026-07-26.md） ──
/** 下单代表通知：失败自动重试上限（§5.6）。达到后停留 FAILED，需人工重置脚本恢复。 */
export const ORDER_REP_NOTIFY_MAX_ATTEMPTS = 3;
/** 下单代表通知：按代表分组后单封邮件分片上限（§5.2），避免超长表格。 */
export const ORDER_REP_NOTIFY_CHUNK_SIZE = 50;

export const CRM_STAGES = ["LEAD", "CONTACTED", "FOLLOWING", "ACTIVE", "BLOCKED", "LOST", "DORMANT"] as const;
export type CrmStage = (typeof CRM_STAGES)[number];

export type SemanticTone = "success" | "warning" | "danger" | "info" | "neutral";

const SEMANTIC_TONE_CLASS: Record<SemanticTone, string> = {
  success: "bg-success-bg text-success",
  warning: "bg-warning-bg text-warning",
  danger: "bg-danger-bg text-danger",
  info: "bg-info-bg text-info",
  neutral: "bg-neutral-bg text-neutral",
};

export const STAGE_LABELS: Record<string, string> = {
  LEAD: "线索",
  CONTACTED: "已触达",
  FOLLOWING: "跟进中",
  ACTIVE: "业务进行中",
  BLOCKED: "受阻",
  LOST: "流失",
  DORMANT: "休眠",
  // 兼容旧数据读取
  NEW: "新客户",
};

export const STAGE_METADATA: Record<CrmStage | "NEW", { tone: SemanticTone; className?: string; hex: string }> = {
  LEAD: { tone: "info", hex: "var(--chart-1)" },
  CONTACTED: { tone: "info", hex: "var(--chart-2)" },
  FOLLOWING: { tone: "warning", hex: "var(--warning)" },
  ACTIVE: { tone: "success", hex: "var(--success)" },
  BLOCKED: { tone: "danger", hex: "var(--danger)" },
  LOST: { tone: "neutral", hex: "var(--neutral)" },
  DORMANT: { tone: "neutral", hex: "var(--muted-foreground)" },
  NEW: { tone: "info", hex: "var(--chart-1)" },
};

for (const key of Object.keys(STAGE_METADATA) as Array<CrmStage | "NEW">) {
  STAGE_METADATA[key].className = SEMANTIC_TONE_CLASS[STAGE_METADATA[key].tone];
}

export const STAGE_COLORS: Record<string, string> = Object.fromEntries(
  Object.entries(STAGE_METADATA).map(([k, v]) => [k, v.className])
) as Record<string, string>;

export const STAGE_HEX_COLORS: Record<string, string> = Object.fromEntries(
  Object.entries(STAGE_METADATA).map(([k, v]) => [k, v.hex])
) as Record<string, string>;

export const CRM_IMPORTANCE = ["LOW", "NORMAL", "HIGH", "KEY"] as const;
export type CrmImportance = (typeof CRM_IMPORTANCE)[number];

export const IMPORTANCE_LABELS: Record<string, string> = {
  LOW: "低",
  NORMAL: "普通",
  HIGH: "重要",
  KEY: "关键",
};

export const IMPORTANCE_COLORS: Record<string, string> = {
  LOW: "bg-neutral-bg text-neutral",
  NORMAL: "bg-info-bg text-info",
  HIGH: "bg-warning-bg text-warning",
  KEY: "bg-danger-bg text-danger",
};

export const CRM_INTERACTION_TYPES = ["CALL", "WECHAT", "EMAIL", "MEETING", "VISIT", "REFERRAL", "NOTE"] as const;
export type CrmInteractionType = (typeof CRM_INTERACTION_TYPES)[number];

export const INTERACTION_TYPE_LABELS: Record<string, string> = {
  CALL: "电话",
  WECHAT: "微信",
  EMAIL: "邮件",
  MEETING: "会议",
  VISIT: "拜访",
  REFERRAL: "转介绍",
  NOTE: "备注",
};

export const CRM_FOLLOW_UP_STATUS = ["OPEN", "DONE", "CANCELLED", "EXPIRED"] as const;
export type CrmFollowUpStatus = (typeof CRM_FOLLOW_UP_STATUS)[number];

export const FOLLOW_UP_STATUS_LABELS: Record<string, string> = {
  OPEN: "待处理",
  DONE: "已完成",
  CANCELLED: "已取消",
  EXPIRED: "已过期",
};

export const FOLLOW_UP_STATUS_COLORS: Record<string, string> = {
  OPEN: "bg-warning-bg text-warning",
  DONE: "bg-success-bg text-success",
  CANCELLED: "bg-neutral-bg text-neutral",
  EXPIRED: "bg-danger-bg text-danger",
};

export const CRM_DORMANT_THRESHOLD_DAYS = 90;
export const CRM_DORMANT_WARNING_DAYS = 60;
export const CRM_ACTIVE_COOLDOWN_DAYS = 30;
export const CRM_ACTIVE_WARNING_TO_DORMANT_DAYS = 30;

export const CRM_COMMUNICATION_TASK_SOURCE_TYPES = [
  "CRM_COMMUNICATION",
  "CRM_DORMANT_WARNING",
  "CRM_REACTIVATION",
  "CRM_ACTIVE_DOWNGRADE_WARNING",
] as const;
export type CrmCommunicationTaskSourceType = (typeof CRM_COMMUNICATION_TASK_SOURCE_TYPES)[number];

export const CRM_EFFECTIVE_INTERACTION_TYPES = [
  "CALL",
  "WECHAT",
  "EMAIL",
  "MEETING",
  "VISIT",
  "REFERRAL",
] as const;
export type CrmEffectiveInteractionType = (typeof CRM_EFFECTIVE_INTERACTION_TYPES)[number];

export const CRM_CHECKIN_STATUS = ["DRAFT", "COMPLETED"] as const;

export const CRM_FOLLOW_UP_TASK_TYPES = ["CONTACT", "VISIT", "OTHER"] as const;
export type CrmFollowUpTaskType = (typeof CRM_FOLLOW_UP_TASK_TYPES)[number];

export const FOLLOW_UP_TASK_TYPE_LABELS: Record<string, string> = {
  CONTACT: "沟通跟进",
  VISIT: "拜访计划",
  OTHER: "其他",
};

export const ADDRESS_SOURCE_TYPES = ["MANUAL", "PROJECT_IMPORT", "EXTERNAL_ORDER_IMPORT", "VISIT_CHECKIN", "CUSTOMER_APPLICATION"] as const;

export const ADDRESS_SOURCE_LABELS: Record<string, string> = {
  MANUAL: "手动录入",
  PROJECT_IMPORT: "项目导入",
  EXTERNAL_ORDER_IMPORT: "外部订单导入",
  VISIT_CHECKIN: "拜访签到",
  CUSTOMER_APPLICATION: "客户申请",
};

export const CRM_RELATION_TYPES = ["REFERRED", "COLLABORATES_WITH", "REPORTS_TO", "SAME_GROUP", "SAME_LAB", "OTHER"] as const;
export type CrmRelationType = (typeof CRM_RELATION_TYPES)[number];

export const SYMMETRIC_RELATION_TYPES = new Set(["COLLABORATES_WITH", "SAME_GROUP", "SAME_LAB", "OTHER"]);

export const RELATION_TYPE_LABELS: Record<string, string> = {
  REFERRED: "介绍",
  COLLABORATES_WITH: "协作",
  REPORTS_TO: "汇报",
  SAME_GROUP: "同课题组",
  SAME_LAB: "同实验室",
  OTHER: "其他",
};

export const RELATION_TYPE_METADATA: Record<CrmRelationType, { tone: SemanticTone; className?: string; hex: string }> = {
  REFERRED: { tone: "info", hex: "var(--chart-4)" },
  COLLABORATES_WITH: { tone: "success", hex: "var(--chart-1)" },
  REPORTS_TO: { tone: "info", hex: "var(--chart-2)" },
  SAME_GROUP: { tone: "success", hex: "var(--success)" },
  SAME_LAB: { tone: "success", hex: "var(--chart-5)" },
  OTHER: { tone: "neutral", hex: "var(--muted-foreground)" },
};

for (const key of Object.keys(RELATION_TYPE_METADATA) as CrmRelationType[]) {
  RELATION_TYPE_METADATA[key].className = SEMANTIC_TONE_CLASS[RELATION_TYPE_METADATA[key].tone];
}

export const RELATION_TYPE_COLORS: Record<string, string> = Object.fromEntries(
  Object.entries(RELATION_TYPE_METADATA).map(([k, v]) => [k, v.className])
) as Record<string, string>;

export const RELATION_TYPE_HEX_COLORS: Record<string, string> = Object.fromEntries(
  Object.entries(RELATION_TYPE_METADATA).map(([k, v]) => [k, v.hex])
) as Record<string, string>;

export const CRM_RELATION_STRENGTHS = ["STRONG", "NORMAL", "WEAK"] as const;

export const RELATION_STRENGTH_LABELS: Record<string, string> = {
  STRONG: "强",
  NORMAL: "一般",
  WEAK: "弱",
};

export const CRM_ASSIGNMENT_STATUS = ["UNASSIGNED", "ASSIGNED", "RECALL_CANDIDATE", "RECALLED"] as const;
export type CrmAssignmentStatus = (typeof CRM_ASSIGNMENT_STATUS)[number];

export const ASSIGNMENT_STATUS_LABELS: Record<string, string> = {
  UNASSIGNED: "未分配",
  ASSIGNED: "已分配",
  RECALL_CANDIDATE: "待收回",
  RECALLED: "已收回",
};

export const ASSIGNMENT_STATUS_COLORS: Record<string, string> = {
  UNASSIGNED: "bg-neutral-bg text-neutral",
  ASSIGNED: "bg-success-bg text-success",
  RECALL_CANDIDATE: "bg-warning-bg text-warning",
  RECALLED: "bg-danger-bg text-danger",
};

export const ASSIGNMENT_ACTIONS = ["ASSIGN", "RECALL", "MARK_CANDIDATE", "REMIND"] as const;
export type AssignmentAction = (typeof ASSIGNMENT_ACTIONS)[number];

export const ASSIGNMENT_ACTION_LABELS: Record<string, string> = {
  ASSIGN: "分配",
  RECALL: "收回",
  MARK_CANDIDATE: "标记候选",
  REMIND: "提醒",
};

export const REFLOW_THRESHOLD_DAYS = 60;

export const CRM_PERSON_CATEGORIES = [
  "STUDENT",
  "POSTDOC",
  "RESEARCHER",
  "PI",
  "TECHNICIAN",
  "CLINICIAN",
  "ADMIN",
  "PROCUREMENT",
  "OTHER",
] as const;
export type CrmPersonCategory = (typeof CRM_PERSON_CATEGORIES)[number];
export const PERSON_CATEGORY_LABELS: Record<string, string> = {
  STUDENT: "学生",
  POSTDOC: "博士后",
  RESEARCHER: "研究员/科研人员",
  PI: "课题组负责人/PI",
  TECHNICIAN: "实验技术员",
  CLINICIAN: "临床医生",
  ADMIN: "行政管理",
  PROCUREMENT: "采购/财务/设备",
  OTHER: "其他",
};
export const PERSON_CATEGORY_COLORS: Record<string, string> = {
  STUDENT: "bg-info-bg text-info",
  POSTDOC: "bg-info-bg text-info",
  RESEARCHER: "bg-info-bg text-info",
  PI: "bg-warning-bg text-warning",
  TECHNICIAN: "bg-success-bg text-success",
  CLINICIAN: "bg-success-bg text-success",
  ADMIN: "bg-neutral-bg text-neutral",
  PROCUREMENT: "bg-warning-bg text-warning",
  OTHER: "bg-neutral-bg text-neutral",
};

export const CRM_GRADUATION_STATUSES = [
  "NOT_APPLICABLE",
  "ENROLLED",
  "GRADUATING_SOON",
  "GRADUATED",
  "UNKNOWN",
] as const;
export type CrmGraduationStatus = (typeof CRM_GRADUATION_STATUSES)[number];
export const GRADUATION_STATUS_LABELS: Record<string, string> = {
  NOT_APPLICABLE: "不适用",
  ENROLLED: "在读",
  GRADUATING_SOON: "即将毕业",
  GRADUATED: "已毕业",
  UNKNOWN: "未知",
};
export const GRADUATION_STATUS_COLORS: Record<string, string> = {
  NOT_APPLICABLE: "bg-neutral-bg text-neutral",
  ENROLLED: "bg-info-bg text-info",
  GRADUATING_SOON: "bg-warning-bg text-warning",
  GRADUATED: "bg-success-bg text-success",
  UNKNOWN: "bg-neutral-bg text-neutral",
};

export const CRM_SITE_TYPES = [
  "CAMPUS",
  "COLLEGE",
  "BUILDING",
  "OTHER",
] as const;
export type CrmSiteType = (typeof CRM_SITE_TYPES)[number];
export const SITE_TYPE_LABELS: Record<string, string> = {
  CAMPUS: "院区",
  COLLEGE: "学院/院系",
  BUILDING: "大楼",
  OTHER: "其他",
};

export const GRADUATION_LOOKAHEAD_DAYS = 90;

// ── 客户偏好（Phase 1-3）──────────────────────────────────────────

export const PREFERENCE_CATEGORY = [
  "AVAILABILITY",
  "CONTACT_STYLE",
  "NEGOTIATION",
  "DISCOUNT_PROFILE",
  "PRODUCT_INTEREST",
  "ORDER_BEHAVIOR",
  "LOGISTICS",
  "DECISION",
  "COMPLAINT_SUMMARY",
  "OTHER",
] as const;
export type PreferenceCategory = (typeof PREFERENCE_CATEGORY)[number];
export const PREFERENCE_CATEGORY_LABELS: Record<string, string> = {
  AVAILABILITY: "可联系时间",
  CONTACT_STYLE: "联系方式偏好",
  NEGOTIATION: "价格/砍价风格",
  DISCOUNT_PROFILE: "综合折扣画像",
  PRODUCT_INTEREST: "产品/服务偏好",
  ORDER_BEHAVIOR: "下单行为",
  LOGISTICS: "物流/收货偏好",
  DECISION: "决策链路",
  COMPLAINT_SUMMARY: "客诉摘要",
  OTHER: "其他",
};

export const PREFERENCE_SOURCE_TYPE = [
  "MANUAL",
  "ORDER_RULE",
  "INTERACTION_AI",
  "COMPLAINT",
  "SYSTEM",
] as const;
export type PreferenceSourceType = (typeof PREFERENCE_SOURCE_TYPE)[number];
export const PREFERENCE_SOURCE_TYPE_LABELS: Record<string, string> = {
  MANUAL: "人工",
  ORDER_RULE: "订单规则",
  INTERACTION_AI: "沟通提取",
  COMPLAINT: "客诉派生",
  SYSTEM: "系统",
};

export const PREFERENCE_STATUS = ["ACTIVE", "DISMISSED", "SUPERSEDED", "ARCHIVED"] as const;
export type PreferenceStatus = (typeof PREFERENCE_STATUS)[number];
export const PREFERENCE_STATUS_LABELS: Record<string, string> = {
  ACTIVE: "有效",
  DISMISSED: "已隐藏",
  SUPERSEDED: "已替代",
  ARCHIVED: "已归档",
};

export const PREFERENCE_REVIEW_STATUS = ["PENDING", "ACCEPTED", "REJECTED"] as const;
export type PreferenceReviewStatus = (typeof PREFERENCE_REVIEW_STATUS)[number];
export const PREFERENCE_REVIEW_STATUS_LABELS: Record<string, string> = {
  PENDING: "待确认",
  ACCEPTED: "已采纳",
  REJECTED: "已拒绝",
};

/** 自动洞察 key 前缀——订单规则派生的偏好统一前缀。 */
export const ORDER_INSIGHT_KEY_PREFIX = "order-insight:";

// ── 客诉闭环（Phase 2）──────────────────────────────────────────

export const COMPLAINT_CATEGORY = [
  "DELIVERY_DELAY",
  "QUALITY",
  "PRICE",
  "COMMUNICATION",
  "LOGISTICS",
  "INVOICE_PAYMENT",
  "AFTER_SALES",
  "OTHER",
] as const;
export type ComplaintCategory = (typeof COMPLAINT_CATEGORY)[number];
export const COMPLAINT_CATEGORY_LABELS: Record<string, string> = {
  DELIVERY_DELAY: "交付延迟",
  QUALITY: "质量问题",
  PRICE: "价格争议",
  COMMUNICATION: "沟通问题",
  LOGISTICS: "物流/样本问题",
  INVOICE_PAYMENT: "发票/付款问题",
  AFTER_SALES: "售后问题",
  OTHER: "其他",
};

export const COMPLAINT_SEVERITY = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export type ComplaintSeverity = (typeof COMPLAINT_SEVERITY)[number];
export const COMPLAINT_SEVERITY_LABELS: Record<string, string> = {
  LOW: "低",
  MEDIUM: "中",
  HIGH: "高",
  CRITICAL: "严重",
};
export const COMPLAINT_SEVERITY_COLORS: Record<string, string> = {
  LOW: "bg-neutral-bg text-neutral",
  MEDIUM: "bg-warning-bg text-warning",
  HIGH: "bg-destructive-bg text-destructive",
  CRITICAL: "bg-destructive text-destructive-foreground",
};

export const COMPLAINT_STATUS = [
  "OPEN",
  "IN_PROGRESS",
  "WAITING_CUSTOMER",
  "RESOLVED",
  "CLOSED",
  "CANCELLED",
] as const;
export type ComplaintStatus = (typeof COMPLAINT_STATUS)[number];
export const COMPLAINT_STATUS_LABELS: Record<string, string> = {
  OPEN: "待处理",
  IN_PROGRESS: "处理中",
  WAITING_CUSTOMER: "等待客户",
  RESOLVED: "已解决",
  CLOSED: "已关闭",
  CANCELLED: "已取消",
};
export const COMPLAINT_STATUS_COLORS: Record<string, string> = {
  OPEN: "bg-warning-bg text-warning",
  IN_PROGRESS: "bg-info-bg text-info",
  WAITING_CUSTOMER: "bg-neutral-bg text-neutral",
  RESOLVED: "bg-success-bg text-success",
  CLOSED: "bg-neutral-bg text-neutral",
  CANCELLED: "bg-neutral-bg text-neutral",
};

/** 客诉未关闭状态集合——dashboard/列表筛选用。 */
export const COMPLAINT_OPEN_STATUSES = ["OPEN", "IN_PROGRESS", "WAITING_CUSTOMER", "RESOLVED"] as const;

export const COMPLAINT_EVENT_TYPE = [
  "COMMENT",
  "STATUS_CHANGED",
  "ASSIGNED",
  "CUSTOMER_CONTACTED",
  "RESOLUTION_PROPOSED",
  "RESOLVED",
  "REOPENED",
  "CLOSED",
] as const;
export type ComplaintEventType = (typeof COMPLAINT_EVENT_TYPE)[number];
export const COMPLAINT_EVENT_TYPE_LABELS: Record<string, string> = {
  COMMENT: "补充说明",
  STATUS_CHANGED: "状态变更",
  ASSIGNED: "负责人变更",
  CUSTOMER_CONTACTED: "已联系客户",
  RESOLUTION_PROPOSED: "提出处理方案",
  RESOLVED: "已解决",
  REOPENED: "重新打开",
  CLOSED: "已关闭",
};

/**
 * 客诉处理任务 sourceType。独立常量，不进 CRM_COMMUNICATION_TASK_SOURCE_TYPES。
 * 客诉处理任务不计入代表沟通 KPI、沟通覆盖率、休眠预警完成率。
 */
export const CRM_COMPLAINT_TASK_SOURCE_TYPE = "CRM_COMPLAINT";

/**
 * 按客诉严重程度返回默认处理截止天数（用于创建客诉时自动生成处理任务）。
 */
export function defaultComplaintDueDays(severity: string): number {
  switch (severity) {
    case "CRITICAL":
      return 1;
    case "HIGH":
      return 3;
    case "MEDIUM":
      return 7;
    default:
      return 14;
  }
}

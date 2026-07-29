import type { CrmProfileCustomerView } from "@/lib/customers/customer-business-fields";

export interface CrmCustomerProfileItem {
  id: string;
  ownerUserId: string;
  stage: string;
  importance: string;
  tagsJson: string | null;
  summary: string | null;
  lastFollowUpAt: string | null;
  nextFollowUpAt: string | null;
  lastHistoricalOrderAt: string | null;
  assignmentStatus: string;
  assignedAt: string | null;
  assignedByUserId: string | null;
  assignedByUser: { id: string; name: string } | null;
  recalledAt: string | null;
  recalledByUserId: string | null;
  recalledByUser: { id: string; name: string } | null;
  reflowReason: string | null;
  personCategory: string | null;
  jobTitle: string | null;
  graduationDate: string | null;
  graduationStatus?: string | null;
  graduationReminderAt: string | null;
  archived: boolean;
  deleted?: boolean;
  createdAt: string;
  updatedAt: string;
  ownerUser: { id: string; name: string };
  _count?: {
    interactions: number;
    followUpTasks: number;
    visitCheckins: number;
    addresses: number;
  };
  historicalOrderCount?: number;
  isRepeatCustomer?: boolean;
  dormantRisk?: boolean;
  nextCommunicationTaskAt?: string | null;
  /** Profile 主权业务字段展示视图（见 buildCrmProfileCustomerView）。 */
  customerView?: CrmProfileCustomerView;
}

export interface CrmInteractionItem {
  id: string;
  profileId: string;
  type: string;
  summary: string;
  detail: string | null;
  happenedAt: string;
  nextActionAt: string | null;
  relatedProjectId: string | null;
  sourceType?: string | null;
  sourceId?: string | null;
  createdByUserId: string;
  createdByUser: { id: string; name: string };
  voiceUrl: string | null;
  transcript: string | null;
  summaryTitle: string | null;
  summaryNote: string | null;
  asrStatus: string;
  createdAt: string;
  profile?: {
    id?: string;
    name?: string | null;
  };
}

export interface CrmFollowUpTaskItem {
  id: string;
  profileId: string;
  ownerUserId: string;
  ownerUser: { id: string; name: string };
  title: string;
  dueAt: string;
  status: string;
  taskType?: string | null;
  completedAt: string | null;
  completedInteractionId: string | null;
  reminderSent: boolean;
  createdByUserId: string;
  createdByUser: { id: string; name: string };
  createdAt: string;
  profile?: {
    id: string;
    name?: string | null;
    customerCode?: string | null;
  };
}

export interface CrmVisitCheckinItem {
  id: string;
  profileId: string;
  interactionId: string | null;
  userId: string;
  user: { id: string; name: string };
  lat: number | null;
  lng: number | null;
  accuracy: number | null;
  addressSnapshot: string | null;
  mapProvider: string | null;
  photoCount: number;
  status: string;
  voiceUrl: string | null;
  transcript: string | null;
  summaryTitle: string | null;
  summary: string | null;
  asrStatus: string;
  completedAt: string | null;
  createdAt: string;
  /** 事件时间事实源：completedAt ?? createdAt */
  happenedAt?: string;
  media: CrmVisitMediaItem[];
}

/** 代表运营详情中的签到摘要（最小公开 DTO，不含媒体/坐标/语音） */
export interface CrmRepresentativeCheckinSummary {
  id: string;
  profileId: string;
  profileName: string | null;
  addressSnapshot: string | null;
  photoCount: number;
  status: string;
  summaryTitle: string | null;
  happenedAt: string;
  createdAt: string;
  completedAt: string | null;
}

export interface CrmVisitMediaItem {
  id: string;
  checkinId: string;
  url: string;
  mimeType: string;
  size: number;
  createdAt: string;
}

export interface CrmCustomerAddressItem {
  id: string;
  profileId: string;
  label: string;
  addressText: string | null;
  province: string | null;
  city: string | null;
  district: string | null;
  lat: number | null;
  lng: number | null;
  accuracy: number | null;
  sourceType: string;
  isPrimary: boolean;
  verifiedAt: string | null;
  verifiedByUserId: string | null;
  createdAt: string;
}

export interface CrmDashboardCustomerRow {
  profileId: string;
  customerName: string;
  customerCode: string;
  organization: string | null;
  ownerName: string;
  historicalOrderCount: number;
  lastHistoricalOrderAt: string | null;
  isRepeatCustomer: boolean;
  lastFollowUpAt: string | null;
  nextFollowUpAt: string | null;
  nextCommunicationTaskAt: string | null;
  warningReasons: string[];
}

export interface CrmDashboardStats {
  totalProfiles: number;
  myProfiles: number;
  pendingFollowUps: number;
  overdueFollowUps: number;
  thisWeekCheckins: number;
  orderedCustomerCount: number;
  recentOrderedCustomerCount: number;
  repeatCustomerCount: number;
  repeatCustomerRate: number;
  dormantCustomerCount: number;
  dormantWarningCustomerCount: number;
  communicatedCustomerCount30d: number;
  communicationCoverageRate30d: number;
  openComplaintCount: number;
  highSeverityComplaintCount: number;
  stageDistribution: Array<{ stage: string; _count: number }>;
  recentInteractions: CrmInteractionItem[];
  recentOrderedCustomers: CrmDashboardCustomerRow[];
  repeatCustomers: CrmDashboardCustomerRow[];
  warningCustomers: CrmDashboardCustomerRow[];
}

export interface CrmRelationItem {
  id: string;
  fromProfileId?: string | null;
  toProfileId?: string | null;
  fromCustomer: { id: string; name: string; customerCode: string; organization?: string | null };
  toCustomer: { id: string; name: string; customerCode: string; organization?: string | null };
  type: string;
  strength: string | null;
  notes: string | null;
  introducedAt: string | null;
  createdByUserId: string;
  createdByUser: { id: string; name: string };
  createdAt: string;
  fromHasCrm?: boolean;
  toHasCrm?: boolean;
}

export interface CrmRegionManagerItem {
  id: string;
  userId: string;
  user: { id: string; name: string; email: string };
  regionId: string | null;
  region: { id: string; name: string } | null;
  archived: boolean;
  createdAt: string;
  reps: { id: string; representativeId: string; representative: { id: string; name: string; email: string } }[];
}

// ─── 代表运营趋势指标（月度时间序列）────────────────────────

/** 月度客户增长趋势点 */
export interface MonthlyGrowthPoint {
  /** 月份键 "YYYY-MM" */
  month: string;
  /** 当月新增客户数 */
  newCount: number;
  /** 截至当月的累计客户数 */
  cumulative: number;
}

/** 商品→服务转化趋势点（按月分桶；分子分母同按客户末单月归属） */
export interface CategoryConversionPoint {
  month: string;
  /** 末单落在当月的活跃复购客户数（历史有效订单 ≥2） */
  repeatCustomerCount: number;
  /** 上述客户中已发生商品→服务转化的子集（恒 ≤ repeatCustomerCount） */
  convertedToServiceCount: number;
  /** conversionRate = convertedToServiceCount / repeatCustomerCount ∈ [0,1] */
  conversionRate: number;
}

/** 转化客户明细（供详情页表格展示） */
export interface CategoryConversionDetail {
  /** 主键：CrmCustomerProfile.id */
  profileId: string;
  customerName: string | null;
  /** 首单分类（SERVICE / PRODUCT / MIXED / UNKNOWN） */
  firstOrderCategory: string;
  firstOrderAt: string;
  /** 首笔服务订单时间 */
  firstServiceOrderAt: string | null;
}

/** 月度客单价趋势点（确认业务额口径：当月确认额 / 当月有确认事件的独立订单数） */
export interface MonthlyAovPoint {
  month: string;
  /** 当月有确认事件的独立订单/项目数 */
  orderCount: number;
  /** 当月确认业务额合计，单位分 */
  totalAmount: number;
  /** 平均每单确认业务额，单位分 */
  avgOrderValue: number;
  /** 环比增长率 (本月 - 紧邻上月) / 紧邻上月 avgOrderValue；首月、本月无单、或紧邻上月无单（断链）时为 null */
  growthRate: number | null;
}

/** 代表详情页趋势聚合 */
export interface CrmRepresentativeTrends {
  customerGrowth: MonthlyGrowthPoint[];
  categoryConversion: {
    points: CategoryConversionPoint[];
    details: CategoryConversionDetail[];
  };
  averageOrderValue: MonthlyAovPoint[];
}

export interface CrmRepresentativeOpsItem {
  representativeId: string;
  name: string;
  email: string;
  archived: boolean;
  userId: string | null;
  userName: string | null;
  customerCount: number;
  visitCheckinCount: number;
  interactionCount30d?: number;
  lastCheckinAt: string | null;
  overdueFollowUps: number;
  longUnvisitedCount: number;
  dueCommunicationTaskCount?: number;
  doneCommunicationTaskCount?: number;
  overdueCommunicationTaskCount?: number;
  communicatedCustomerCount30d?: number;
  communicationCoverageRate30d?: number;
  orderedCustomerCount30d?: number;
  repeatCustomerCount30d?: number;
  repeatCustomerRate30d?: number;
  orderedCustomerCount90d?: number;
  repeatCustomerCount90d?: number;
  repeatCustomerRate90d?: number;
  activeCustomerCount?: number;
  newCustomerCount30d?: number;
  convertedCustomerCount30d?: number;
  conversionRate30d?: number;
  newCustomerCount90d?: number;
  convertedCustomerCount90d?: number;
  conversionRate90d?: number;
  dormantCustomerCount?: number;
  dormantWarningCustomerCount?: number;
  periodVisitCheckinCount?: number;
  periodInteractionCount?: number;
  periodNewCustomerCount?: number;
  periodReservedOrderCount?: number;
  /**
   * @deprecated 旧口径“下单金额”，现以确认业务额为主。
   * 单位：分（cents）。兼容旧字段名 periodReservedOrderAmount。
   */
  periodReservedOrderAmountCents?: number;
  /** @deprecated 使用 periodReservedOrderAmountCents */
  periodReservedOrderAmount?: number;
  /** 本周/今日新增业务额（产品100% + 服务立项30%），单位分 */
  periodNewBusinessAmountCents?: number;
  /** @deprecated 使用 periodNewBusinessAmountCents */
  periodNewBusinessAmount?: number;
  /** 本周/今日交付业务额（服务交付70%），单位分 */
  periodDeliveryBusinessAmountCents?: number;
  /** @deprecated 使用 periodDeliveryBusinessAmountCents */
  periodDeliveryBusinessAmount?: number;
  /** 本周/今日确认业务额 = 新增 + 交付，单位分 */
  periodConfirmedBusinessAmountCents?: number;
  /** @deprecated 使用 periodConfirmedBusinessAmountCents */
  periodConfirmedBusinessAmount?: number;
  /** 当月新增客户数（趋势函数当月快照） */
  currentMonthNewCustomers?: number;
  /** 当月客单价，单位分（确认业务额口径：当月确认额 / 当月有确认事件的独立订单数） */
  currentMonthAovCents?: number;
  /** @deprecated 使用 currentMonthAovCents */
  currentMonthAov?: number;
  /** 当月商品→服务转化率 */
  currentMonthConversionRate?: number;
  regions?: { id: string; name: string; isPrimary: boolean }[];
  avgCollectionCycleDays?: number | null;
  collectionPairCount?: number;
  quarterlyReceiptRate?: number | null;
  quarterlyReceiptAmount?: number;
  quarterlyReceivableAmount?: number;
  yearlyReceiptRate?: number | null;
  yearlyReceiptAmount?: number;
  yearlyReceivableAmount?: number;
}

import type { CollectionSummaryMetrics } from "@/lib/finance/collection-analysis";

export interface CrmRepresentativeDetail {
  representative: { id: string; name: string; email: string; archived: boolean };
  linkedUser: { id: string; name: string } | null;
  /** 代表邮箱未桥接销售角色账号时为 true；行为类 KPI 为 0，Profile 归属 KPI 仍可展示 */
  accountUnlinked?: boolean;
  customerCount: number;
  /** 开放跟进总数（scope 内，分页子接口 total） */
  openFollowUpCount?: number;
  visitCheckinCount: number;
  lastCheckinAt: string | null;
  overdueFollowUps: number;
  longUnvisitedCount: number;
  interactionCount30d?: number;
  orphanedOpenFollowUpCount?: number;
  dueCommunicationTaskCount?: number;
  doneCommunicationTaskCount?: number;
  overdueCommunicationTaskCount?: number;
  communicatedCustomerCount30d?: number;
  communicationCoverageRate30d?: number;
  orderedCustomerCount30d?: number;
  repeatCustomerCount30d?: number;
  repeatCustomerRate30d?: number;
  orderedCustomerCount90d?: number;
  repeatCustomerCount90d?: number;
  repeatCustomerRate90d?: number;
  activeCustomerCount?: number;
  newCustomerCount30d?: number;
  convertedCustomerCount30d?: number;
  conversionRate30d?: number;
  newCustomerCount90d?: number;
  convertedCustomerCount90d?: number;
  conversionRate90d?: number;
  dormantCustomerCount?: number;
  dormantWarningCustomerCount?: number;
  customers: CrmCustomerProfileItem[];
  /** 运营详情签到摘要：仅当前 effective scope 内，不含媒体/坐标 */
  recentCheckins: CrmRepresentativeCheckinSummary[];
  openFollowUps: CrmFollowUpTaskItem[];
  relationCount: number;
  recentCommunicationEvents?: Array<{
    eventKey: string;
    sourceType: "INTERACTION" | "CHECKIN";
    sourceId: string;
    profileId: string;
    profileName?: string | null;
    happenedAt: string;
    interactionType: string | null;
    originType: "MANUAL" | "CUSTOMER_APPLICATION" | "CHECKIN";
    originId: string | null;
  }>;
  regions: { id: string; name: string; isPrimary: boolean }[];
  /** 月度运营趋势（客户增长 / 复购转化 / 客单价） */
  trends: CrmRepresentativeTrends;
  collectionSummary?: CollectionSummaryMetrics;
}

export interface CrmAssignmentLogItem {
  id: string;
  profileId: string;
  fromOwnerUserId: string | null;
  fromOwnerUser: { id: string; name: string } | null;
  toOwnerUserId: string | null;
  toOwnerUser: { id: string; name: string } | null;
  action: string;
  reason: string | null;
  createdByUserId: string;
  createdByUser: { id: string; name: string };
  createdAt: string;
}

export interface CrmReportCustomerItem {
  /** 周报活跃客户主键：CrmCustomerProfile.id */
  profileId: string;
  customerName: string;
  customerCode: string;
  organization: string | null;
  stage: string;
  importance: string;
  personCategory: string | null;
  jobTitle: string | null;
  graduationStatus: string | null;
  weeklyVisitCount: number;
  lastVisitAt: string | null;
  latestDemand: string | null;
  latestInteractionAt: string | null;
  nextFollowUpAt: string | null;
  hasOrderThisWeek: boolean;
  historicalOrderCount?: number;
  lastHistoricalOrderAt?: string | null;
  isRepeatCustomer?: boolean;
  dormantRisk?: boolean;
  nextCommunicationTaskAt?: string | null;
  /** Profile 主权业务字段展示视图 */
  customerView?: CrmProfileCustomerView;
}

export interface CrmReportLineItem {
  id: string;
  /** 周报行主键：CrmCustomerProfile.id */
  profileId: string;
  customerName: string;
  customerCode?: string;
  organization: string | null;
  demand: string;
  note: string;
  sortOrder: number;
  customerExists?: boolean;
  stage?: string;
  importance?: string;
  weeklyVisitCount?: number;
  lastVisitAt?: string | null;
  hasOrderThisWeek?: boolean;
}

export interface CrmRepresentativeReport {
  representative: { id: string; name: string; email: string };
  /** 本地日期字符串 YYYY-MM-DD（周一） */
  periodKey?: string;
  periodStart: string;
  periodEnd: string;
  /** 本地展示用起止日期（Asia/Shanghai 周一 ~ 下周一） */
  periodStartDate?: string;
  periodEndDate?: string;
  summary: {
    visitCheckinCount: number;
    newCustomerCount: number;
    reservedOrderCount: number;
    /** @deprecated 旧口径"下单金额"，现改为 confirmedBusinessAmount 口径；单位分 */
    reservedOrderAmountCents?: number;
    reservedOrderAmount?: number;
    communicationEventCount: number;
    communicatedCustomerCount: number;
    dueCommunicationTaskCount?: number;
    doneCommunicationTaskCount?: number;
    /** 本周新增业务额（产品100% + 服务立项30%），单位分 */
    newBusinessAmountCents?: number;
    newBusinessAmount?: number;
    /** 本周交付业务额（服务交付70%），单位分 */
    deliveryBusinessAmountCents?: number;
    deliveryBusinessAmount?: number;
    /** 本周确认业务额 = 新增 + 交付，单位分 */
    confirmedBusinessAmountCents?: number;
    confirmedBusinessAmount?: number;
    complaintTotal?: number;
    complaintOpen?: number;
    complaintHighSeverity?: number;
  };
  customers: CrmReportCustomerItem[];
  lines: CrmReportLineItem[];
  draftNote: string | null;
}

export interface CrmLifecycleSummary {
  profileId: string;
  stage: string;
  ownerUserId: string;
  assignedAt: string | null;
  createdAt: string;
  lastFollowUpAt: string | null;
  activeOrderCount: number;
  activeOrderAmount: number;
  historicalOrderCount: number;
  lastActiveOrderAt: string | null;
  lastHistoricalOrderAt: string | null;
  firstOrderAt: string | null;
  isRepeatCustomer: boolean;
  lastEffectiveInteractionAt: string | null;
  nextCommunicationTaskAt: string | null;
  openCommunicationTaskCount: number;
  overdueCommunicationTaskCount: number;
  dueCommunicationTaskCount30d: number;
  doneCommunicationTaskCount30d: number;
  dormantRisk: boolean;
  dormantCandidate: boolean;
  activeProjectCount: number;
  lastActiveProjectAt: string | null;
  lastActiveBehaviorEndedAt: string | null;
  activeCooldownEndsAt: string | null;
  activeWarningIssuedAt: string | null;
}

/**
 * ADMIN 运营仪表盘趋势数据层（纯数据层，不依赖 Next request）。
 *
 * 供 /api/crm/dashboard/admin-trends 路由与 smoke 脚本复用。
 * 所有日期分桶按服务器本地时区生成 "YYYY-MM-DD" key，零填充保证窗口内每天都有条目。
 */

import { prisma } from "@/lib/prisma";
import { CRM_STAGES } from "@/lib/crm/constants";

export interface AdminTrendsPoint {
  /** 本地日期，格式 "YYYY-MM-DD" */
  date: string;
  count: number;
}

export interface AdminTrendsResult {
  days: number;
  /** 零填充，按本地日期升序 */
  customerGrowth: AdminTrendsPoint[];
  interactionTrend: AdminTrendsPoint[];
  /**
   * 跟进任务按到期日分布：OPEN 状态且 dueAt 落在窗口内的任务，按 dueAt 本地日期分桶。
   * 语义 = 「各到期日的待处理跟进积压」，过去的日子即逾期积压。
   */
  followUpTaskLoad: AdminTrendsPoint[];
  stageDistribution: Array<{ stage: string; count: number }>;
  totals: {
    newCustomers: number;
    interactions: number;
    /** 前一等长周期，用于环比 */
    prevNewCustomers: number;
    prevInteractions: number;
    /** 窗口内 OPEN 跟进任务总数 = sum(followUpTaskLoad)。 */
    openFollowUpTasksInWindow: number;
  };
}

/** 允许的窗口长度；其他值 clamp 到 30。 */
const ALLOWED_DAYS = new Set([7, 30, 90]);
const DEFAULT_DAYS = 30;

function clampDays(daysRaw: number): number {
  return ALLOWED_DAYS.has(daysRaw) ? daysRaw : DEFAULT_DAYS;
}

/** 将 Date 格式化为本地时区的 "YYYY-MM-DD"。 */
function formatLocalDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * 构造窗口内的零填充日期桶（按本地日期升序）。
 * since 取「今天 00:00 本地时间 - (days-1) 天」，保证「今天」包含在桶内。
 */
function buildDayBuckets(days: number): string[] {
  const buckets: string[] = [];
  const now = new Date();
  // 今天 00:00 本地时间
  const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(todayMidnight.getTime() - i * 24 * 60 * 60 * 1000);
    buckets.push(formatLocalDate(d));
  }
  return buckets;
}

/**
 * 计算环比徽标百分比：上升为正数、下降为负数、prev=0 返回 null（不显示）。
 */
export function computeChangeRate(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return (current - previous) / previous;
}

/**
 * 获取 ADMIN 运营趋势数据。
 *
 * @param daysRaw 窗口长度；仅 7/30/90 生效，其他值 clamp 到 30
 */
export async function getAdminTrends(daysRaw: number): Promise<AdminTrendsResult> {
  const days = clampDays(daysRaw);
  const now = new Date();

  // ── 时间窗口 ──
  // since：今天 00:00 本地时间 - (days-1) 天（窗口下界，含今天）
  const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const tomorrowMidnight = new Date(todayMidnight.getTime() + 24 * 60 * 60 * 1000);
  const since = new Date(todayMidnight.getTime() - (days - 1) * 24 * 60 * 60 * 1000);
  // prevSince：再往前推一个等长窗口，用于环比 [2*since, since)
  const prevSince = new Date(since.getTime() - days * 24 * 60 * 60 * 1000);

  // ── 零填充桶 ──
  const dateKeys = buildDayBuckets(days);
  const customerMap = new Map<string, number>(dateKeys.map((d) => [d, 0]));
  const interactionMap = new Map<string, number>(dateKeys.map((d) => [d, 0]));
  const followUpTaskMap = new Map<string, number>(dateKeys.map((d) => [d, 0]));

  // ── 并行查询 ──
  const [
    customerRows,
    interactionRows,
    followUpTaskRows,
    prevNewCustomers,
    prevInteractions,
    stageGroups,
  ] = await Promise.all([
    prisma.crmCustomerProfile.findMany({
      where: { createdAt: { gte: since }, deleted: false },
      select: { createdAt: true },
    }),
    prisma.crmInteraction.findMany({
      where: { happenedAt: { gte: since } },
      select: { happenedAt: true },
    }),
    // 跟进任务按到期日分布：OPEN 状态且 dueAt 落在窗口 [since, 今晚24:00) 内。
    // 窗口上界用「明天 00:00 本地时间」做开区间，避免时区漂移。
    prisma.crmFollowUpTask.findMany({
      where: {
        status: "OPEN",
        dueAt: { gte: since, lt: tomorrowMidnight },
      },
      select: { dueAt: true },
    }),
    prisma.crmCustomerProfile.count({
      where: {
        createdAt: { gte: prevSince, lt: since },
        deleted: false,
      },
    }),
    prisma.crmInteraction.count({
      where: { happenedAt: { gte: prevSince, lt: since } },
    }),
    prisma.crmCustomerProfile.groupBy({
      by: ["stage"],
      where: { deleted: false, archived: false },
      _count: { _all: true },
    }),
  ]);

  // ── 按服务器本地日期分桶 ──
  for (const row of customerRows) {
    const key = formatLocalDate(row.createdAt);
    if (customerMap.has(key)) {
      customerMap.set(key, (customerMap.get(key) ?? 0) + 1);
    }
  }
  for (const row of interactionRows) {
    const key = formatLocalDate(row.happenedAt);
    if (interactionMap.has(key)) {
      interactionMap.set(key, (interactionMap.get(key) ?? 0) + 1);
    }
  }
  for (const row of followUpTaskRows) {
    const key = formatLocalDate(row.dueAt);
    if (followUpTaskMap.has(key)) {
      followUpTaskMap.set(key, (followUpTaskMap.get(key) ?? 0) + 1);
    }
  }

  const customerGrowth: AdminTrendsPoint[] = dateKeys.map((date) => ({
    date,
    count: customerMap.get(date) ?? 0,
  }));
  const interactionTrend: AdminTrendsPoint[] = dateKeys.map((date) => ({
    date,
    count: interactionMap.get(date) ?? 0,
  }));
  const followUpTaskLoad: AdminTrendsPoint[] = dateKeys.map((date) => ({
    date,
    count: followUpTaskMap.get(date) ?? 0,
  }));

  const newCustomers = customerGrowth.reduce((s, p) => s + p.count, 0);
  const interactions = interactionTrend.reduce((s, p) => s + p.count, 0);
  const openFollowUpTasksInWindow = followUpTaskLoad.reduce((s, p) => s + p.count, 0);

  // ── stageDistribution：按 CRM_STAGES 顺序输出，未知 stage 排最后 ──
  const stageCountMap = new Map<string, number>(
    stageGroups.map((g) => [g.stage, g._count._all]),
  );
  const knownStages = CRM_STAGES.filter((s) => stageCountMap.has(s));
  const knownStageSet = new Set<string>(CRM_STAGES as readonly string[]);
  const unknownStages = [...stageCountMap.keys()].filter((s) => !knownStageSet.has(s));
  const stageDistribution: Array<{ stage: string; count: number }> = [
    ...knownStages.map((stage) => ({ stage, count: stageCountMap.get(stage) ?? 0 })),
    ...unknownStages.sort().map((stage) => ({ stage, count: stageCountMap.get(stage) ?? 0 })),
  ];

  return {
    days,
    customerGrowth,
    interactionTrend,
    followUpTaskLoad,
    stageDistribution,
    totals: {
      newCustomers,
      interactions,
      prevNewCustomers,
      prevInteractions,
      openFollowUpTasksInWindow,
    },
  };
}

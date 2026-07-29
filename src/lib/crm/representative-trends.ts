/**
 * 代表运营月度趋势聚合
 *
 * 三个指标（均为月度时间序列）：
 *  1. getMonthlyCustomerGrowth   — 月度客户增加（新增 + 累计）
 *  2. getRepurchaseCategoryConversion — 复购客户商品→服务转化
 *  3. getMonthlyAverageOrderValue — 月度客单价（确认业务额口径）+ 环比增长
 *
 * 归属口径：增长/客单价/复购转化均以 profileId 为主键。
 * 调用方通过 buildRepresentativePerformanceScope 等预先解析 owner → profileId[]；
 * 这里只做纯聚合，订单归属只认 `profileId`。
 *
 * 金额单位：分（Int）；其中客单价金额口径已对齐业务确认额（recognition amount），
 * 不再是订单全额。前端展示时除 100 转元，并在 label 上标注“确认额口径”。
 */

import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type {
  MonthlyGrowthPoint,
  MonthlyAovPoint,
  CategoryConversionPoint,
  CategoryConversionDetail,
} from "@/lib/crm/types";
import { getBusinessRecognitionEvents } from "@/lib/finance/business-recognition";

type DbClient = PrismaClient | Prisma.TransactionClient;

/** SQLite $queryRaw 的 COUNT/SUM 返回 bigint，MAX(日期列) 返回 string */
type AggRow = { key: string } & Record<string, bigint | string | null>;

function normalizeNumber(value: bigint | number | null | undefined): number {
  if (value == null) return 0;
  return typeof value === "bigint" ? Number(value) : value;
}

function normalizeDate(value: Date | string | number | bigint | null | undefined): Date | null {
  if (value == null) return null;
  if (value instanceof Date) return value;
  if (typeof value === "bigint") return new Date(Number(value));
  if (typeof value === "number") return new Date(value);
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** 格式化为月份键 "YYYY-MM"（本地时区，与展示一致） */
function formatMonthKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

/**
 * 生成最近 N 个月的连续月份键（含本月），从最早到最近。
 * 例如 months=6 且当前为 2026-06 → ["2026-01",...,"2026-06"]。
 * 保证时间序列没有断档月份，便于前端画连续趋势图。
 */
function buildRecentMonthKeys(months: number, now: Date = new Date()): string[] {
  const keys: string[] = [];
  const base = new Date(now.getFullYear(), now.getMonth(), 1);
  for (let i = months - 1; i >= 0; i -= 1) {
    const d = new Date(base.getFullYear(), base.getMonth() - i, 1);
    keys.push(formatMonthKey(d));
  }
  return keys;
}

/** 月份键对应的该月起始/下月起始 Date，用于 SQL 范围过滤 */
function monthRange(monthKey: string): { start: Date; end: Date } {
  const [y, m] = monthKey.split("-").map(Number);
  const start = new Date(y, m - 1, 1);
  const end = new Date(y, m, 1);
  return { start, end };
}

// ─── 1. 月度客户增长 ──────────────────────────────────────

/**
 * 按代表归属统计月度新增客户数。
 *
 * 归属锚点 `anchorByProfileId` 由调用方从 `resolveEffectiveRepresentativesForProfiles`
 * 的 `anchorAt` 预先解析后传入——这与本路由其它指标（period 新增、生命周期统计）
 * 使用的是同一个有效归属锚点，避免本函数再次重查 profile 自行推导 `assignedAt`，
 * 否则对 SITE/ORG binding 来源的客户会得到与其它指标不一致的月份（binding 锚点
 * 通常晚于 profile.createdAt）。同时省掉 per-owner 的 profile 查询。
 *
 * @param ownerToProfileIds  ownerUserId / representativeId → 名下有效 profileId[]
 * @param anchorByProfileId  profileId → 有效归属锚点（effective anchorAt）
 * @returns Map<ownerUserId, MonthlyGrowthPoint[]>  — 每个代表的最近 `months` 个月序列
 */
export function getMonthlyCustomerGrowth(
  ownerToProfileIds: Map<string, string[]>,
  anchorByProfileId: Map<string, Date | null>,
  months = 6,
  now: Date = new Date(),
): Map<string, MonthlyGrowthPoint[]> {
  const result = new Map<string, MonthlyGrowthPoint[]>();
  const monthKeys = buildRecentMonthKeys(months, now);
  // 累计需要从更早的数据算起：取最近 months 个月 + 之前所有历史作为累计基数
  const earliestStart = monthRange(monthKeys[0]).start;

  for (const [ownerUserId, profileIds] of ownerToProfileIds) {
    if (!ownerUserId || profileIds.length === 0) {
      result.set(ownerUserId, monthKeys.map((month) => ({ month, newCount: 0, cumulative: 0 })));
      continue;
    }

    // 按月统计新增 + 计算累计基数（earliestStart 之前的客户数）
    const monthlyNew = new Map<string, number>();
    for (const key of monthKeys) monthlyNew.set(key, 0);
    let cumulativeBase = 0;

    for (const profileId of profileIds) {
      const anchor = anchorByProfileId.get(profileId);
      if (!anchor) continue; // 无有效归属锚点（理论上有效客户必有锚点），跳过
      const key = formatMonthKey(anchor);
      if (anchor < earliestStart) {
        cumulativeBase += 1;
      } else if (monthlyNew.has(key)) {
        monthlyNew.set(key, monthlyNew.get(key)! + 1);
      }
      // anchor 在 earliestStart 之后但超出 monthKeys 范围（理论不会发生，因为 months 覆盖到本月）
    }

    const points: MonthlyGrowthPoint[] = [];
    let cumulative = cumulativeBase;
    for (const key of monthKeys) {
      const newCount = monthlyNew.get(key) ?? 0;
      cumulative += newCount;
      points.push({ month: key, newCount, cumulative });
    }
    result.set(ownerUserId, points);
  }

  return result;
}

// ─── 2. 月度客单价（确认业务额口径）──────────────────────────

type AovBucket = {
  month: string;
  /** 当月发生确认事件的独立订单/项目数 */
  orderCount: number;
  /** 当月确认业务额合计，单位分 */
  totalAmount: number;
};

/**
 * 按代表归属统计月度客单价（确认业务额口径）。
 *
 * 输入：`ownerToProfileIds`（ownerUserId / representativeId → 名下 profileId[]）。
 * 底层通过 `getBusinessRecognitionEvents({ profileIds })` 计算业务确认额事件。
 *
 * 金额口径：业务确认额（recognition amount），单位分。
 * @returns Map<ownerUserId, MonthlyAovPoint[]>  — 含环比 growthRate
 */
export async function getMonthlyAverageOrderValue(
  ownerToProfileIds: Map<string, string[]>,
  months = 6,
  _db: DbClient = prisma,
  now: Date = new Date(),
): Promise<Map<string, MonthlyAovPoint[]>> {
  const result = new Map<string, MonthlyAovPoint[]>();
  const monthKeys = buildRecentMonthKeys(months, now);

  const allProfileIds = [...new Set(
    Array.from(ownerToProfileIds.values()).flat().filter(Boolean),
  )];

  if (allProfileIds.length === 0) {
    for (const [ownerUserId] of ownerToProfileIds) {
      result.set(ownerUserId, monthKeys.map((month) => ({
        month, orderCount: 0, totalAmount: 0, avgOrderValue: 0, growthRate: null,
      })));
    }
    return result;
  }

  const earliestStart = monthRange(monthKeys[0]).start;
  const latestEnd = monthRange(monthKeys[monthKeys.length - 1]).end;
  const events = await getBusinessRecognitionEvents({
    profileIds: allProfileIds,
    periodStart: earliestStart,
    periodEnd: latestEnd,
  });

  const profileToOwner = new Map<string, string>();
  for (const [ownerUserId, profileIds] of ownerToProfileIds) {
    for (const pid of profileIds) {
      profileToOwner.set(pid, ownerUserId);
    }
  }

  const bucketMap = new Map<string, Map<string, AovBucket>>();
  const orderKeySetMap = new Map<string, Map<string, Set<string>>>();

  for (const e of events) {
    const ownerUserId = profileToOwner.get(e.profileId);
    if (!ownerUserId) continue;
    const month = formatMonthKey(e.recognizedAt);
    if (!monthKeys.includes(month)) continue;

    let ownerBuckets = bucketMap.get(ownerUserId);
    if (!ownerBuckets) {
      ownerBuckets = new Map<string, AovBucket>();
      bucketMap.set(ownerUserId, ownerBuckets);
    }
    let ownerOrderKeys = orderKeySetMap.get(ownerUserId);
    if (!ownerOrderKeys) {
      ownerOrderKeys = new Map<string, Set<string>>();
      orderKeySetMap.set(ownerUserId, ownerOrderKeys);
    }

    let bucket = ownerBuckets.get(month);
    if (!bucket) {
      bucket = { month, orderCount: 0, totalAmount: 0 };
      ownerBuckets.set(month, bucket);
    }
    let orderKeys = ownerOrderKeys.get(month);
    if (!orderKeys) {
      orderKeys = new Set<string>();
      ownerOrderKeys.set(month, orderKeys);
    }

    const key = e.orderId ?? e.projectId ?? `${e.phase}-${month}`;
    if (!orderKeys.has(key)) {
      orderKeys.add(key);
      bucket.orderCount += 1;
    }
    bucket.totalAmount += e.amountCents;
  }

  for (const [ownerUserId] of ownerToProfileIds) {
    const ownerBuckets = bucketMap.get(ownerUserId) ?? new Map<string, AovBucket>();
    const points: MonthlyAovPoint[] = [];
    let prevMonthAvg: number | null = null;

    for (const key of monthKeys) {
      const bucket = ownerBuckets.get(key);
      const orderCount = bucket?.orderCount ?? 0;
      const totalAmount = bucket?.totalAmount ?? 0;
      const hasOrders = orderCount > 0;
      const avgOrderValue = hasOrders ? Math.round(totalAmount / orderCount) : 0;
      const growthRate = hasOrders && prevMonthAvg !== null && prevMonthAvg > 0
        ? (avgOrderValue - prevMonthAvg) / prevMonthAvg
        : null;
      points.push({ month: key, orderCount, totalAmount, avgOrderValue, growthRate });
      prevMonthAvg = hasOrders ? avgOrderValue : null;
    }
    result.set(ownerUserId, points);
  }

  return result;
}

// ─── 3. 复购客户商品→服务转化（订单级口径，profileId 主键）─────────────────

type ProfileOrderRow = {
  profileId: string | null;
  orderId: string;
  category: string;
  orderDate: string;
};

/**
 * 判定一笔订单分类是否"含商品"（PRODUCT 或 MIXED）。
 * MIXED 视为既含商品又含服务，因此首单 MIXED 也算"含商品"。
 */
function categoryContainsProduct(category: string): boolean {
  return category === "PRODUCT" || category === "MIXED"; // MIXED 已封堵入口，此分支为防御性保留
}

/**
 * 判定一笔订单分类是否"含服务"（SERVICE 或 MIXED）。
 */
function categoryContainsService(category: string): boolean {
  return category === "SERVICE" || category === "MIXED"; // MIXED 已封堵入口，此分支为防御性保留
}

/**
 * 按代表归属统计复购客户的商品→服务转化。
 *
 * 转化判定（订单级）：
 *  - 客户历史有效订单数 ≥ 2（复购）
 *  - 首单含商品（PRODUCT/MIXED）
 *  - 后续出现含服务的订单（SERVICE/MIXED，且时间晚于首单）
 *  → 该客户被标记为"已发生商品→服务转化"
 *
 * 月份归属（分子分母同口径，保证 conversionRate ∈ [0,1]）：
 *  - 分母 repeatCustomerCount[M]：末单落在月 M 的活跃复购客户数（历史 ≥2 单）
 *  - 分子 convertedToServiceCount[M]：上述客户中已发生转化的子集（同样按末单月 M 计）
 *  分子恒为分母子集，故 conversionRate 不会 >100%（不会突破前端 0~100% Y 轴）。
 *  末单落在窗口外的客户视为窗口内不活跃，整体不计入。
 *
 * 订单归属只认 `profileId IN scope`。
 *
 * @param ownerToProfileIds ownerUserId / representativeId → 名下 profileId[]
 * @returns Map<ownerUserId, { points, details }>
 */
export async function getRepurchaseCategoryConversion(
  ownerToProfileIds: Map<string, string[]>,
  months = 6,
  db: DbClient = prisma,
  now: Date = new Date(),
): Promise<Map<string, { points: CategoryConversionPoint[]; details: CategoryConversionDetail[] }>> {
  const result = new Map<string, { points: CategoryConversionPoint[]; details: CategoryConversionDetail[] }>();
  const monthKeys = buildRecentMonthKeys(months, now);

  for (const [ownerUserId, profileIds] of ownerToProfileIds) {
    if (!ownerUserId || profileIds.length === 0) {
      result.set(ownerUserId, {
        points: monthKeys.map((month) => ({
          month, repeatCustomerCount: 0, convertedToServiceCount: 0, conversionRate: 0,
        })),
        details: [],
      });
      continue;
    }

    const uniqueProfileIds = [...new Set(profileIds.filter(Boolean))];

    // 拉取名下有效订单（完整历史，供首单/复购判定）；月份归属在内存里按末单月做。
    const scopeFilter = Prisma.sql`"profileId" IN (${Prisma.join(uniqueProfileIds)})`;

    const rows = await db.$queryRaw<ProfileOrderRow[]>(Prisma.sql`
      SELECT
        "profileId" AS "profileId",
        "id" AS "orderId",
        "category" AS "category",
        COALESCE("orderedAt", "confirmedAt", "createdAt") AS "orderDate"
      FROM "Order"
      WHERE ${scopeFilter}
        AND "deleted" = ${false}
        AND "archived" = ${false}
        AND "status" IN ('CONFIRMED', 'DELIVERED', 'CLOSED')
      ORDER BY "orderDate" ASC
    `);

    // 按 profileId 分组
    const ordersByProfile = new Map<string, ProfileOrderRow[]>();
    for (const row of rows) {
      const pid = row.profileId;
      if (!pid) continue;
      if (!ordersByProfile.has(pid)) ordersByProfile.set(pid, []);
      ordersByProfile.get(pid)!.push(row);
    }

    const repeatByMonth = new Map<string, number>();
    const convertedByMonth = new Map<string, number>();
    for (const key of monthKeys) {
      repeatByMonth.set(key, 0);
      convertedByMonth.set(key, 0);
    }

    const details: CategoryConversionDetail[] = [];

    for (const [pid, orders] of ordersByProfile) {
      if (orders.length < 2) continue;

      const firstOrder = orders[0];
      const firstOrderCategory = firstOrder.category || "UNKNOWN";
      const firstOrderAt = normalizeDate(firstOrder.orderDate);

      let firstServiceOrderAt: Date | null = null;
      if (categoryContainsProduct(firstOrderCategory)) {
        for (let i = 1; i < orders.length; i += 1) {
          const o = orders[i];
          const oDate = normalizeDate(o.orderDate);
          if (oDate && categoryContainsService(o.category || "UNKNOWN")) {
            firstServiceOrderAt = oDate;
            break;
          }
        }
      }

      const lastOrder = orders[orders.length - 1];
      const lastOrderAt = normalizeDate(lastOrder.orderDate);
      const lastOrderMonth = lastOrderAt ? formatMonthKey(lastOrderAt) : null;
      if (!lastOrderMonth || !repeatByMonth.has(lastOrderMonth)) continue;

      repeatByMonth.set(lastOrderMonth, (repeatByMonth.get(lastOrderMonth) ?? 0) + 1);

      if (firstServiceOrderAt) {
        convertedByMonth.set(lastOrderMonth, (convertedByMonth.get(lastOrderMonth) ?? 0) + 1);
        details.push({
          profileId: pid,
          // 展示字段由调用方基于 CRM Profile view 回填
          customerName: null,
          firstOrderCategory: firstOrderCategory,
          firstOrderAt: (firstOrderAt ?? new Date(0)).toISOString(),
          firstServiceOrderAt: firstServiceOrderAt.toISOString(),
        });
      }
    }

    const points: CategoryConversionPoint[] = monthKeys.map((key) => {
      const repeat = repeatByMonth.get(key) ?? 0;
      const converted = convertedByMonth.get(key) ?? 0;
      return {
        month: key,
        repeatCustomerCount: repeat,
        convertedToServiceCount: converted,
        conversionRate: repeat > 0 ? converted / repeat : 0,
      };
    });

    result.set(ownerUserId, { points, details });
  }

  return result;
}

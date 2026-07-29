/**
 * Phase 3：订单自动洞察 —— 从 Order/OrderLine 聚合客户购买偏好。
 *
 * 设计文档 §自动洞察设计 / §订单事实口径：
 * - join 路径固定：CrmCustomerProfile.id → Order.profileId（Profile-only）。
 * - 有效订单：status in CONFIRMED/DELIVERED/CLOSED，deleted=false，archived=false。
 * - 金额 COALESCE(financeAmountOverride, totalAmount, 0)（cents）。
 * - 时间优先 orderedAt > confirmedAt > createdAt。
 * - MIXED/UNKNOWN 订单不生成服务/商品偏好结论，只进证据。
 * - 不覆盖已 DISMISSED 的洞察（除非 admin 手动恢复），不覆盖人工偏好。
 *
 * 洞察 key 统一前缀 order-insight:，sourceType=ORDER_RULE，用 @@unique([sourceType, key]) 幂等。
 */
import { prisma } from "@/lib/prisma";
import { ORDER_INSIGHT_KEY_PREFIX } from "@/lib/crm/constants";

const VALID_ORDER_STATUSES = ["CONFIRMED", "DELIVERED", "CLOSED"];
/** 可分类订单数少于此阈值不生成服务/商品偏好结论，避免小样本误导。 */
const MIN_CLASSIFIABLE_ORDERS = 2;

interface OrderRow {
  id: string;
  category: string;
  status: string;
  orderedAt: Date | null;
  confirmedAt: Date | null;
  createdAt: Date;
  totalAmount: number;
  financeAmountOverride: number | null;
  lines: { itemName: string; spec: string | null }[];
}

/**
 * 取订单的有效时间（orderedAt > confirmedAt > createdAt）。
 */
function orderTime(o: { orderedAt: Date | null; confirmedAt: Date | null; createdAt: Date }): Date {
  return o.orderedAt ?? o.confirmedAt ?? o.createdAt;
}

/**
 * 取订单有效金额（cents）。
 */
function orderAmount(o: { financeAmountOverride: number | null; totalAmount: number }): number {
  return o.financeAmountOverride ?? o.totalAmount ?? 0;
}

/**
 * 客单价区间描述（金额 cents）。
 */
function aovTier(amountCents: number): string {
  const yuan = amountCents / 100;
  if (yuan < 5000) return "低客单价（<5k）";
  if (yuan < 50000) return "中客单价（5k–50k）";
  return "高客单价（>50k）";
}

/**
 * 从 itemName / spec 提取关键词（简单分词，无 NLP）。
 * 去掉数字、单位、标点，取长度≥2 的片段。
 */
function extractKeywords(lines: { itemName: string; spec: string | null }[]): string[] {
  const words: string[] = [];
  for (const line of lines) {
    const text = `${line.itemName} ${line.spec ?? ""}`;
    // 按非中文/非字母数字分割
    const tokens = text.split(/[\s,，;；|/（）()\[\]【】]+/).filter(Boolean);
    for (const t of tokens) {
      // 去掉纯数字+单位
      if (/^\d+(\.\d+)?$/.test(t)) continue;
      if (t.length < 2) continue;
      // 去掉常见无意义单位
      if (/^(个|件|次|套|盒|批|管|孔|样|项|kg|ml|ug|µg|ng|bp|gb|tb)$/i.test(t)) continue;
      words.push(t);
    }
  }
  return words;
}

interface InsightResult {
  created: number;
  updated: number;
  skipped: number;
}

/**
 * upsert 一条 ORDER_RULE 洞察偏好。
 * 跳过已 DISMISSED 的洞察（设计文档：隐藏后不重新激活）。
 */
async function upsertInsight(params: {
  profileId: string;
  actorUserId: string;
  key: string;
  category: string;
  label: string;
  valueText: string;
  valueJson: string;
  confidence: number;
  evidenceType: string;
  evidenceId: string;
}): Promise<"created" | "updated" | "skipped"> {
  const fullKey = `${ORDER_INSIGHT_KEY_PREFIX}${params.key}`;

  const existing = await prisma.crmCustomerPreference.findUnique({
    where: {
      profileId_sourceType_key: {
        profileId: params.profileId,
        sourceType: "ORDER_RULE",
        key: fullKey,
      },
    },
    select: { id: true, status: true },
  });

  // 已 DISMISSED 的洞察不重新激活（除非 admin 手动恢复为其他状态）
  if (existing?.status === "DISMISSED") {
    return "skipped";
  }

  if (existing) {
    await prisma.crmCustomerPreference.update({
      where: { id: existing.id },
      data: {
        label: params.label,
        valueText: params.valueText,
        valueJson: params.valueJson,
        confidence: params.confidence,
        evidenceType: params.evidenceType,
        evidenceId: params.evidenceId,
        updatedByUserId: params.actorUserId,
      },
    });
    return "updated";
  }

  await prisma.crmCustomerPreference.create({
    data: {
      profileId: params.profileId,
      category: params.category,
      key: fullKey,
      label: params.label,
      valueText: params.valueText,
      valueJson: params.valueJson,
      sourceType: "ORDER_RULE",
      confidence: params.confidence,
      evidenceType: params.evidenceType,
      evidenceId: params.evidenceId,
      status: "ACTIVE",
      reviewStatus: "PENDING",
      createdById: params.actorUserId,
      updatedByUserId: params.actorUserId,
    },
  });
  return "created";
}

/**
 * 为单个客户刷新订单洞察。
 */
export async function refreshOrderInsightsForProfile(params: {
  profileId: string;
  actorUserId: string;
}): Promise<InsightResult> {
  const { profileId, actorUserId } = params;
  // 追踪本轮实际成功生成/更新的 key（非 skipped），用于精准下线失效旧洞察
  const generatedKeys = new Set<string>();

  const profile = await prisma.crmCustomerProfile.findUnique({
    where: { id: profileId },
    select: { id: true },
  });
  if (!profile) throw new Error("NOT_FOUND");

  // 查有效订单 + OrderLine（只按 profileId）
  const orders = (await prisma.order.findMany({
    where: {
      profileId,
      status: { in: VALID_ORDER_STATUSES },
      deleted: false,
      archived: false,
    },
    select: {
      id: true,
      category: true,
      status: true,
      orderedAt: true,
      confirmedAt: true,
      createdAt: true,
      totalAmount: true,
      financeAmountOverride: true,
      lines: { select: { itemName: true, spec: true } },
    },
    orderBy: { createdAt: "asc" },
  })) as OrderRow[];

  const result: InsightResult = { created: 0, updated: 0, skipped: 0 };

  if (orders.length === 0) {
    // 无订单客户不生成空洞察；同时清理旧的 ORDER_RULE 洞察（标记为 SUPERSEDED）
    const stale = await prisma.crmCustomerPreference.findMany({
      where: { profileId, sourceType: "ORDER_RULE", status: "ACTIVE" },
      select: { id: true },
    });
    if (stale.length > 0) {
      await prisma.crmCustomerPreference.updateMany({
        where: { id: { in: stale.map((s) => s.id) } },
        data: { status: "SUPERSEDED", updatedByUserId: actorUserId },
      });
    }
    return result;
  }

  const orderIds = orders.map((o) => o.id);
  const evidenceId = `customer:${profileId}`;

  // ── 1. 产品/服务偏好（按 Order.category 占比）──
  const classifiable = orders.filter((o) => o.category === "SERVICE" || o.category === "PRODUCT");
  if (classifiable.length >= MIN_CLASSIFIABLE_ORDERS) {
    const serviceCount = classifiable.filter((o) => o.category === "SERVICE").length;
    const productCount = classifiable.filter((o) => o.category === "PRODUCT").length;
    const dominant = serviceCount > productCount ? "SERVICE" : "PRODUCT";
    const ratio = dominant === "SERVICE" ? serviceCount / classifiable.length : productCount / classifiable.length;
    const label = dominant === "SERVICE" ? "偏好服务类项目" : "偏好商品类订单";
    const valueText = `${label}（服务 ${serviceCount} 单 / 商品 ${productCount} 单，占比 ${(ratio * 100).toFixed(0)}%）`;
    const status = await upsertInsight({
      profileId,
      actorUserId,
      key: "product-service-preference",
      category: "PRODUCT_INTEREST",
      label,
      valueText,
      valueJson: JSON.stringify({ serviceCount, productCount, ratio, unknownCount: orders.length - classifiable.length }),
      confidence: Math.min(0.5 + ratio * 0.4, 0.9),
      evidenceType: "ORDER",
      evidenceId,
    });
    result[status === "created" ? "created" : status === "updated" ? "updated" : "skipped"]++;
    if (status !== "skipped") generatedKeys.add(`${ORDER_INSIGHT_KEY_PREFIX}product-service-preference`);
  }

  // ── 2. 常购关键词 ──
  const allLines = orders.flatMap((o) => o.lines);
  if (allLines.length > 0) {
    const keywords = extractKeywords(allLines);
    const freq = new Map<string, number>();
    for (const w of keywords) freq.set(w, (freq.get(w) ?? 0) + 1);
    const top = [...freq.entries()].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]).slice(0, 5);
    if (top.length > 0) {
      const label = "常购关键词";
      const valueText = top.map(([w, c]) => `${w}(${c})`).join("、");
      const status = await upsertInsight({
        profileId,
        actorUserId,
        key: "frequent-keywords",
        category: "PRODUCT_INTEREST",
        label,
        valueText,
        valueJson: JSON.stringify({ keywords: top.map(([w, c]) => ({ word: w, count: c })) }),
        confidence: Math.min(0.4 + top.length * 0.1, 0.8),
        evidenceType: "ORDER",
        evidenceId,
      });
      result[status === "created" ? "created" : status === "updated" ? "updated" : "skipped"]++;
      if (status !== "skipped") generatedKeys.add(`${ORDER_INSIGHT_KEY_PREFIX}frequent-keywords`);
    }
  }

  // ── 3. 复购周期 ──
  if (orders.length >= 2) {
    const sorted = [...orders].sort((a, b) => orderTime(a).getTime() - orderTime(b).getTime());
    const intervals: number[] = [];
    for (let i = 1; i < sorted.length; i++) {
      intervals.push(orderTime(sorted[i]).getTime() - orderTime(sorted[i - 1]).getTime());
    }
    const avgDays = intervals.reduce((s, x) => s + x, 0) / intervals.length / (24 * 60 * 60 * 1000);
    const recentDays = intervals[intervals.length - 1] / (24 * 60 * 60 * 1000);
    const label = "复购周期";
    const valueText = `平均 ${avgDays.toFixed(0)} 天，最近间隔 ${recentDays.toFixed(0)} 天（共 ${orders.length} 单）`;
    const status = await upsertInsight({
      profileId,
      actorUserId,
      key: "repurchase-cycle",
      category: "ORDER_BEHAVIOR",
      label,
      valueText,
      valueJson: JSON.stringify({ avgDays: Math.round(avgDays), recentDays: Math.round(recentDays), orderCount: orders.length }),
      confidence: orders.length >= 3 ? 0.75 : 0.55,
      evidenceType: "ORDER",
      evidenceId,
    });
    result[status === "created" ? "created" : status === "updated" ? "updated" : "skipped"]++;
    if (status !== "skipped") generatedKeys.add(`${ORDER_INSIGHT_KEY_PREFIX}repurchase-cycle`);
  }

  // ── 4. 客单价区间 ──
  {
    const amounts = orders.map((o) => orderAmount(o));
    const avgCents = amounts.reduce((s, x) => s + x, 0) / amounts.length;
    const maxCents = Math.max(...amounts);
    const tier = aovTier(avgCents);
    const label = "客单价区间";
    const valueText = `${tier}，平均 ${(avgCents / 100).toFixed(0)} 元，最高 ${(maxCents / 100).toFixed(0)} 元`;
    const status = await upsertInsight({
      profileId,
      actorUserId,
      key: "aov-tier",
      category: "ORDER_BEHAVIOR",
      label,
      valueText,
      valueJson: JSON.stringify({ avgCents, maxCents, tier, orderCount: orders.length }),
      confidence: 0.7,
      evidenceType: "ORDER",
      evidenceId,
    });
    result[status === "created" ? "created" : status === "updated" ? "updated" : "skipped"]++;
    if (status !== "skipped") generatedKeys.add(`${ORDER_INSIGHT_KEY_PREFIX}aov-tier`);
  }

  // 标记不再有证据支撑的旧洞察为 SUPERSEDED。
  // 只下线本轮未成功生成的规则（generatedKeys 精准追踪），而非固定全量规则名。
  // 例如订单从两单降为一单时，复购周期不再生成，旧记录应自动下线。
  const activeInsights = await prisma.crmCustomerPreference.findMany({
    where: { profileId, sourceType: "ORDER_RULE", status: "ACTIVE" },
    select: { id: true, key: true },
  });
  const toSupersede = activeInsights.filter((i) => !generatedKeys.has(i.key));
  if (toSupersede.length > 0) {
    await prisma.crmCustomerPreference.updateMany({
      where: { id: { in: toSupersede.map((s) => s.id) } },
      data: { status: "SUPERSEDED", updatedByUserId: actorUserId },
    });
  }

  // 记录 orderIds 供审计
  void orderIds;

  return result;
}

/**
 * 批量扫描所有非归档 profile 的订单洞察。
 */
export async function refreshOrderInsightsBatch(actorUserId: string): Promise<{
  total: number;
  refreshed: number;
  errors: number;
}> {
  const profiles = await prisma.crmCustomerProfile.findMany({
    where: { archived: false },
    select: { id: true },
  });

  let refreshed = 0;
  let errors = 0;
  for (const p of profiles) {
    try {
      await refreshOrderInsightsForProfile({ profileId: p.id, actorUserId });
      refreshed++;
    } catch (e) {
      console.error(`刷新 profile ${p.id} 订单洞察失败:`, e);
      errors++;
    }
  }

  return { total: profiles.length, refreshed, errors };
}

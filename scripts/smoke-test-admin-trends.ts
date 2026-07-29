/**
 * ADMIN 趋势数据层 smoke（直接对 dev DB 调用 lib 层，不走 HTTP，无需账号）。
 *
 * 用 @next/env 加载仓库根的 .env，复用 @/lib/prisma 单例与 @/lib/crm/admin-trends。
 * 只读不写，结尾 prisma.$disconnect()。
 *
 * 运行: npx tsx scripts/smoke-test-admin-trends.ts
 */

import { loadEnvConfig } from "@next/env";
import path from "node:path";

// 加载仓库根目录的 .env（process.cwd 默认为仓库根）
loadEnvConfig(path.resolve(__dirname, ".."));

let pass = 0;
let fail = 0;

function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`  ✓ ${msg}`);
    pass++;
  } else {
    console.log(`  ✗ ${msg}`);
    fail++;
  }
}

function assertEq<T>(actual: T, expected: T, msg: string) {
  assert(
    actual === expected,
    `${msg} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`,
  );
}

/** 服务器本地日期 "YYYY-MM-DD"。 */
function formatLocalDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 解析 "YYYY-MM-DD" 为本地 Date（00:00）。 */
function parseLocalDate(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1, 0, 0, 0, 0);
}

async function validateWindow(days: number) {
  const { getAdminTrends } = await import("../src/lib/crm/admin-trends");
  const { prisma } = await import("../src/lib/prisma");

  console.log(`\n[窗口 days=${days}]`);
  const result = await getAdminTrends(days);

  // days clamp 不应触发
  assertEq(result.days, days, `result.days === ${days}`);

  // 长度 === days（零填充）
  assertEq(result.customerGrowth.length, days, `customerGrowth.length === ${days}`);
  assertEq(result.interactionTrend.length, days, `interactionTrend.length === ${days}`);
  assertEq(result.followUpTaskLoad.length, days, `followUpTaskLoad.length === ${days}`);

  // 日期升序且连续（相邻差 1 天）
  const dates = result.customerGrowth.map((p) => p.date);
  let ascendingAndContiguous = dates.length > 0;
  for (let i = 1; i < dates.length; i++) {
    const prev = parseLocalDate(dates[i - 1]).getTime();
    const curr = parseLocalDate(dates[i]).getTime();
    const dayMs = 24 * 60 * 60 * 1000;
    if (curr - prev !== dayMs) {
      ascendingAndContiguous = false;
      break;
    }
  }
  assert(ascendingAndContiguous, "customerGrowth 日期升序且连续（相邻差 1 天）");

  // 两个序列共享同一组日期
  const interactionDates = result.interactionTrend.map((p) => p.date);
  assert(
    JSON.stringify(interactionDates) === JSON.stringify(dates),
    "interactionTrend 与 customerGrowth 日期序列一致",
  );
  // followUpTaskLoad 也共享同一组日期
  const followUpDates = result.followUpTaskLoad.map((p) => p.date);
  assert(
    JSON.stringify(followUpDates) === JSON.stringify(dates),
    "followUpTaskLoad 与 customerGrowth 日期序列一致",
  );

  // 最后一天是今天（本地日期）
  const today = formatLocalDate(new Date());
  assertEq(dates[dates.length - 1], today, "最后一天 = 今天（本地）");

  // 每个 count >= 0 且为整数
  const allCountsValid =
    result.customerGrowth.every((p) => Number.isInteger(p.count) && p.count >= 0) &&
    result.interactionTrend.every((p) => Number.isInteger(p.count) && p.count >= 0) &&
    result.followUpTaskLoad.every((p) => Number.isInteger(p.count) && p.count >= 0);
  assert(allCountsValid, "所有 count 为非负整数");

  // totals === sum
  const sumNew = result.customerGrowth.reduce((s, p) => s + p.count, 0);
  const sumInter = result.interactionTrend.reduce((s, p) => s + p.count, 0);
  const sumFollowUp = result.followUpTaskLoad.reduce((s, p) => s + p.count, 0);
  assertEq(result.totals.newCustomers, sumNew, "totals.newCustomers === sum(customerGrowth)");
  assertEq(result.totals.interactions, sumInter, "totals.interactions === sum(interactionTrend)");
  assertEq(
    result.totals.openFollowUpTasksInWindow,
    sumFollowUp,
    "totals.openFollowUpTasksInWindow === sum(followUpTaskLoad)",
  );

  // prev* >= 0
  assert(result.totals.prevNewCustomers >= 0, "prevNewCustomers >= 0");
  assert(result.totals.prevInteractions >= 0, "prevInteractions >= 0");

  // stageDistribution 各 count > 0
  const stageCountsValid = result.stageDistribution.every((d) => d.count > 0);
  assert(stageCountsValid, "stageDistribution 各 count > 0");

  // stageDistribution sum === DB 实际 count
  const dbStageTotal = await prisma.crmCustomerProfile.count({
    where: { deleted: false, archived: false },
  });
  const stageSum = result.stageDistribution.reduce((s, d) => s + d.count, 0);
  assertEq(stageSum, dbStageTotal, "stageDistribution sum === crmCustomerProfile.count(非删除非归档)");

  // 摘要
  console.log(
    `    摘要: newCustomers=${result.totals.newCustomers} (prev ${result.totals.prevNewCustomers}), ` +
    `interactions=${result.totals.interactions} (prev ${result.totals.prevInteractions}), ` +
    `openFollowUpTasks=${result.totals.openFollowUpTasksInWindow}, ` +
    `stageDist=${result.stageDistribution.map((d) => `${d.stage}:${d.count}`).join(", ")}`,
  );
}

async function main() {
  console.log("=== getAdminTrends smoke（dev DB，只读）===");

  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL 未设置（.env 加载失败？）");
    process.exit(2);
  }
  console.log(`DATABASE_URL=${process.env.DATABASE_URL}`);

  await validateWindow(7);
  await validateWindow(30);
  await validateWindow(90);

  // clamp：days=999 → 30
  console.log("\n[clamp days=999 → 30]");
  {
    const { getAdminTrends } = await import("../src/lib/crm/admin-trends");
    const result = await getAdminTrends(999);
    assertEq(result.days, 30, "days=999 被 clamp 为 30");
    assertEq(result.customerGrowth.length, 30, "clamp 后 customerGrowth.length === 30");
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.error("❌ admin-trends smoke 失败");
    const { prisma } = await import("../src/lib/prisma");
    await prisma.$disconnect();
    process.exit(1);
  }
  console.log("✅ admin-trends smoke 通过");

  const { prisma } = await import("../src/lib/prisma");
  await prisma.$disconnect();
}

void main().catch(async (err) => {
  console.error("smoke-test-admin-trends crashed:", err);
  try {
    const { prisma } = await import("../src/lib/prisma");
    await prisma.$disconnect();
  } catch {
    // ignore
  }
  process.exit(2);
});

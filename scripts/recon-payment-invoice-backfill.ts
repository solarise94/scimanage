/**
 * 侦察脚本：摸清补录所需的源数据与目标库现状。
 * 纯只读，不写库。
 *
 * 输出：
 *  1. xlsx 主 sheet 列数、行数、样例
 *  2. 关键列（项目编号/到款1/到款时间1/开票金额/发票号/开票时间/我方开票单位/对方开票单位）非空统计
 *  3. 线上 dev 库：BillingProfile / FinanceReceipt(source/year) / ExternalOrderInvoiceRequest /
 *     CONTRACT_LEDGER 订单数 / OrderSourceRecord(CONTRACT_LEDGER) 数
 *  4. 2025 年 9 条到款明细（与 sheet 比对用）
 *  5. 多项目合并到款的 remark 样本
 *
 * 用法：npx tsx scripts/recon-payment-invoice-backfill.ts
 */
import { prisma } from "../src/lib/prisma";
import * as XLSX from "xlsx";
import * as fs from "fs";

const FILE = "historyOrder/2026-历史数据.xlsx";
const SHEET = "2025生物未结清款项";

// ── xlsx ──
const wb = XLSX.readFile(FILE);
const ws = wb.Sheets[SHEET];
if (!ws) {
  console.error(`[recon] sheet "${SHEET}" not found. available:`, wb.SheetNames);
  process.exit(1);
}
const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: null, blankrows: false });
console.log(`\n[recon] sheet "${SHEET}"`);
console.log(`  rows (含表头): ${rows.length}`);
console.log(`  cols (第 2 行宽度): ${rows[1]?.length ?? 0}`);

// 假设第 1 行是列名
const header = rows[0];
console.log(`  header(前 10):`, header.slice(0, 10));
console.log(`  header(23..41):`, header.slice(23, 41));
console.log(`  header(43..50):`, header.slice(43, 50));
console.log(`  header(51..55):`, header.slice(51, 55));

// 数据行（跳过表头）
const data = rows.slice(1).filter((r) => r && r[0] != null && String(r[0]).trim() !== "");
console.log(`  有效数据行（col0 非空）: ${data.length}`);

// 列统计
type Stat = { nonNull: number; nonZero: number; samples: unknown[] };
function statAt(idx: number): Stat {
  let nonNull = 0, nonZero = 0;
  const samples: unknown[] = [];
  for (const r of data) {
    const v = r[idx];
    if (v == null || v === "") continue;
    nonNull++;
    if (typeof v === "number" && v !== 0) nonZero++;
    else if (typeof v === "string" && v.trim() !== "" && Number(v) !== 0) nonZero++;
    if (samples.length < 3 && v != null && v !== "") samples.push(v);
  }
  return { nonNull, nonZero, samples };
}

const colsOfInterest: [number, string][] = [
  [0, "项目编号(A)"],
  [3, "对方单位(D)"],
  [4, "客户(E)"],
  [14, "项目金额(O)"],
  [23, "开票金额(X)"],
  [24, "开票单位(Y)"],
  [33, "开票备注(AH)"],
  [34, "我方开票单位(AI)"],
  [35, "对方开票单位(AJ)"],
  [36, "开票金额1(AK)"],
  [37, "开票时间1(AL)"],
  [38, "开票金额2(AM)"],
  [39, "开票时间2(AN)"],
  [40, "发票号(AO)"],
  [43, "到款1(AR)"],
  [45, "到款时间1(AT)"],
  [46, "到款账户1(AU)"],
  [47, "到款2(AV)"],
  [49, "到款时间2(AX)"],
  [51, "总应收款(AZ)"],
  [54, "是否结清(BC)"],
];
console.log("\n[recon] 列统计");
for (const [idx, name] of colsOfInterest) {
  const s = statAt(idx);
  console.log(`  ${name.padEnd(22)} nonNull=${String(s.nonNull).padStart(4)}  nonZero/present=${String(s.nonZero).padStart(4)}  samples=${JSON.stringify(s.samples)}`);
}

async function main() {
  // 多项目合并到款：remark 中含多个"项目编号：XXXX，YYYY"
  const mergedReceipts = await prisma.financeReceipt.findMany({
    where: { source: "CONTRACT_IMPORT", deleted: false },
    select: { id: true, remark: true, amount: true, receivedAt: true, orderId: true },
  });
const multiProjectRemarks = mergedReceipts.filter(
  (r) => r.remark && /项目编号[：:].+[，,]/.test(r.remark)
);
console.log(`\n[recon] 线上多项目合并到款候选 (remark 含多个项目编号): ${multiProjectRemarks.length}`);
for (const r of multiProjectRemarks.slice(0, 5)) {
  console.log(`  - id=${r.id.slice(0, 8)} orderId=${r.orderId?.slice(0, 8)} amt=${r.amount} @${r.receivedAt.toISOString().slice(0, 10)} remark="${r.remark}"`);
}

// ── 线上现状 ──
const [profiles, totalReceipts, totalInvoices, contractLedgerOrders, osrCount] = await Promise.all([
  prisma.billingProfile.findMany({ select: { id: true, name: true, isDefault: true, archived: true } }),
  prisma.financeReceipt.count({ where: { deleted: false } }),
  prisma.externalOrderInvoiceRequest.count({ where: { status: { not: "CANCELLED" } } }),
  prisma.order.count({ where: { source: "CONTRACT_LEDGER", deleted: false } }),
  prisma.orderSourceRecord.count({ where: { source: "CONTRACT_LEDGER" } }),
]);
console.log(`\n[recon] 线上现状`);
console.log(`  BillingProfile: ${profiles.length}`);
for (const p of profiles) {
  console.log(`    - ${p.name} (default=${p.isDefault}, archived=${p.archived}, id=${p.id})`);
}
console.log(`  FinanceReceipt(deleted=false): ${totalReceipts}`);
console.log(`  ExternalOrderInvoiceRequest(non-CANCELLED): ${totalInvoices}`);
console.log(`  Order(CONTRACT_LEDGER, deleted=false): ${contractLedgerOrders}`);
console.log(`  OrderSourceRecord(CONTRACT_LEDGER): ${osrCount}`);

// 按 source 分布
const receiptsBySource = await prisma.financeReceipt.groupBy({
  by: ["source"],
  where: { deleted: false },
  _count: { _all: true },
});
console.log(`\n[recon] FinanceReceipt 按 source:`);
for (const g of receiptsBySource) {
  console.log(`  - ${g.source}: ${g._count._all}`);
}

// 2025 年 9 条到款
const rec2025 = await prisma.financeReceipt.findMany({
  where: {
    deleted: false,
    receivedAt: { gte: new Date("2025-01-01"), lt: new Date("2026-01-01") },
  },
  select: {
    id: true, amount: true, receivedAt: true, source: true, remark: true, orderId: true,
    order: { select: { externalOrderNo: true, title: true } },
  },
  orderBy: { receivedAt: "asc" },
});
console.log(`\n[recon] 2025 年到款: ${rec2025.length}`);
for (const r of rec2025) {
  console.log(`  - ${r.receivedAt.toISOString().slice(0, 10)} amt=${r.amount} src=${r.source} orderNo=${r.order?.externalOrderNo ?? "null"} title=${(r.order?.title ?? "").slice(0, 30)} remark="${r.remark ?? ""}"`);
}

// 按年份聚合
const yearAgg = await prisma.financeReceipt.groupBy({
  by: ["source"],
  where: { deleted: false },
  _count: { _all: true },
  _sum: { amount: true },
});
// 按 receivedAt 年份聚合（groupBy 不支持函数，拉全量在内存聚合）
const allReceipts = await prisma.financeReceipt.findMany({
  where: { deleted: false },
  select: { amount: true, receivedAt: true },
});
const byYear = new Map<number, { count: number; sum: number }>();
for (const r of allReceipts) {
  const y = r.receivedAt.getUTCFullYear();
  const cur = byYear.get(y) ?? { count: 0, sum: 0 };
  cur.count++;
  cur.sum += r.amount;
  byYear.set(y, cur);
}
console.log(`\n[recon] FinanceReceipt 按年份:`);
for (const [y, v] of [...byYear.entries()].sort((a, b) => a[0] - b[0])) {
  console.log(`  - ${y}: count=${v.count} sum(cents)=${v.sum}`);
}

await prisma.$disconnect();
}

main().catch((e) => {
  console.error("[recon] fatal:", e);
  process.exit(1);
});

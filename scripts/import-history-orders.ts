/**
 * 一次性历史数据导入脚本（2025 + 2026）。
 * 直接调用 parser + commit，不经过 HTTP，速度快。
 * 用于 demo/prod 数据库重建。导入顺序：2025 先行 → 2026 后继。
 *
 * 用法：
 *   DEMO_DB=1 npx tsx scripts/import-history-orders.ts          # 导入到 demo 库
 *   npx tsx scripts/import-history-orders.ts                     # 导入到仓库 dev.db（默认）
 *
 * 环境变量：
 *   HISTORY_ADMIN_EMAIL  指定执行导入的 ADMIN 邮箱（默认取第一个 ADMIN）
 */
import { prisma } from "../src/lib/prisma";
import * as fs from "fs";
import { parseContractLedger } from "../src/lib/orders/contract-ledger-parser";
import { parseHistory2025 } from "../src/lib/orders/contract-ledger-parser-2025";
import { commitContractLedger } from "../src/lib/orders/contract-ledger-commit";
import { parseAdvanceRecords } from "../src/lib/orders/advance-records-parser";
import { commitAdvanceRecords } from "../src/lib/orders/advance-records-commit";

const FILE_2025 = "historyOrder/2025-历史数据.xlsx";
const FILE_2026 = "historyOrder/2026-历史数据.xlsx";
const SHEET_2026 = "26年生物收入&成本";
const SHEET_ADVANCE = "预存款客户项目";

/**
 * 技术支持映射：闫文欣 保留，其余（韩双/任鑫/王哲/空值/其他）一律改为韩双。
 * 用户规则：技术支持如果不是闫文欣，就全部给韩双。
 * 对 rows 原地修改 techSupport 字段。
 */
function applyTechSupportMapping<T extends { techSupport: string | null }>(rows: T[]): { kept: number; mapped: number; empty: number } {
  let kept = 0, mapped = 0, empty = 0;
  for (const r of rows) {
    const v = r.techSupport?.trim();
    if (!v) {
      r.techSupport = "韩双";
      empty++;
    } else if (v === "闫文欣") {
      kept++;
    } else {
      r.techSupport = "韩双";
      mapped++;
    }
  }
  return { kept, mapped, empty };
}

async function main() {
  // 找一个 ADMIN 作为操作人
  const adminEmail = process.env.HISTORY_ADMIN_EMAIL;
  const admin = adminEmail
    ? await prisma.user.findFirst({ where: { email: adminEmail, role: "ADMIN" }, select: { id: true, email: true } })
    : await prisma.user.findFirst({ where: { role: "ADMIN" }, select: { id: true, email: true }, orderBy: { createdAt: "asc" } });
  if (!admin) {
    throw new Error("找不到 ADMIN 用户，请用 HISTORY_ADMIN_EMAIL 指定或先创建 ADMIN");
  }
  console.log(`[setup] admin: ${admin.email} (${admin.id})`);

  // ── 导入 2025 ──
  console.log("\n========== 导入 2025 历史数据 ==========");
  const buf2025 = fs.readFileSync(FILE_2025);
  const p2025 = parseHistory2025(buf2025);
  console.log(`[parse 2025] rows=${p2025.rows.length} errors=${p2025.errors.length} invoices=${p2025.summary.invoiceCount} pureCost=${p2025.summary.pureCostRows}`);
  if (p2025.errors.length > 0) {
    console.log("[parse 2025 errors]", JSON.stringify(p2025.errors.slice(0, 10)));
  }
  if (p2025.rows.length === 0) throw new Error("2025 无可导入行");

  // 技术支持映射：非闫文欣 → 韩双
  const ts2025 = applyTechSupportMapping(p2025.rows);
  console.log(`  [techSupport] kept(闫文欣)=${ts2025.kept} mapped(→韩双)=${ts2025.mapped} empty(→韩双)=${ts2025.empty}`);

  const t0 = Date.now();
  const res2025 = await commitContractLedger(p2025.rows, admin.id, {
    customerMode: "MATCH_ONLY",
    organizationMode: "CREATE_IF_MISSING",
    sourceRemark: "2025历史数据导入",
  });
  console.log(`[commit 2025] ${Date.now() - t0}ms created=${res2025.created} updated=${res2025.updated} skipped=${res2025.skipped}`);
  console.log(`  stats: ${JSON.stringify(res2025.stats)}`);
  if (res2025.errors.length > 0) {
    console.log(`  errors (${res2025.errors.length}):`, JSON.stringify(res2025.errors.slice(0, 5)));
  }
  if (res2025.warnings.length > 0) {
    console.log(`  warnings (${res2025.warnings.length}):`, JSON.stringify(res2025.warnings.slice(0, 5)));
  }

  // ── 导入预存款充值记录（在 2026 之前，让抵扣行 FIFO 能命中）──
  console.log("\n========== 导入预存款充值记录 ==========");
  // 充值记录在 2026 文件的「预存款客户项目」sheet（两份文件内容相同）
  const bufAdv = fs.readFileSync(FILE_2026);
  const pAdv = parseAdvanceRecords(bufAdv, SHEET_ADVANCE);
  console.log(`[parse advance] rows=${pAdv.rows.length} errors=${pAdv.errors.length} totalAmount=${pAdv.summary.totalAmountCents} customerTeams=${pAdv.summary.customerTeams.length}`);
  if (pAdv.errors.length > 0) {
    console.log("[parse advance errors]", JSON.stringify(pAdv.errors.slice(0, 10)));
  }
  if (pAdv.rows.length > 0) {
    const tAdv = Date.now();
    const resAdv = await commitAdvanceRecords(pAdv.rows, admin.id, {
      customerMode: "CREATE_IF_MISSING",
      organizationMode: "CREATE_IF_MISSING",
      sourceRemark: "历史预存款充值导入",
    });
    console.log(`[commit advance] ${Date.now() - tAdv}ms created=${resAdv.created} skipped=${resAdv.skipped}`);
    console.log(`  stats: ${JSON.stringify(resAdv.stats)}`);
    if (resAdv.errors.length > 0) {
      console.log(`  errors (${resAdv.errors.length}):`, JSON.stringify(resAdv.errors.slice(0, 5)));
    }
    if (resAdv.warnings.length > 0) {
      console.log(`  warnings (${resAdv.warnings.length}):`, JSON.stringify(resAdv.warnings.slice(0, 5)));
    }
  }

  // ── 导入 2026 ──
  console.log("\n========== 导入 2026 历史数据 ==========");
  const buf2026 = fs.readFileSync(FILE_2026);
  const p2026 = parseContractLedger(buf2026, SHEET_2026);
  console.log(`[parse 2026] rows=${p2026.rows.length} errors=${p2026.errors.length} invoices=${p2026.summary.invoiceCount} receipts=${p2026.summary.receiptCount} parentChild=${p2026.summary.parentChildRows}`);
  if (p2026.errors.length > 0) {
    console.log("[parse 2026 errors]", JSON.stringify(p2026.errors.slice(0, 10)));
  }
  if (p2026.rows.length === 0) throw new Error("2026 无可导入行");

  // 技术支持映射：非闫文欣 → 韩双
  const ts2026 = applyTechSupportMapping(p2026.rows);
  console.log(`  [techSupport] kept(闫文欣)=${ts2026.kept} mapped(→韩双)=${ts2026.mapped} empty(→韩双)=${ts2026.empty}`);

  const t1 = Date.now();
  const res2026 = await commitContractLedger(p2026.rows, admin.id, {
    customerMode: "MATCH_ONLY",
    organizationMode: "CREATE_IF_MISSING",
    sourceRemark: "2026历史数据导入",
  });
  console.log(`[commit 2026] ${Date.now() - t1}ms created=${res2026.created} updated=${res2026.updated} skipped=${res2026.skipped}`);
  console.log(`  stats: ${JSON.stringify(res2026.stats)}`);
  if (res2026.errors.length > 0) {
    console.log(`  errors (${res2026.errors.length}):`, JSON.stringify(res2026.errors.slice(0, 5)));
  }
  if (res2026.warnings.length > 0) {
    console.log(`  warnings (${res2026.warnings.length}):`, JSON.stringify(res2026.warnings.slice(0, 5)));
  }

  // ── 验证 ──
  console.log("\n========== 验证 ==========");
  const orderCount = await prisma.order.count({ where: { source: "CONTRACT_LEDGER", deleted: false } });
  console.log(`CONTRACT_LEDGER 订单总数: ${orderCount} (期望 1255 = 634 + 621)`);
  const p2025Count = await prisma.order.count({
    where: { source: "CONTRACT_LEDGER", externalOrderNo: { startsWith: "25" }, deleted: false },
  });
  const p2026Count = await prisma.order.count({
    where: { source: "CONTRACT_LEDGER", externalOrderNo: { startsWith: "26" }, deleted: false },
  });
  console.log(`  25xxxx: ${p2025Count} (期望 634)`);
  console.log(`  26xxxx: ${p2026Count} (期望 621)`);

  const invCount = await prisma.externalOrderInvoiceRequest.count({ where: { order: { source: "CONTRACT_LEDGER" } } });
  const recCount = await prisma.financeReceipt.count({ where: { order: { source: "CONTRACT_LEDGER" } } });
  const costCount = await prisma.financeCost.count({ where: { sourceType: "CONTRACT_IMPORT" } });
  console.log(`发票: ${invCount}, 到款: ${recCount}, 成本: ${costCount}`);

  const negCount = await prisma.order.count({
    where: { source: "CONTRACT_LEDGER", totalAmount: { lt: 0 }, deleted: false },
  });
  console.log(`负金额行(冲红/退款): ${negCount}`);

  const advCount = await prisma.financeAdvance.count();
  const advRefundCount = await prisma.financeAdvanceRefund.count();
  console.log(`FinanceAdvance(充值): ${advCount}, FinanceAdvanceRefund(核销): ${advRefundCount}`);

  console.log("\n✅ 导入完成");
}

main()
  .catch((e) => {
    console.error("[ERROR]", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

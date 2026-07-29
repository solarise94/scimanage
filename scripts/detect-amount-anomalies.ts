/**
 * 金额字段异常数据检测脚本
 *
 * 用途：在 Float→Int 迁移前，扫描数据库找出超过 2 位小数或明显异常的金额记录。
 * 用法：npx tsx scripts/detect-amount-anomalies.ts [db-path]
 *   不传 db-path 时默认 prisma/dev.db
 *
 * 输出：异常记录列表（表名、ID、字段、当前值、问题描述）
 * 退出码：0=无异常，1=有异常（需人工确认后再迁移）
 */
import Database from "better-sqlite3";

const dbPath = process.argv[2] || "prisma/dev.db";
const db = new Database(dbPath, { readonly: true });

// 财务口径字段清单（表名 → [字段名]）
const FIELDS: Record<string, string[]> = {
  Order: ["totalAmount", "financeAmountOverride"],
  OrderLine: ["unitPrice", "amount"],
  Project: ["budgetAmount", "budgetCost"],
  ProjectInvoice: ["totalAmount"],
  ProjectInvoiceItem: ["amount"],
  ExternalOrder: ["grossAmount", "priceAdjustment", "paidAmount", "shippingFee", "financeAmountOverride"],
  ExternalOrderInvoiceRequest: ["totalAmount"],
  ExternalOrderInvoiceItem: ["amount"],
  FinanceReceipt: ["amount"],
  FinanceReceiptDeletionLog: ["amount"],
  FinanceReceiptAllocation: ["amount"],
  FinanceAdvance: ["amount"],
  FinanceAdvanceRefund: ["amount"],
  FinanceCost: ["amount"],
  OrderProjectLink: ["allocatedAmount"],
  OrderRevision: ["oldTotalAmount", "newTotalAmount", "deltaTotalAmount", "oldFinanceAmount", "newFinanceAmount", "deltaFinanceAmount"],
};

interface Anomaly {
  table: string;
  id: string;
  field: string;
  value: number;
  issue: string;
}

const anomalies: Anomaly[] = [];

function checkValue(table: string, id: string, field: string, value: number | null) {
  if (value === null || value === undefined) return;

  // 检查 1：超过 2 位小数（×100 后非整数）
  const cents = value * 100;
  if (Math.abs(cents - Math.round(cents)) > 0.001) {
    anomalies.push({ table, id, field, value, issue: `超过2位小数（×100=${cents.toFixed(6)}）` });
  }

  // 检查 2：NaN / Infinity
  if (!Number.isFinite(value)) {
    anomalies.push({ table, id, field, value, issue: "非有限数值（NaN/Infinity）" });
  }

  // 检查 3：超大值（> 10亿 元，可能是脏数据）
  if (Math.abs(value) > 1_000_000_000) {
    anomalies.push({ table, id, field, value, issue: "超大值（>10亿元）" });
  }
}

for (const [table, fields] of Object.entries(FIELDS)) {
  // 检查表是否存在
  const tableExists = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name=?`
  ).get(table);
  if (!tableExists) {
    console.log(`[跳过] 表 ${table} 不存在`);
    continue;
  }

  const rows = db.prepare(`SELECT id, ${fields.join(", ")} FROM "${table}"`).all() as Record<string, unknown>[];
  for (const row of rows) {
    for (const field of fields) {
      checkValue(table, String(row.id), field, row[field] as number);
    }
  }
  console.log(`[扫描] ${table}: ${rows.length} 行 × ${fields.length} 字段`);
}

db.close();

console.log("\n" + "=".repeat(60));
if (anomalies.length === 0) {
  console.log("✅ 未发现异常数据，可以安全迁移。");
  process.exit(0);
} else {
  console.log(`⚠️  发现 ${anomalies.length} 条异常数据，需人工确认后再迁移：\n`);
  for (const a of anomalies) {
    console.log(`  ${a.table}.${a.field} id=${a.id}: ${a.value} (${a.issue})`);
  }
  process.exit(1);
}

/**
 * §4.5 历史数据回填：OrderInvoiceCoverage.amount + FinanceReceiptAllocation.orderId
 *
 * finance-invoice-architecture-review-2026-07-01.md §4.5。停服迁移，fail-closed，无自动修复。
 * 用 raw SQL（better-sqlite3），因而同时适配 db push 前后的列状态。
 *
 * 两阶段（脚本按 OrderInvoiceCoverage.amount 列是否存在自动判定）：
 *
 *   ── PRE 阶段（db push 之前：coverage 无 amount 列、allocation.orderId 可空）──
 *     把 FinanceReceiptAllocation.orderId 从可空回填为具体订单；无法唯一归属 → 中止。
 *     （db push 会把该列改为 NOT NULL，残留 NULL 会导致 push 失败。）
 *     完成后请运维执行： npx prisma db push
 *
 *   ── POST 阶段（db push 之后：coverage.amount 已加列默认 0、allocation.orderId 已 NOT NULL）──
 *     按 §4.5 规则回填 OrderInvoiceCoverage.amount，并为缺失订单补 coverage 行：
 *       1. 单订单发票：coverage.amount = invoice.totalAmount（缺行则补主订单行）。
 *       2. 多订单发票：各订单有效财务金额之和 == invoice.totalAmount → 按有效财务金额回填；否则中止。
 *       3. legacy externalOrderId / ExternalOrderInvoiceCoverage：唯一映射 Order.legacyExternalOrderId 才纳入；缺失或多义 → 中止。
 *     有效财务金额 = Order.financeAmountOverride ?? Order.totalAmount。
 *     回填后请运行不变量扫描： npx tsx scripts/scan-invoice-invariants.ts <db>
 *
 * 用法：
 *   # dry-run（默认，只报告不写）
 *   npx tsx scripts/migrate-invoice-coverage-backfill.ts <db-path>
 *   # 实际写入
 *   npx tsx scripts/migrate-invoice-coverage-backfill.ts <db-path> --apply
 *
 * 退出码：0=成功（含 dry-run 无异常），1=检测到需人工处理的异常并中止，2=用法/环境错误。
 */
import Database from "better-sqlite3";

const dbPath = process.argv[2];
const APPLY = process.argv.includes("--apply");

if (!dbPath || dbPath.startsWith("--")) {
  console.error("用法: npx tsx scripts/migrate-invoice-coverage-backfill.ts <db-path> [--apply]");
  process.exit(2);
}

const db = new Database(dbPath);
db.pragma("foreign_keys = ON");

function tableCols(table: string): Array<{ name: string; notnull: number }> {
  return db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string; notnull: number }>;
}

const covCols = tableCols("OrderInvoiceCoverage");
if (covCols.length === 0) {
  console.error("[backfill] 找不到 OrderInvoiceCoverage 表，确认 db 路径正确");
  process.exit(2);
}
const hasCoverageAmount = covCols.some((c) => c.name === "amount");

const cid = (id: string) => id.slice(-6);

// ── 通用：解析某发票 touched 的全部订单 ID（结构化，禁止名称猜测）──
type OrderRow = { id: string; totalAmount: number; financeAmountOverride: number | null };

const orderById = new Map<string, OrderRow>();
for (const o of db.prepare(`SELECT id, totalAmount, financeAmountOverride FROM "Order"`).all() as OrderRow[]) {
  orderById.set(o.id, o);
}
// legacyExternalOrderId -> Order.id （唯一约束保证单值；仍显式校验多义）
const orderByLegacy = new Map<string, string[]>();
for (const r of db.prepare(`SELECT id, legacyExternalOrderId FROM "Order" WHERE legacyExternalOrderId IS NOT NULL`).all() as Array<{ id: string; legacyExternalOrderId: string }>) {
  const list = orderByLegacy.get(r.legacyExternalOrderId) || [];
  list.push(r.id);
  orderByLegacy.set(r.legacyExternalOrderId, list);
}

type Abort = { invoiceId?: string; allocationId?: string; orderId?: string; reason: string; detail?: string };
const aborts: Abort[] = [];

/**
 * 解析发票关联的订单集合。
 * legacyRequired=true 时（POST 阶段）会把 legacy externalOrderId / 覆盖行映射进来，映射缺失或多义登记为中止。
 * 返回 null 表示遇到多义 legacy 映射（已登记 abort）。
 */
function resolveTouchedOrders(invoiceId: string, invoiceOrderId: string | null, invoiceExternalOrderId: string | null): Set<string> | null {
  const touched = new Set<string>();
  if (invoiceOrderId) touched.add(invoiceOrderId);

  // 新 coverage 行
  for (const r of db.prepare(`SELECT orderId FROM OrderInvoiceCoverage WHERE invoiceRequestId = ?`).all(invoiceId) as Array<{ orderId: string }>) {
    touched.add(r.orderId);
  }

  let hadAmbiguous = false;
  const mapLegacy = (extId: string) => {
    const mapped = orderByLegacy.get(extId);
    if (!mapped || mapped.length === 0) {
      aborts.push({ invoiceId, reason: "legacy externalOrderId 无法映射到 Order.legacyExternalOrderId", detail: extId });
      hadAmbiguous = true;
      return;
    }
    if (mapped.length > 1) {
      aborts.push({ invoiceId, reason: "legacy externalOrderId 映射到多个 Order（多义）", detail: `${extId} -> ${mapped.join(",")}` });
      hadAmbiguous = true;
      return;
    }
    touched.add(mapped[0]);
  };

  if (invoiceExternalOrderId) mapLegacy(invoiceExternalOrderId);
  for (const r of db.prepare(`SELECT externalOrderId FROM ExternalOrderInvoiceCoverage WHERE invoiceRequestId = ?`).all(invoiceId) as Array<{ externalOrderId: string }>) {
    mapLegacy(r.externalOrderId);
  }

  return hadAmbiguous ? null : touched;
}

function effAmount(orderId: string): number | null {
  const o = orderById.get(orderId);
  if (!o) return null;
  return o.financeAmountOverride ?? o.totalAmount;
}

// ───────────────────────── PRE 阶段 ─────────────────────────
if (!hasCoverageAmount) {
  console.log(`[backfill] 阶段=PRE（coverage 无 amount 列）  db=${dbPath}  mode=${APPLY ? "APPLY" : "DRY-RUN"}`);

  const nullAllocs = db.prepare(`SELECT id, invoiceId FROM FinanceReceiptAllocation WHERE orderId IS NULL`).all() as Array<{ id: string; invoiceId: string }>;
  console.log(`[backfill] 待回填 allocation.orderId: ${nullAllocs.length} 条`);

  const updates: Array<{ id: string; orderId: string }> = [];
  for (const a of nullAllocs) {
    const inv = db.prepare(`SELECT id, orderId, externalOrderId FROM ExternalOrderInvoiceRequest WHERE id = ?`).get(a.invoiceId) as { id: string; orderId: string | null; externalOrderId: string | null } | undefined;
    if (!inv) {
      aborts.push({ allocationId: a.id, invoiceId: a.invoiceId, reason: "allocation 指向的发票不存在" });
      continue;
    }
    const touched = resolveTouchedOrders(inv.id, inv.orderId, inv.externalOrderId);
    if (touched === null) continue; // legacy 多义，已登记
    const ids = [...touched];
    if (ids.length === 1) {
      updates.push({ id: a.id, orderId: ids[0] });
    } else {
      aborts.push({ allocationId: a.id, invoiceId: a.invoiceId, reason: `无法把 legacy 1-to-1 核销唯一归属到某订单（touched=${ids.length}）`, detail: ids.map(cid).join(",") });
    }
  }

  if (aborts.length > 0) {
    console.error(`\n[backfill] ✗ 检测到 ${aborts.length} 项无法自动处理，已中止（不写入）：`);
    for (const x of aborts) console.error(`  - ${x.reason}${x.detail ? ` [${x.detail}]` : ""}${x.allocationId ? ` alloc=${cid(x.allocationId)}` : ""}${x.invoiceId ? ` inv=${cid(x.invoiceId)}` : ""}`);
    db.close();
    process.exit(1);
  }

  if (APPLY && updates.length > 0) {
    const tx = db.transaction(() => {
      const stmt = db.prepare(`UPDATE FinanceReceiptAllocation SET orderId = ? WHERE id = ?`);
      for (const u of updates) stmt.run(u.orderId, u.id);
    });
    tx();
    console.log(`[backfill] ✓ 已回填 ${updates.length} 条 allocation.orderId`);
  } else {
    console.log(`[backfill] (dry-run) 将回填 ${updates.length} 条 allocation.orderId`);
  }
  console.log(`\n[backfill] PRE 阶段完成。下一步：\n  npx prisma db push\n  然后重跑本脚本进入 POST 阶段。`);
  db.close();
  process.exit(0);
}

// ───────────────────────── POST 阶段 ─────────────────────────
console.log(`[backfill] 阶段=POST（coverage.amount 已存在）  db=${dbPath}  mode=${APPLY ? "APPLY" : "DRY-RUN"}`);

// 前置：allocation.orderId 不应再有 NULL（PRE 阶段 + db push 应已处理）
const remainingNull = (db.prepare(`SELECT COUNT(*) AS n FROM FinanceReceiptAllocation WHERE orderId IS NULL`).get() as { n: number }).n;
if (remainingNull > 0) {
  console.error(`[backfill] ✗ 仍有 ${remainingNull} 条 allocation.orderId 为 NULL，请先在 PRE 阶段回填后再 db push。中止。`);
  db.close();
  process.exit(1);
}

// 收集所有「订单发票」：有任何订单关联（直接/新覆盖/legacy 直接/legacy 覆盖）
const allInvoices = db.prepare(`SELECT id, orderId, externalOrderId, totalAmount FROM ExternalOrderInvoiceRequest`).all() as Array<{ id: string; orderId: string | null; externalOrderId: string | null; totalAmount: number }>;

type Plan = { invoiceId: string; rows: Array<{ orderId: string; amount: number }>; totalAmount: number; kind: "single" | "multi" };
const plans: Plan[] = [];
let skippedNoOrder = 0;
let skippedAlreadyGood = 0;

for (const inv of allInvoices) {
  const touched = resolveTouchedOrders(inv.id, inv.orderId, inv.externalOrderId);
  if (touched === null) continue; // legacy 多义，已登记 abort
  const ids = [...touched];
  if (ids.length === 0) { skippedNoOrder++; continue; }

  // §4.0.1 前置：items 合计必须等于 totalAmount（有明细时）
  const items = db.prepare(`SELECT amount FROM ExternalOrderInvoiceItem WHERE invoiceRequestId = ?`).all(inv.id) as Array<{ amount: number }>;
  if (items.length > 0) {
    const itemSum = items.reduce((s, it) => s + it.amount, 0);
    if (itemSum !== inv.totalAmount) {
      aborts.push({ invoiceId: inv.id, reason: `items 合计(${itemSum}) ≠ totalAmount(${inv.totalAmount})（分）` });
      continue;
    }
  }

  // 现有 coverage 行（amount）
  const existing = db.prepare(`SELECT orderId, amount FROM OrderInvoiceCoverage WHERE invoiceRequestId = ?`).all(inv.id) as Array<{ orderId: string; amount: number }>;
  const existingMap = new Map(existing.map((e) => [e.orderId, e.amount]));

  // 幂等：若现有 coverage 恰好覆盖 touched 集、全部 >0 且合计 == totalAmount，则跳过
  const coversAll = ids.every((id) => existingMap.has(id)) && existing.every((e) => touched.has(e.orderId));
  const existSum = existing.reduce((s, e) => s + e.amount, 0);
  if (coversAll && existing.length === ids.length && existing.every((e) => e.amount > 0) && existSum === inv.totalAmount) {
    skippedAlreadyGood++;
    continue;
  }

  if (ids.length === 1) {
    // 规则 1：单订单发票，amount = totalAmount
    if (inv.totalAmount <= 0) {
      aborts.push({ invoiceId: inv.id, orderId: ids[0], reason: `单订单发票 totalAmount 非正(${inv.totalAmount})，无法回填正金额` });
      continue;
    }
    plans.push({ invoiceId: inv.id, rows: [{ orderId: ids[0], amount: inv.totalAmount }], totalAmount: inv.totalAmount, kind: "single" });
  } else {
    // 规则 2：多订单发票，按有效财务金额之和校验
    const rows: Array<{ orderId: string; amount: number }> = [];
    let sum = 0;
    let bad = false;
    for (const id of ids) {
      const eff = effAmount(id);
      if (eff == null) {
        aborts.push({ invoiceId: inv.id, orderId: id, reason: "touched 订单不存在，无法取有效财务金额" });
        bad = true;
        break;
      }
      if (eff <= 0) {
        aborts.push({ invoiceId: inv.id, orderId: id, reason: `订单有效财务金额非正(${eff})` });
        bad = true;
        break;
      }
      rows.push({ orderId: id, amount: eff });
      sum += eff;
    }
    if (bad) continue;
    if (sum !== inv.totalAmount) {
      aborts.push({ invoiceId: inv.id, reason: `多订单有效财务金额之和(${sum}) ≠ 发票金额(${inv.totalAmount})（分），无法按 §4.5.2 唯一回填`, detail: rows.map((r) => `${cid(r.orderId)}:${r.amount}`).join(" + ") });
      continue;
    }
    plans.push({ invoiceId: inv.id, rows, totalAmount: inv.totalAmount, kind: "multi" });
  }
}

// 汇总报告
const totalRows = plans.reduce((s, p) => s + p.rows.length, 0);
console.log(`[backfill] 发票总数=${allInvoices.length}  无订单关联跳过=${skippedNoOrder}  已就绪跳过=${skippedAlreadyGood}`);
console.log(`[backfill] 计划回填发票=${plans.length}（单订单=${plans.filter((p) => p.kind === "single").length} 多订单=${plans.filter((p) => p.kind === "multi").length}）  coverage 行=${totalRows}`);

if (aborts.length > 0) {
  console.error(`\n[backfill] ✗ 检测到 ${aborts.length} 项需人工处理，已中止（不写入，不做自动修复）：`);
  for (const x of aborts) console.error(`  - ${x.reason}${x.detail ? ` [${x.detail}]` : ""}${x.invoiceId ? ` inv=${cid(x.invoiceId)}` : ""}${x.orderId ? ` order=${cid(x.orderId)}` : ""}`);
  db.close();
  process.exit(1);
}

if (!APPLY) {
  console.log(`\n[backfill] (dry-run) 未写入。确认无异常后加 --apply 落库。`);
  db.close();
  process.exit(0);
}

// 落库：upsert coverage 行 amount（存在则更新，不存在则插入）
function cuid(): string {
  // 迁移脚本用途的简易 id（非安全随机场景）：时间戳 + 计数器
  return `covmig_${Date.now().toString(36)}_${(cuid.counter++).toString(36)}`;
}
cuid.counter = 0;

const tx = db.transaction(() => {
  const upd = db.prepare(`UPDATE OrderInvoiceCoverage SET amount = ? WHERE invoiceRequestId = ? AND orderId = ?`);
  const ins = db.prepare(`INSERT INTO OrderInvoiceCoverage (id, invoiceRequestId, orderId, amount, createdAt) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`);
  for (const p of plans) {
    for (const r of p.rows) {
      const res = upd.run(r.amount, p.invoiceId, r.orderId);
      if (res.changes === 0) {
        ins.run(cuid(), p.invoiceId, r.orderId, r.amount);
      }
    }
  }
});
tx();
console.log(`\n[backfill] ✓ 已回填 ${plans.length} 张发票、${totalRows} 条 coverage.amount。`);
console.log(`[backfill] 下一步：npx tsx scripts/scan-invoice-invariants.ts ${dbPath}`);
db.close();
process.exit(0);

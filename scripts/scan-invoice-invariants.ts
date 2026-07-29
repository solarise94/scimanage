/**
 * §4.0 财务不变量扫描（部署闸门）。
 *
 * finance-invoice-architecture-review-2026-07-01.md §4.0。任何违反 → 退出码 1，阻止部署。
 * 只读扫描（better-sqlite3），不做任何写入 / 自动修复。POST（db push 之后）运行。
 *
 * 校验的不变量：
 *   1. 每张发票：sum(items.amount) === totalAmount（分）。
 *   2. 每张「订单发票」：sum(OrderInvoiceCoverage.amount) === totalAmount。
 *   3. 每张订单发票至少有一条 coverage 行；主订单（invoice.orderId / legacy 唯一映射）必须在覆盖集合内。
 *   4. active 发票的每条 coverage.amount > 0（且为整数分）。
 *   6. 每条 FinanceReceiptAllocation 落到存在的 (invoiceId, orderId) coverage 行；
 *      同一 (invoiceId, orderId) 的未删除核销合计 <= 该 coverage 行金额。
 *   7. active 定义统一：status ∈ (DRAFT,REQUESTED,ISSUED) 且无 RED/REISSUE adjustment（本脚本据此判定，供人工核对代码一致性）。
 *
 * 不变量 5 已移除：订单 totalAmount 与发票金额不是同一口径（订单记预算/合同额，
 * 发票记实际开票额），不存在「coverage ≤ 订单金额」的恒等关系。
 * 见 docs/finance-invoice-architecture-review-2026-07-01.md §2.3 修正。
 *
 * 「订单发票」定义：有任意订单关联（invoice.orderId / externalOrderId / 新或 legacy coverage 行）。
 *
 * 用法：
 *   npx tsx scripts/scan-invoice-invariants.ts <db-path>
 * 退出码：0=全部通过，1=存在违反，2=用法/环境错误。
 */
import Database from "better-sqlite3";

const dbPath = process.argv[2];
if (!dbPath || dbPath.startsWith("--")) {
  console.error("用法: npx tsx scripts/scan-invoice-invariants.ts <db-path>");
  process.exit(2);
}

const db = new Database(dbPath, { readonly: true });

const covCols = db.prepare(`PRAGMA table_info('OrderInvoiceCoverage')`).all() as Array<{ name: string }>;
if (!covCols.some((c) => c.name === "amount")) {
  console.error("[scan] OrderInvoiceCoverage 缺少 amount 列——请先 db push 再扫描。中止。");
  process.exit(2);
}

const cid = (id: string) => id.slice(-6);
type V = { rule: number; msg: string };
const violations: V[] = [];
const push = (rule: number, msg: string) => violations.push({ rule, msg });

const ACTIVE_STATUSES = new Set(["DRAFT", "REQUESTED", "ISSUED"]);

// ── 载入基础数据 ──
type OrderRow = { id: string; totalAmount: number; financeAmountOverride: number | null };
const orderById = new Map<string, OrderRow>();
for (const o of db.prepare(`SELECT id, totalAmount, financeAmountOverride FROM "Order"`).all() as OrderRow[]) {
  orderById.set(o.id, o);
}
const orderByLegacy = new Map<string, string[]>();
for (const r of db.prepare(`SELECT id, legacyExternalOrderId FROM "Order" WHERE legacyExternalOrderId IS NOT NULL`).all() as Array<{ id: string; legacyExternalOrderId: string }>) {
  const list = orderByLegacy.get(r.legacyExternalOrderId) || [];
  list.push(r.id);
  orderByLegacy.set(r.legacyExternalOrderId, list);
}

const invoices = db.prepare(`SELECT id, status, orderId, externalOrderId, totalAmount FROM ExternalOrderInvoiceRequest`).all() as Array<{ id: string; status: string; orderId: string | null; externalOrderId: string | null; totalAmount: number }>;

// adjustments: 原发票是否被 RED/REISSUE
const redReissued = new Set<string>();
for (const a of db.prepare(`SELECT originalInvoiceId, kind FROM InvoiceAdjustment WHERE kind IN ('RED','REISSUE')`).all() as Array<{ originalInvoiceId: string; kind: string }>) {
  redReissued.add(a.originalInvoiceId);
}
const isActive = (inv: { id: string; status: string }) => ACTIVE_STATUSES.has(inv.status) && !redReissued.has(inv.id);

// coverage rows per invoice
type Cov = { orderId: string; amount: number };
const covByInvoice = new Map<string, Cov[]>();
for (const c of db.prepare(`SELECT invoiceRequestId, orderId, amount FROM OrderInvoiceCoverage`).all() as Array<{ invoiceRequestId: string; orderId: string; amount: number }>) {
  const list = covByInvoice.get(c.invoiceRequestId) || [];
  list.push({ orderId: c.orderId, amount: c.amount });
  covByInvoice.set(c.invoiceRequestId, list);
}

// items sum per invoice
const itemSumByInvoice = new Map<string, number>();
for (const it of db.prepare(`SELECT invoiceRequestId, amount FROM ExternalOrderInvoiceItem`).all() as Array<{ invoiceRequestId: string; amount: number }>) {
  itemSumByInvoice.set(it.invoiceRequestId, (itemSumByInvoice.get(it.invoiceRequestId) || 0) + it.amount);
}

function mainOrderIds(inv: { id: string; orderId: string | null; externalOrderId: string | null }): { ids: Set<string>; ambiguousLegacy: boolean } {
  const ids = new Set<string>();
  let ambiguous = false;
  if (inv.orderId) ids.add(inv.orderId);
  if (inv.externalOrderId) {
    const mapped = orderByLegacy.get(inv.externalOrderId);
    if (mapped && mapped.length === 1) ids.add(mapped[0]);
    else if (mapped && mapped.length > 1) ambiguous = true;
  }
  return { ids, ambiguousLegacy: ambiguous };
}

// ── 不变量 1：items 合计 === totalAmount ──
for (const inv of invoices) {
  const itemSum = itemSumByInvoice.get(inv.id) || 0;
  if (itemSum !== inv.totalAmount) {
    push(1, `发票 ${cid(inv.id)}: items 合计(${itemSum}) ≠ totalAmount(${inv.totalAmount})`);
  }
}

// ── 逐发票：判定是否「订单发票」并校验 2/3/4 ──
// 每订单 active coverage 累加（不变量 5）
const activeCovByOrder = new Map<string, number>();

for (const inv of invoices) {
  const cov = covByInvoice.get(inv.id) || [];
  const { ids: mainIds, ambiguousLegacy } = mainOrderIds(inv);
  const hasLegacyCoverage = (db.prepare(`SELECT COUNT(*) AS n FROM ExternalOrderInvoiceCoverage WHERE invoiceRequestId = ?`).get(inv.id) as { n: number }).n > 0;
  const isOrderInvoice = cov.length > 0 || mainIds.size > 0 || inv.externalOrderId != null || hasLegacyCoverage;

  if (ambiguousLegacy) {
    push(3, `发票 ${cid(inv.id)}: legacy externalOrderId 映射多义，无法确定主订单`);
  }

  if (!isOrderInvoice) continue;

  // 不变量 3：至少一条 coverage 行
  if (cov.length === 0) {
    push(3, `订单发票 ${cid(inv.id)}: 无任何 OrderInvoiceCoverage 行`);
  }

  // 不变量 2：coverage 合计 === totalAmount
  const covSum = cov.reduce((s, c) => s + c.amount, 0);
  if (covSum !== inv.totalAmount) {
    push(2, `订单发票 ${cid(inv.id)}: coverage 合计(${covSum}) ≠ totalAmount(${inv.totalAmount})`);
  }

  // 不变量 3：主订单必须在覆盖集合内
  const covOrderIds = new Set(cov.map((c) => c.orderId));
  for (const mid of mainIds) {
    if (!covOrderIds.has(mid)) {
      push(3, `订单发票 ${cid(inv.id)}: 主订单 ${cid(mid)} 无 coverage 行`);
    }
  }

  // 不变量 4：active 发票 coverage.amount > 0 且整数
  if (isActive(inv)) {
    for (const c of cov) {
      if (!Number.isInteger(c.amount) || c.amount <= 0) {
        push(4, `active 发票 ${cid(inv.id)} 订单 ${cid(c.orderId)}: coverage.amount 非正整数(${c.amount})`);
      }
      // 累加至订单 active coverage（不变量 5）
      activeCovByOrder.set(c.orderId, (activeCovByOrder.get(c.orderId) || 0) + c.amount);
    }
  }
}
// 不变量 5 已移除：订单 totalAmount 与发票金额不是同一口径，不做 coverage ≤ 订单金额 校验。
// activeCovByOrder 仅用于诊断（如需），不再参与闸门判定。

// ── 不变量 6：allocation 落到存在的 coverage 行，且未删除核销合计 <= coverage 金额 ──
// coverage lookup by (invoiceId, orderId)
const covAmountByKey = new Map<string, number>();
for (const [invoiceId, list] of covByInvoice) {
  for (const c of list) covAmountByKey.set(`${invoiceId}::${c.orderId}`, c.amount);
}
// 未删除核销合计 by (invoiceId, orderId)
const allocRows = db.prepare(`
  SELECT a.invoiceId AS invoiceId, a.orderId AS orderId, a.amount AS amount, r.deleted AS deleted
  FROM FinanceReceiptAllocation a
  JOIN FinanceReceipt r ON r.id = a.receiptId
`).all() as Array<{ invoiceId: string; orderId: string | null; amount: number; deleted: number }>;

const allocByKey = new Map<string, number>();
for (const a of allocRows) {
  if (a.deleted) continue;
  if (!a.orderId) {
    push(6, `allocation(inv=${cid(a.invoiceId)}): orderId 为 NULL（应在迁移中回填）`);
    continue;
  }
  const key = `${a.invoiceId}::${a.orderId}`;
  if (!covAmountByKey.has(key)) {
    push(6, `allocation inv=${cid(a.invoiceId)} order=${cid(a.orderId)}: 无对应 coverage 行`);
  }
  allocByKey.set(key, (allocByKey.get(key) || 0) + a.amount);
}
for (const [key, allocSum] of allocByKey) {
  const covAmt = covAmountByKey.get(key);
  if (covAmt == null) continue; // 已在上面登记
  if (allocSum > covAmt) {
    const [invId, ordId] = key.split("::");
    push(6, `核销超额 inv=${cid(invId)} order=${cid(ordId)}: 核销合计(${allocSum}) > coverage 金额(${covAmt})`);
  }
}

// ── 报告 ──
console.log(`[scan] db=${dbPath}  发票=${invoices.length}  coverage 行=${[...covByInvoice.values()].reduce((s, l) => s + l.length, 0)}  未删除核销键=${allocByKey.size}`);
if (violations.length === 0) {
  console.log(`[scan] ✓ 全部不变量通过。`);
  db.close();
  process.exit(0);
}

const byRule = new Map<number, V[]>();
for (const v of violations) {
  const l = byRule.get(v.rule) || [];
  l.push(v);
  byRule.set(v.rule, l);
}
console.error(`\n[scan] ✗ 检测到 ${violations.length} 项不变量违反：`);
for (const rule of [...byRule.keys()].sort((a, b) => a - b)) {
  const l = byRule.get(rule)!;
  console.error(`\n  【不变量 ${rule}】共 ${l.length} 项：`);
  for (const v of l.slice(0, 50)) console.error(`    - ${v.msg}`);
  if (l.length > 50) console.error(`    ... 其余 ${l.length - 50} 项省略`);
}
db.close();
process.exit(1);

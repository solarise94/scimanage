/**
 * Phase E backfill：把各表旧 *CustomerId* 列确定性回填到 Profile 新列。
 *
 * 方案：docs/customer-legacy-field-remediation-plan-2026-07-15.md Phase E 节。
 * 映射唯一来源：CrmCustomerProfile.sourceCustomerId（@unique）。
 *
 * 规则：
 * - 只写新列；**严禁**把 legacy 列 UPDATE 成 null 来"解决" unmappable。
 * - 生命周期同步（step 0，在 profileId 回填之前执行）：对每个 sourceCustomerId 非空的
 *   Profile，从 Customer 复制 deleted/deletedAt，并把 Customer.mergedIntoId 经
 *   sourceCustomerId 映射写入 mergedIntoProfileId（目标无 Profile 则置 null 并计数报告）。
 * - fail-closed 分级：
 *   - unmappable：仅 legacy 非空且 new 为 null 且无映射 → 逐条列出并 exit 1；
 *     new 已有效填充的（merge 后旧锚点垃圾引用，随列消失）只 warn。
 *   - mismatch：new 指向不存在的 Profile（dangling）→ 逐条列出并 exit 1；
 *     new 存在但与映射不符（stale，merge 后旧锚点过期属正常）只 warn，不擅自改。
 * - best-effort 表（历史已删客户）同样跑 UPDATE，但残留 null 不作为失败条件。
 * - 可重复执行：UPDATE 的 WHERE 含 `new IS NULL` / 值漂移条件，二次执行为 0 影响行。
 * - --apply 时全部 UPDATE 在单事务内执行（先生命周期同步，后 profileId 回填），执行前打印计划影响行数。
 *
 * 用法：
 *   npx tsx scripts/phase-e-backfill.ts [--db /abs/path/dev.db]            # dry-run（默认）
 *   npx tsx scripts/phase-e-backfill.ts [--db /abs/path/dev.db] --apply    # 单事务落库
 *
 * 退出码：fail-closed / dangling 阻断 → 1；全绿（dry-run 或 apply 成功）→ 0。
 */

import path from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// Spec（与 phase-e-precheck.ts 保持一致）
// 注意 CrmCustomerStageHistory 在 schema 中 @@map("crm_customer_stage_history")。
// ─────────────────────────────────────────────────────────────────────────────

type ColSpec = {
  table: string;
  legacyColumn: string;
  newColumn: string;
};

const HARD_GATE_SPECS: ColSpec[] = [
  { table: "Project", legacyColumn: "customerId", newColumn: "profileId" },
  { table: "ExternalOrder", legacyColumn: "customerId", newColumn: "profileId" },
  { table: "FinanceReceipt", legacyColumn: "customerId", newColumn: "profileId" },
  { table: "FinanceAdvance", legacyColumn: "customerId", newColumn: "profileId" },
  { table: "Order", legacyColumn: "customerId", newColumn: "profileId" },
  { table: "FinanceCost", legacyColumn: "customerId", newColumn: "profileId" },
  { table: "CustomerRepTag", legacyColumn: "customerId", newColumn: "profileId" },
  { table: "CrmCustomerApplication", legacyColumn: "createdCustomerId", newColumn: "createdCrmProfileId" },
  { table: "CustomerRelation", legacyColumn: "fromCustomerId", newColumn: "fromProfileId" },
  { table: "CustomerRelation", legacyColumn: "toCustomerId", newColumn: "toProfileId" },
  { table: "CrmRepresentativeReportLine", legacyColumn: "customerId", newColumn: "profileId" },
  { table: "crm_customer_stage_history", legacyColumn: "sourceCustomerId", newColumn: "profileId" },
  { table: "CustomerMergeLog", legacyColumn: "sourceCustomerId", newColumn: "sourceProfileId" },
  { table: "CustomerMergeLog", legacyColumn: "targetCustomerId", newColumn: "targetProfileId" },
  { table: "CustomerMergeTask", legacyColumn: "customerIdA", newColumn: "profileIdA" },
  { table: "CustomerMergeTask", legacyColumn: "customerIdB", newColumn: "profileIdB" },
  { table: "CustomerOrgBindingTask", legacyColumn: "customerId", newColumn: "profileId" },
  { table: "CustomerOrgTextDriftTask", legacyColumn: "customerId", newColumn: "profileId" },
  { table: "OrderImportRow", legacyColumn: "suggestedCustomerId", newColumn: "suggestedProfileId" },
  { table: "OrderImportRow", legacyColumn: "confirmedCustomerId", newColumn: "confirmedProfileId" },
  { table: "CostEntry", legacyColumn: "customerId", newColumn: "profileId" },
];

const BEST_EFFORT_SPECS: ColSpec[] = [
  { table: "FinanceReceiptDeletionLog", legacyColumn: "customerId", newColumn: "profileId" },
  { table: "ProgressReceivableAdjustment", legacyColumn: "customerId", newColumn: "profileId" },
  { table: "CustomerApiAuditLog", legacyColumn: "customerId", newColumn: "profileId" },
];

const PROFILE_TABLE = "CrmCustomerProfile";
const PROFILE_SOURCE_COLUMN = "sourceCustomerId";
const CUSTOMER_TABLE = "Customer";
const PROFILE_LIFECYCLE_COLUMNS = ["deleted", "deletedAt", "mergedIntoProfileId"] as const;
const MISMATCH_SAMPLE_LIMIT = 50;

// ─────────────────────────────────────────────────────────────────────────────
// 参数与 DB 路径解析（--db > DATABASE_URL env > 仓库 prisma/dev.db）
// ─────────────────────────────────────────────────────────────────────────────

type Args = { dbPath: string; apply: boolean };

function printUsage(): void {
  console.log(
    [
      "Usage:",
      "  npx tsx scripts/phase-e-backfill.ts [--db <path>]            # dry-run（默认，不写库）",
      "  npx tsx scripts/phase-e-backfill.ts [--db <path>] --apply    # 单事务落库",
      "",
      "fail-closed：unmappable(new 为 null) / danglingNew 任一命中 → exit 1；stale 只报告。",
    ].join("\n"),
  );
}

function resolveDbPath(dbArg: string | null): string {
  if (dbArg) return path.resolve(process.cwd(), dbArg);
  const raw = process.env.DATABASE_URL?.trim();
  if (raw?.startsWith("file:")) {
    const withoutQuery = raw.slice("file:".length).split("?")[0] ?? "";
    if (withoutQuery) {
      // Prisma 对 SQLite 相对路径相对 schema 目录（prisma/）解析
      return path.isAbsolute(withoutQuery)
        ? withoutQuery
        : path.resolve(process.cwd(), "prisma", withoutQuery);
    }
  }
  return path.resolve(process.cwd(), "prisma/dev.db");
}

function parseArgs(argv: string[]): Args {
  let dbArg: string | null = null;
  let apply = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--db") {
      dbArg = argv[i + 1] ?? null;
      i++;
      continue;
    }
    if (arg === "--apply") {
      apply = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (dbArg === "") throw new Error("--db requires a non-empty path");
  return { dbPath: resolveDbPath(dbArg), apply };
}

// ─────────────────────────────────────────────────────────────────────────────
// SQL 工具
// ─────────────────────────────────────────────────────────────────────────────

/** 标识符加双引号（"Order" 等保留字表名必须） */
function qi(ident: string): string {
  return `"${ident.replaceAll('"', '""')}"`;
}

function num(value: unknown): number {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number") return value;
  return Number(value ?? 0);
}

type PrismaLike = {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
  $transaction<T>(
    fn: (tx: PrismaLike) => Promise<T>,
    options?: { timeout?: number; maxWait?: number },
  ): Promise<T>;
  $disconnect(): Promise<void>;
};

async function tableExists(prisma: PrismaLike, table: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<Array<{ name: string }>>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = '${table.replaceAll("'", "''")}'`,
  );
  return rows.length > 0;
}

async function tableColumns(prisma: PrismaLike, table: string): Promise<Set<string>> {
  const rows = await prisma.$queryRawUnsafe<Array<{ name: string }>>(
    `PRAGMA table_info(${qi(table)})`,
  );
  return new Set(rows.map((r) => r.name));
}

async function countQuery(prisma: PrismaLike, sql: string): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<Array<{ n: number | bigint }>>(sql);
  return num(rows[0]?.n ?? 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// 可执行 spec 解析（schema 探测）
// ─────────────────────────────────────────────────────────────────────────────

type ResolvedSpec =
  | { kind: "skip"; spec: ColSpec; reason: string }
  | { kind: "blocked"; spec: ColSpec; reason: string }
  | { kind: "ready"; spec: ColSpec };

async function resolveSpec(
  prisma: PrismaLike,
  spec: ColSpec,
  hardGate: boolean,
): Promise<ResolvedSpec> {
  if (!(await tableExists(prisma, spec.table))) {
    return hardGate
      ? { kind: "blocked", spec, reason: `硬门禁表 ${spec.table} 缺失` }
      : { kind: "skip", spec, reason: `表 ${spec.table} 缺失` };
  }
  const cols = await tableColumns(prisma, spec.table);
  if (!cols.has(spec.legacyColumn)) {
    return { kind: "skip", spec, reason: `${spec.legacyColumn} 已删除（Phase E 已完成）` };
  }
  if (!cols.has(spec.newColumn)) {
    return {
      kind: "blocked",
      spec,
      reason: `新列 ${spec.table}.${spec.newColumn} 缺失（schema 未 expand）`,
    };
  }
  return { kind: "ready", spec };
}

function mappingFragments(spec: ColSpec): {
  from: string;
  legacy: string;
  nw: string;
  p: string;
  src: string;
} {
  return {
    from: qi(spec.table),
    legacy: qi(spec.legacyColumn),
    nw: qi(spec.newColumn),
    p: qi(PROFILE_TABLE),
    src: qi(PROFILE_SOURCE_COLUMN),
  };
}

/** new 非空但指向不存在的 Profile → 硬阻断 */
async function danglingRows(
  prisma: PrismaLike,
  spec: ColSpec,
  limit: number,
): Promise<Array<{ id: string; legacy: string; current: string }>> {
  const { from, legacy, nw, p } = mappingFragments(spec);
  return prisma.$queryRawUnsafe<Array<{ id: string; legacy: string; current: string }>>(
    `SELECT x.id AS id, x.${legacy} AS legacy, x.${nw} AS current
     FROM ${from} x
     WHERE x.${legacy} IS NOT NULL AND x.${nw} IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM ${p} p2 WHERE p2.id = x.${nw})
     LIMIT ${limit}`,
  );
}

/** new 存在但与映射不符（merge 后旧锚点过期）→ warn */
async function staleMismatchRows(
  prisma: PrismaLike,
  spec: ColSpec,
  limit: number,
): Promise<Array<{ id: string; legacy: string; current: string; expected: string }>> {
  const { from, legacy, nw, p, src } = mappingFragments(spec);
  return prisma.$queryRawUnsafe<
    Array<{ id: string; legacy: string; current: string; expected: string }>
  >(
    `SELECT x.id AS id, x.${legacy} AS legacy, x.${nw} AS current,
            (SELECT p.id FROM ${p} p WHERE p.${src} = x.${legacy}) AS expected
     FROM ${from} x
     WHERE x.${legacy} IS NOT NULL AND x.${nw} IS NOT NULL
       AND EXISTS (SELECT 1 FROM ${p} p WHERE p.${src} = x.${legacy})
       AND x.${nw} <> (SELECT p.id FROM ${p} p WHERE p.${src} = x.${legacy})
       AND EXISTS (SELECT 1 FROM ${p} p2 WHERE p2.id = x.${nw})
     LIMIT ${limit}`,
  );
}

/** legacy 非空、new 为 null、无映射 → 硬阻断（backfill 也救不了） */
async function unmappableRows(
  prisma: PrismaLike,
  spec: ColSpec,
): Promise<Array<{ id: string; legacy: string }>> {
  const { from, legacy, nw, p, src } = mappingFragments(spec);
  return prisma.$queryRawUnsafe<Array<{ id: string; legacy: string }>>(
    `SELECT x.id AS id, x.${legacy} AS legacy FROM ${from} x
     WHERE x.${legacy} IS NOT NULL AND x.${nw} IS NULL
       AND NOT EXISTS (SELECT 1 FROM ${p} p WHERE p.${src} = x.${legacy})
     ORDER BY x.id`,
  );
}

/** legacy 非空、new 已有效填充、无映射 → warn（随列消失的垃圾引用） */
async function unmappableFilledCount(prisma: PrismaLike, spec: ColSpec): Promise<number> {
  const { from, legacy, nw, p, src } = mappingFragments(spec);
  return countQuery(
    prisma,
    `SELECT COUNT(*) AS n FROM ${from} x
     WHERE x.${legacy} IS NOT NULL AND x.${nw} IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM ${p} p WHERE p.${src} = x.${legacy})
       AND EXISTS (SELECT 1 FROM ${p} p2 WHERE p2.id = x.${nw})`,
  );
}

async function planCount(prisma: PrismaLike, spec: ColSpec): Promise<number> {
  const { from, legacy, nw, p, src } = mappingFragments(spec);
  return countQuery(
    prisma,
    `SELECT COUNT(*) AS n FROM ${from} x
     WHERE x.${legacy} IS NOT NULL AND x.${nw} IS NULL
       AND EXISTS (SELECT 1 FROM ${p} p WHERE p.${src} = x.${legacy})`,
  );
}

function updateSql(spec: ColSpec): string {
  const { from, legacy, nw, p, src } = mappingFragments(spec);
  return `UPDATE ${from}
     SET ${nw} = (SELECT p.id FROM ${p} p WHERE p.${src} = ${from}.${legacy})
   WHERE ${legacy} IS NOT NULL AND ${nw} IS NULL
     AND EXISTS (SELECT 1 FROM ${p} p WHERE p.${src} = ${from}.${legacy})`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 生命周期同步（step 0）：Customer.deleted/deletedAt/mergedIntoId → Profile
// ─────────────────────────────────────────────────────────────────────────────

const PT = qi(PROFILE_TABLE);
const CT = qi(CUSTOMER_TABLE);
const SRC = qi(PROFILE_SOURCE_COLUMN);

/** Customer.mergedIntoId 经 sourceCustomerId 映射得到的目标 Profile id（无映射时 null） */
const DERIVED_MERGED_INTO_SQL = `(SELECT tp.id FROM ${CT} c JOIN ${PT} tp ON tp.${SRC} = c."mergedIntoId" WHERE c.id = ${PT}.${SRC})`;

/** deleted/deletedAt 漂移行数（需要同步） */
async function lifecycleDeletedPlanCount(prisma: PrismaLike): Promise<number> {
  return countQuery(
    prisma,
    `SELECT COUNT(*) AS n FROM ${PT}
     WHERE ${SRC} IS NOT NULL
       AND EXISTS (SELECT 1 FROM ${CT} c WHERE c.id = ${PT}.${SRC})
       AND (
         ${PT}."deleted" <> (SELECT c."deleted" FROM ${CT} c WHERE c.id = ${PT}.${SRC})
         OR ${PT}."deletedAt" IS NOT (SELECT c."deletedAt" FROM ${CT} c WHERE c.id = ${PT}.${SRC})
       )`,
  );
}

/** mergedIntoProfileId 漂移行数（需要同步；含目标无 Profile → 派生 null） */
async function lifecycleMergedIntoPlanCount(prisma: PrismaLike): Promise<number> {
  return countQuery(
    prisma,
    `SELECT COUNT(*) AS n FROM ${PT}
     WHERE ${SRC} IS NOT NULL
       AND EXISTS (SELECT 1 FROM ${CT} c WHERE c.id = ${PT}.${SRC})
       AND ${PT}."mergedIntoProfileId" IS NOT ${DERIVED_MERGED_INTO_SQL}`,
  );
}

/** Customer.mergedIntoId 非空但目标无 Profile 的行数（同步后 mergedIntoProfileId = null，计数报告） */
async function lifecycleMergedIntoUnmappedCount(prisma: PrismaLike): Promise<number> {
  return countQuery(
    prisma,
    `SELECT COUNT(*) AS n FROM ${PT}
     WHERE ${SRC} IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM ${CT} c
         WHERE c.id = ${PT}.${SRC}
           AND c."mergedIntoId" IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM ${PT} tp WHERE tp.${SRC} = c."mergedIntoId")
       )`,
  );
}

function lifecycleDeletedUpdateSql(): string {
  return `UPDATE ${PT}
     SET "deleted" = (SELECT c."deleted" FROM ${CT} c WHERE c.id = ${PT}.${SRC}),
         "deletedAt" = (SELECT c."deletedAt" FROM ${CT} c WHERE c.id = ${PT}.${SRC})
   WHERE ${SRC} IS NOT NULL
     AND EXISTS (SELECT 1 FROM ${CT} c WHERE c.id = ${PT}.${SRC})
     AND (
       ${PT}."deleted" <> (SELECT c."deleted" FROM ${CT} c WHERE c.id = ${PT}.${SRC})
       OR ${PT}."deletedAt" IS NOT (SELECT c."deletedAt" FROM ${CT} c WHERE c.id = ${PT}.${SRC})
     )`;
}

function lifecycleMergedIntoUpdateSql(): string {
  return `UPDATE ${PT}
     SET "mergedIntoProfileId" = ${DERIVED_MERGED_INTO_SQL}
   WHERE ${SRC} IS NOT NULL
     AND EXISTS (SELECT 1 FROM ${CT} c WHERE c.id = ${PT}.${SRC})
     AND ${PT}."mergedIntoProfileId" IS NOT ${DERIVED_MERGED_INTO_SQL}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 主流程
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  // 先设置 DATABASE_URL，再动态 import prisma 客户端（仓库脚本惯例）
  process.env.DATABASE_URL = `file:${args.dbPath}`;
  const { prisma } = (await import("../src/lib/prisma")) as unknown as { prisma: PrismaLike };

  try {
    const mode = args.apply ? "APPLY" : "DRY-RUN";
    console.log(`=== Phase E Backfill（${mode}）===`);
    console.log(`Database: ${args.dbPath}`);

    if (!(await tableExists(prisma, PROFILE_TABLE))) {
      console.error(`❌ ${PROFILE_TABLE} 表缺失，无法建立映射`);
      return 1;
    }
    const profileCols = await tableColumns(prisma, PROFILE_TABLE);
    if (!profileCols.has(PROFILE_SOURCE_COLUMN)) {
      console.error(
        `❌ ${PROFILE_TABLE}.${PROFILE_SOURCE_COLUMN} 已删除，旧 ID→Profile ID 映射不可用；` +
          `若旧列仍在则禁止继续（方案要求先回填再解除映射列）`,
      );
      return 1;
    }

    const hardResolved: ResolvedSpec[] = [];
    for (const spec of HARD_GATE_SPECS) hardResolved.push(await resolveSpec(prisma, spec, true));
    const bestResolved: ResolvedSpec[] = [];
    for (const spec of BEST_EFFORT_SPECS) bestResolved.push(await resolveSpec(prisma, spec, false));

    let blocked = false;
    for (const r of [...hardResolved, ...bestResolved]) {
      if (r.kind === "blocked") {
        console.error(`❌ ${r.reason}`);
        blocked = true;
      } else if (r.kind === "skip") {
        console.log(`⏭️  ${r.spec.table}.${r.spec.legacyColumn}: ${r.reason}`);
      }
    }
    if (blocked) return 1;

    const readyHard = hardResolved.filter((r): r is { kind: "ready"; spec: ColSpec } => r.kind === "ready");
    const readyBest = bestResolved.filter((r): r is { kind: "ready"; spec: ColSpec } => r.kind === "ready");

    // ── 0. 生命周期同步前置检查（Customer 仍在 → Profile 生命周期列必须已 expand）──
    const customerTableExists = await tableExists(prisma, CUSTOMER_TABLE);
    const lifecycleColumnsReady = PROFILE_LIFECYCLE_COLUMNS.every((c) => profileCols.has(c));
    if (customerTableExists && !lifecycleColumnsReady) {
      console.error(
        `❌ ${CUSTOMER_TABLE} 表仍存在，但 ${PROFILE_TABLE} 生命周期列（${PROFILE_LIFECYCLE_COLUMNS.join("/")}）缺失；` +
          `请先以 Phase C expand schema 执行 prisma db push 再跑本脚本`,
      );
      return 1;
    }
    const lifecycleEnabled = customerTableExists && lifecycleColumnsReady;

    // ── 1. 双写一致性校验（分级）：dangling → 阻断；stale → warn ──
    console.log("\n── 1. 双写一致性校验（dangling 阻断 / stale 警告）──");
    let danglingCount = 0;
    let staleCount = 0;
    for (const { spec } of [...readyHard, ...readyBest]) {
      const dRows = await danglingRows(prisma, spec, MISMATCH_SAMPLE_LIMIT + 1);
      if (dRows.length > 0) {
        const shown = dRows.slice(0, MISMATCH_SAMPLE_LIMIT);
        danglingCount += dRows.length;
        console.error(
          `❌ ${spec.table}.${spec.newColumn}: ${dRows.length}${dRows.length > MISMATCH_SAMPLE_LIMIT ? "+" : ""} 行指向不存在的 Profile（dangling，疑似运行时脏数据）:`,
        );
        for (const r of shown) {
          console.error(`     id=${r.id} legacy(${spec.legacyColumn})=${r.legacy} current=${r.current}`);
        }
      }
      const sRows = await staleMismatchRows(prisma, spec, MISMATCH_SAMPLE_LIMIT + 1);
      if (sRows.length > 0) {
        const shown = sRows.slice(0, MISMATCH_SAMPLE_LIMIT);
        staleCount += sRows.length;
        console.log(
          `  ⚠️ ${spec.table}.${spec.newColumn}: ${sRows.length}${sRows.length > MISMATCH_SAMPLE_LIMIT ? "+" : ""} 行与映射不符但指向存在的 Profile（stale，merge 后旧锚点过期，不阻断、不擅改）:`,
        );
        for (const r of shown) {
          console.log(
            `     id=${r.id} legacy(${spec.legacyColumn})=${r.legacy} current=${r.current} expected=${r.expected}`,
          );
        }
      }
    }
    if (danglingCount === 0 && staleCount === 0) console.log("  ✅ 无 dangling / stale");
    if (danglingCount > 0) return 1;

    // ── 2. unmappable 预检（仅硬门禁、仅 new 为 null）：逐条列出并阻断 ──
    console.log("\n── 2. 硬门禁 unmappable 预检（fail-closed，仅 new 为 null 才阻断）──");
    let unmappableCount = 0;
    let unmappableFilledTotal = 0;
    for (const { spec } of readyHard) {
      const rows = await unmappableRows(prisma, spec);
      if (rows.length > 0) {
        unmappableCount += rows.length;
        console.error(
          `❌ ${spec.table}.${spec.legacyColumn}: ${rows.length} 行 legacy 非空、new 为 null 且无 Profile 映射（严禁置 null 绕过）:`,
        );
        for (const r of rows) {
          console.error(`     table=${spec.table} id=${r.id} legacy=${r.legacy}`);
        }
      }
      const filled = await unmappableFilledCount(prisma, spec);
      if (filled > 0) {
        unmappableFilledTotal += filled;
        console.log(
          `  ⚠️ ${spec.table}.${spec.legacyColumn}: ${filled} 行 legacy 无映射但 ${spec.newColumn} 已有效填充（随列消失的垃圾引用，不阻断）`,
        );
      }
    }
    if (unmappableCount === 0) console.log("  ✅ 全部可映射（new 为 null 的行）");
    if (unmappableCount > 0) return 1;

    // ── 3. 计划影响行数（先生命周期同步，后 profileId 回填）──
    console.log("\n── 3. 同步/回填计划 ──");
    let lifecycleDeletedPlanned = 0;
    let lifecycleMergedIntoPlanned = 0;
    let lifecycleMergedIntoUnmapped = 0;
    if (lifecycleEnabled) {
      lifecycleDeletedPlanned = await lifecycleDeletedPlanCount(prisma);
      lifecycleMergedIntoPlanned = await lifecycleMergedIntoPlanCount(prisma);
      lifecycleMergedIntoUnmapped = await lifecycleMergedIntoUnmappedCount(prisma);
      console.log(
        `  [lifecycle] ${PROFILE_TABLE}.deleted/deletedAt ← ${CUSTOMER_TABLE}: ${lifecycleDeletedPlanned} 行`,
      );
      console.log(
        `  [lifecycle] ${PROFILE_TABLE}.mergedIntoProfileId ← ${CUSTOMER_TABLE}.mergedIntoId 映射: ${lifecycleMergedIntoPlanned} 行`,
      );
      if (lifecycleMergedIntoUnmapped > 0) {
        console.log(
          `  ⚠️ [lifecycle] ${lifecycleMergedIntoUnmapped} 行 Customer.mergedIntoId 目标无 Profile，mergedIntoProfileId 将置 null`,
        );
      }
    } else {
      console.log(`  [lifecycle] ${CUSTOMER_TABLE} 表不存在（Phase E contract 已完成），跳过生命周期同步`);
    }

    const plans: Array<{ spec: ColSpec; hardGate: boolean; planned: number }> = [];
    for (const { spec } of readyHard) {
      plans.push({ spec, hardGate: true, planned: await planCount(prisma, spec) });
    }
    for (const { spec } of readyBest) {
      plans.push({ spec, hardGate: false, planned: await planCount(prisma, spec) });
    }
    let totalPlanned = 0;
    for (const plan of plans) {
      totalPlanned += plan.planned;
      const tag = plan.hardGate ? "hard" : "best-effort";
      console.log(
        `  [${tag}] ${plan.spec.table}.${plan.spec.newColumn} ← ${plan.spec.legacyColumn}: ${plan.planned} 行`,
      );
    }
    console.log(`  回填合计: ${totalPlanned} 行`);

    if (!args.apply) {
      console.log("\nDRY-RUN：未写库。加 --apply 单事务落库。");
      return 0;
    }

    // ── 4. 单事务执行（先生命周期同步，后 profileId 回填）──
    console.log("\n── 4. 单事务执行 UPDATE ──");
    const applied = await prisma.$transaction(
      async (tx) => {
        const results: Array<{ label: string; affected: number }> = [];
        if (lifecycleEnabled) {
          if (lifecycleDeletedPlanned > 0) {
            results.push({
              label: `${PROFILE_TABLE}.deleted/deletedAt`,
              affected: num(await tx.$executeRawUnsafe(lifecycleDeletedUpdateSql())),
            });
          } else {
            results.push({ label: `${PROFILE_TABLE}.deleted/deletedAt`, affected: 0 });
          }
          if (lifecycleMergedIntoPlanned > 0) {
            results.push({
              label: `${PROFILE_TABLE}.mergedIntoProfileId`,
              affected: num(await tx.$executeRawUnsafe(lifecycleMergedIntoUpdateSql())),
            });
          } else {
            results.push({ label: `${PROFILE_TABLE}.mergedIntoProfileId`, affected: 0 });
          }
        }
        for (const plan of plans) {
          if (plan.planned === 0) {
            results.push({ label: `${plan.spec.table}.${plan.spec.newColumn}`, affected: 0 });
            continue;
          }
          // 只写新列；严禁 UPDATE legacy 列置 null 绕过 unmappable
          const affected = await tx.$executeRawUnsafe(updateSql(plan.spec));
          results.push({ label: `${plan.spec.table}.${plan.spec.newColumn}`, affected: num(affected) });
        }
        return results;
      },
      { timeout: 60000, maxWait: 10000 },
    );
    let totalApplied = 0;
    for (const r of applied) {
      totalApplied += r.affected;
      if (r.affected > 0) {
        console.log(`  ${r.label}: ${r.affected} 行已写入`);
      }
    }
    console.log(`  合计影响: ${totalApplied} 行`);

    // ── 5. 回填后校验：硬门禁行 legacy 非空且 new 仍为 null → 逐条列出并阻断 ──
    console.log("\n── 5. 回填后校验（fail-closed）──");
    let residualCount = 0;
    for (const { spec } of readyHard) {
      const { from, legacy, nw } = mappingFragments(spec);
      const rows = await prisma.$queryRawUnsafe<Array<{ id: string; legacy: string }>>(
        `SELECT x.id AS id, x.${legacy} AS legacy FROM ${from} x
         WHERE x.${legacy} IS NOT NULL AND x.${nw} IS NULL
         ORDER BY x.id`,
      );
      if (rows.length === 0) continue;
      residualCount += rows.length;
      console.error(
        `❌ ${spec.table}.${spec.legacyColumn}: 回填后仍有 ${rows.length} 行 new 为 null:`,
      );
      for (const r of rows) {
        console.error(`     table=${spec.table} id=${r.id} legacy=${r.legacy}`);
      }
    }
    if (residualCount > 0) return 1;

    // best-effort 残留只报告
    for (const { spec } of readyBest) {
      const { from, legacy, nw } = mappingFragments(spec);
      const residual = await countQuery(
        prisma,
        `SELECT COUNT(*) AS n FROM ${from} x WHERE x.${legacy} IS NOT NULL AND x.${nw} IS NULL`,
      );
      if (residual > 0) {
        console.log(
          `  ℹ️ best-effort ${spec.table}.${spec.newColumn}: ${residual} 行历史已删客户保留 null（不阻断）`,
        );
      }
    }

    // dangling 复检（回填只写 new 为 null 的行，dangling 不应新增；stale 维持 warn）
    let postDangling = 0;
    let postStale = 0;
    for (const { spec } of [...readyHard, ...readyBest]) {
      const dRows = await danglingRows(prisma, spec, MISMATCH_SAMPLE_LIMIT);
      postDangling += dRows.length;
      const sRows = await staleMismatchRows(prisma, spec, MISMATCH_SAMPLE_LIMIT);
      postStale += sRows.length;
    }
    if (postDangling > 0) {
      console.error(`❌ 回填后 dangling 复检命中 ${postDangling} 行`);
      return 1;
    }
    if (postStale > 0) {
      console.log(`  ⚠️ 回填后 stale 复检：${postStale} 行（merge 后旧锚点过期，不阻断）`);
    }

    console.log("  ✅ 硬门禁列全部回填完成，无 dangling");
    console.log("\n✅ APPLY 完成（可重复执行；二次执行应为 0 影响行）");
    return 0;
  } finally {
    await prisma.$disconnect();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e) => {
    console.error(e);
    process.exitCode = 2;
  });

/**
 * Phase E precheck（只读）：删除 Customer 锚点与全部旧 *CustomerId* 列之前的一致性门禁。
 *
 * 方案：docs/customer-legacy-field-remediation-plan-2026-07-15.md Phase E 节。
 * 映射唯一来源：CrmCustomerProfile.sourceCustomerId（@unique）。
 *
 * - 全部使用 prisma.$queryRawUnsafe 裸 SQL，不依赖 Prisma DTO 上的旧列，
 *   因此在当前 expand schema 与 Phase E 删列后的 schema 上均可运行
 *   （已删除的表/列会标注 dropped/missing，而不是报错）。
 * - 硬门禁表分级判定：
 *   - unbackfilled（legacy 非空且 new 为 null）→ 硬阻断；其中无 Profile 映射的子集
 *     （unmappableNewNull）连 backfill 也无法修复，单独列出。
 *   - unmappableNewFilled（legacy 非空、new 已有效填充、但 legacy 无映射）→ **warn**：
 *     legacy 是随列消失的垃圾引用（merge 后旧锚点过期），不阻断。
 *   - danglingNew（new 非空但指向不存在的 Profile）→ 硬阻断。
 *   - mismatchStale（new 存在但与映射不符）→ **warn**：merge 后旧锚点过期属正常，
 *     运行时真相已在新列。
 * - best-effort 表（历史已删客户允许 newCol 为 null）：只报告，不阻断。
 *
 * 用法：
 *   npx tsx scripts/phase-e-precheck.ts [--db /abs/path/dev.db] [--json]
 *
 * 退出码：存在任一硬阻断项 → 1；全绿（允许 warn）→ 0。
 */

import path from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// Spec：硬门禁表（逐列：旧列 → 新列）
// 注意 CrmCustomerStageHistory 在 schema 中 @@map("crm_customer_stage_history")，
// 裸 SQL 使用物理表名。
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
const SAMPLE_LIMIT = 20;

// ─────────────────────────────────────────────────────────────────────────────
// 参数与 DB 路径解析（--db > DATABASE_URL env > 仓库 prisma/dev.db）
// ─────────────────────────────────────────────────────────────────────────────

type Args = { dbPath: string; json: boolean };

function printUsage(): void {
  console.log(
    [
      "Usage:",
      "  npx tsx scripts/phase-e-precheck.ts [--db <path>] [--json]",
      "",
      "只读检查；任何硬阻断项 → exit 1，全绿（允许 warn）→ exit 0。",
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
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--db") {
      dbArg = argv[i + 1] ?? null;
      i++;
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (dbArg === "") throw new Error("--db requires a non-empty path");
  return { dbPath: resolveDbPath(dbArg), json };
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

// ─────────────────────────────────────────────────────────────────────────────
// 报告结构
// ─────────────────────────────────────────────────────────────────────────────

type ColumnStatus = "ok" | "table-missing" | "legacy-dropped" | "new-missing";

type ColumnReport = {
  table: string;
  legacyColumn: string;
  newColumn: string;
  status: ColumnStatus;
  total: number | null;
  legacyNonNull: number | null;
  /** legacy 非空且 new 为 null（硬门禁 → 硬阻断） */
  unbackfilled: number | null;
  /** unbackfilled 子集：legacy 无 Profile 映射，backfill 也无法修复（诊断用） */
  unmappableNewNull: number | null;
  /** legacy 非空、new 已有效填充、但 legacy 无映射（随列消失的垃圾引用）→ warn */
  unmappableNewFilled: number | null;
  /** new 非空但指向不存在的 Profile → 硬阻断 */
  danglingNew: number | null;
  /** new 存在但与映射不符（merge 后旧锚点过期，运行时真相已在新列）→ warn */
  mismatchStale: number | null;
  unmappableNewFilledLegacyValues?: string[];
  danglingSampleIds?: Array<{ id: string; legacy: string; current: string }>;
  mismatchStaleSampleIds?: Array<{ id: string; legacy: string; current: string; expected: string }>;
  unbackfilledSampleIds?: Array<{ id: string; legacy: string }>;
};

type GlobalReport = {
  customerRows: number | null;
  anchorsWithoutProfile: number | null;
  /** 无 Profile 锚点仍被 new 为 null 的硬门禁行引用（硬阻断） */
  anchorsWithoutProfileReferenced: number | null;
  /** 无 Profile 锚点仅被 new 已填充的硬门禁行引用（随列消失，warn） */
  anchorsWithoutProfileReferencedFilled: number | null;
  anchorReferencesByColumn: Array<{ table: string; legacyColumn: string; referencedAnchors: number }>;
  orphanMappings: number | null;
  w73PendingReviewTasks: number;
  profileDuplicateCustomerCodeGroups: number;
  profileDuplicateCustomerCodeRows: number;
  profileEmptyName: number;
  profileEmptyCustomerCode: number;
};

type PrismaLike = {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
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
// 逐列统计
// ─────────────────────────────────────────────────────────────────────────────

async function columnReport(
  prisma: PrismaLike,
  spec: ColSpec,
  profileMappingAvailable: boolean,
  collectSamples: boolean,
): Promise<ColumnReport> {
  const base: ColumnReport = {
    table: spec.table,
    legacyColumn: spec.legacyColumn,
    newColumn: spec.newColumn,
    status: "ok",
    total: null,
    legacyNonNull: null,
    unbackfilled: null,
    unmappableNewNull: null,
    unmappableNewFilled: null,
    danglingNew: null,
    mismatchStale: null,
  };

  if (!(await tableExists(prisma, spec.table))) {
    return { ...base, status: "table-missing" };
  }
  const cols = await tableColumns(prisma, spec.table);
  const total = await countQuery(prisma, `SELECT COUNT(*) AS n FROM ${qi(spec.table)}`);
  base.total = total;
  if (!cols.has(spec.legacyColumn)) {
    return { ...base, status: "legacy-dropped" };
  }
  if (!cols.has(spec.newColumn)) {
    return { ...base, status: "new-missing" };
  }

  const t = qi(spec.table);
  const legacy = qi(spec.legacyColumn);
  const nw = qi(spec.newColumn);

  const legacyNonNull = await countQuery(
    prisma,
    `SELECT COUNT(*) AS n FROM ${t} WHERE ${legacy} IS NOT NULL`,
  );
  const unbackfilled = await countQuery(
    prisma,
    `SELECT COUNT(*) AS n FROM ${t} WHERE ${legacy} IS NOT NULL AND ${nw} IS NULL`,
  );

  let unmappableNewNull: number | null = null;
  let unmappableNewFilled: number | null = null;
  let danglingNew: number | null = null;
  let mismatchStale: number | null = null;
  if (profileMappingAvailable) {
    const p = qi(PROFILE_TABLE);
    const src = qi(PROFILE_SOURCE_COLUMN);
    // legacy 非空、new 为 null、无映射：硬阻断（backfill 也救不了）
    unmappableNewNull = await countQuery(
      prisma,
      `SELECT COUNT(*) AS n FROM ${t} x
       WHERE x.${legacy} IS NOT NULL AND x.${nw} IS NULL
         AND NOT EXISTS (SELECT 1 FROM ${p} p WHERE p.${src} = x.${legacy})`,
    );
    // legacy 非空、new 已有效填充、无映射：warn（随列消失的垃圾引用）
    unmappableNewFilled = await countQuery(
      prisma,
      `SELECT COUNT(*) AS n FROM ${t} x
       WHERE x.${legacy} IS NOT NULL AND x.${nw} IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM ${p} p WHERE p.${src} = x.${legacy})
         AND EXISTS (SELECT 1 FROM ${p} p2 WHERE p2.id = x.${nw})`,
    );
    // new 非空但指向不存在的 Profile：硬阻断（不论 legacy 是否可映射）
    danglingNew = await countQuery(
      prisma,
      `SELECT COUNT(*) AS n FROM ${t} x
       WHERE x.${legacy} IS NOT NULL AND x.${nw} IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM ${p} p2 WHERE p2.id = x.${nw})`,
    );
    // new 存在但与映射不符：warn（merge 后旧锚点过期）
    mismatchStale = await countQuery(
      prisma,
      `SELECT COUNT(*) AS n FROM ${t} x
       WHERE x.${legacy} IS NOT NULL AND x.${nw} IS NOT NULL
         AND EXISTS (SELECT 1 FROM ${p} p WHERE p.${src} = x.${legacy})
         AND x.${nw} <> (SELECT p.id FROM ${p} p WHERE p.${src} = x.${legacy})
         AND EXISTS (SELECT 1 FROM ${p} p2 WHERE p2.id = x.${nw})`,
    );
  }

  const report: ColumnReport = {
    ...base,
    legacyNonNull,
    unbackfilled,
    unmappableNewNull,
    unmappableNewFilled,
    danglingNew,
    mismatchStale,
  };

  if (collectSamples && profileMappingAvailable) {
    const p = qi(PROFILE_TABLE);
    const src = qi(PROFILE_SOURCE_COLUMN);
    if ((unmappableNewFilled ?? 0) > 0) {
      const rows = await prisma.$queryRawUnsafe<Array<{ v: string }>>(
        `SELECT DISTINCT x.${legacy} AS v FROM ${t} x
         WHERE x.${legacy} IS NOT NULL AND x.${nw} IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM ${p} p WHERE p.${src} = x.${legacy})
           AND EXISTS (SELECT 1 FROM ${p} p2 WHERE p2.id = x.${nw})
         LIMIT ${SAMPLE_LIMIT}`,
      );
      report.unmappableNewFilledLegacyValues = rows.map((r) => r.v);
    }
    if (unbackfilled > 0) {
      report.unbackfilledSampleIds = await prisma.$queryRawUnsafe<
        Array<{ id: string; legacy: string }>
      >(
        `SELECT x.id AS id, x.${legacy} AS legacy FROM ${t} x
         WHERE x.${legacy} IS NOT NULL AND x.${nw} IS NULL
         LIMIT ${SAMPLE_LIMIT}`,
      );
    }
    if ((danglingNew ?? 0) > 0) {
      report.danglingSampleIds = await prisma.$queryRawUnsafe<
        Array<{ id: string; legacy: string; current: string }>
      >(
        `SELECT x.id AS id, x.${legacy} AS legacy, x.${nw} AS current
         FROM ${t} x
         WHERE x.${legacy} IS NOT NULL AND x.${nw} IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM ${p} p2 WHERE p2.id = x.${nw})
         LIMIT ${SAMPLE_LIMIT}`,
      );
    }
    if ((mismatchStale ?? 0) > 0) {
      report.mismatchStaleSampleIds = await prisma.$queryRawUnsafe<
        Array<{ id: string; legacy: string; current: string; expected: string }>
      >(
        `SELECT x.id AS id, x.${legacy} AS legacy, x.${nw} AS current,
                (SELECT p.id FROM ${p} p WHERE p.${src} = x.${legacy}) AS expected
         FROM ${t} x
         WHERE x.${legacy} IS NOT NULL AND x.${nw} IS NOT NULL
           AND EXISTS (SELECT 1 FROM ${p} p WHERE p.${src} = x.${legacy})
           AND x.${nw} <> (SELECT p.id FROM ${p} p WHERE p.${src} = x.${legacy})
           AND EXISTS (SELECT 1 FROM ${p} p2 WHERE p2.id = x.${nw})
         LIMIT ${SAMPLE_LIMIT}`,
      );
    }
  }

  return report;
}

// ─────────────────────────────────────────────────────────────────────────────
// 全局检查
// ─────────────────────────────────────────────────────────────────────────────

async function globalReport(
  prisma: PrismaLike,
  customerTableExists: boolean,
  profileMappingAvailable: boolean,
  hardGateRefs: ColSpec[],
): Promise<GlobalReport> {
  const report: GlobalReport = {
    customerRows: null,
    anchorsWithoutProfile: null,
    anchorsWithoutProfileReferenced: null,
    anchorsWithoutProfileReferencedFilled: null,
    anchorReferencesByColumn: [],
    orphanMappings: null,
    w73PendingReviewTasks: 0,
    profileDuplicateCustomerCodeGroups: 0,
    profileDuplicateCustomerCodeRows: 0,
    profileEmptyName: 0,
    profileEmptyCustomerCode: 0,
  };

  const p = qi(PROFILE_TABLE);
  const src = qi(PROFILE_SOURCE_COLUMN);

  if (customerTableExists && profileMappingAvailable) {
    report.customerRows = await countQuery(prisma, `SELECT COUNT(*) AS n FROM ${qi(CUSTOMER_TABLE)}`);
    report.anchorsWithoutProfile = await countQuery(
      prisma,
      `SELECT COUNT(*) AS n FROM ${qi(CUSTOMER_TABLE)} c
       WHERE NOT EXISTS (SELECT 1 FROM ${p} pp WHERE pp.${src} = c.id)`,
    );
    if ((report.anchorsWithoutProfile ?? 0) > 0 && hardGateRefs.length > 0) {
      // hardGateRefs 仅含 legacy 与 new 列都存在的 spec。
      // 硬阻断口径：引用行 new 为 null（无法解析）；new 已填充的引用随列消失，只 warn。
      const nullConds = hardGateRefs
        .map(
          (s) =>
            `EXISTS (SELECT 1 FROM ${qi(s.table)} x WHERE x.${qi(s.legacyColumn)} = c.id AND x.${qi(s.newColumn)} IS NULL)`,
        )
        .join("\n         OR ");
      const filledConds = hardGateRefs
        .map(
          (s) =>
            `EXISTS (SELECT 1 FROM ${qi(s.table)} x WHERE x.${qi(s.legacyColumn)} = c.id AND x.${qi(s.newColumn)} IS NOT NULL)`,
        )
        .join("\n         OR ");
      report.anchorsWithoutProfileReferenced = await countQuery(
        prisma,
        `SELECT COUNT(*) AS n FROM ${qi(CUSTOMER_TABLE)} c
         WHERE NOT EXISTS (SELECT 1 FROM ${p} pp WHERE pp.${src} = c.id)
           AND (${nullConds})`,
      );
      report.anchorsWithoutProfileReferencedFilled = await countQuery(
        prisma,
        `SELECT COUNT(*) AS n FROM ${qi(CUSTOMER_TABLE)} c
         WHERE NOT EXISTS (SELECT 1 FROM ${p} pp WHERE pp.${src} = c.id)
           AND (${filledConds})
           AND NOT (${nullConds})`,
      );
      for (const s of hardGateRefs) {
        const referenced = await countQuery(
          prisma,
          `SELECT COUNT(DISTINCT x.${qi(s.legacyColumn)}) AS n FROM ${qi(s.table)} x
           WHERE x.${qi(s.legacyColumn)} IS NOT NULL AND x.${qi(s.newColumn)} IS NULL
             AND NOT EXISTS (SELECT 1 FROM ${p} pp WHERE pp.${src} = x.${qi(s.legacyColumn)})
             AND EXISTS (SELECT 1 FROM ${qi(CUSTOMER_TABLE)} c WHERE c.id = x.${qi(s.legacyColumn)})`,
        );
        if (referenced > 0) {
          report.anchorReferencesByColumn.push({
            table: s.table,
            legacyColumn: s.legacyColumn,
            referencedAnchors: referenced,
          });
        }
      }
    } else {
      report.anchorsWithoutProfileReferenced = 0;
      report.anchorsWithoutProfileReferencedFilled = 0;
    }
  } else if (customerTableExists) {
    report.customerRows = await countQuery(prisma, `SELECT COUNT(*) AS n FROM ${qi(CUSTOMER_TABLE)}`);
  }

  if (profileMappingAvailable && customerTableExists) {
    report.orphanMappings = await countQuery(
      prisma,
      `SELECT COUNT(*) AS n FROM ${p} pp
       WHERE pp.${src} IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM ${qi(CUSTOMER_TABLE)} c WHERE c.id = pp.${src})`,
    );
  }

  // W7.3 遗留：sourceId 仍指向旧 Customer.id 的 PENDING 机构审核任务（报告+计数）
  if (await tableExists(prisma, "OrganizationReviewTask")) {
    report.w73PendingReviewTasks = await countQuery(
      prisma,
      `SELECT COUNT(*) AS n FROM ${qi("OrganizationReviewTask")}
       WHERE status = 'PENDING'
         AND sourceType IN ('CUSTOMER_CREATE', 'CUSTOMER_EDIT')
         AND sourceId NOT IN (SELECT id FROM ${p})`,
    );
  }

  // 方案 §6 数据验收项（只报告）
  const dupRows = await prisma.$queryRawUnsafe<
    Array<{ groups: number | bigint; rows: number | bigint | null }>
  >(
    `SELECT COUNT(*) AS groups, COALESCE(SUM(cnt), 0) AS rows FROM (
       SELECT COUNT(*) AS cnt FROM ${p}
       WHERE customerCode IS NOT NULL AND trim(customerCode) <> ''
       GROUP BY customerCode
       HAVING COUNT(*) > 1
     )`,
  );
  report.profileDuplicateCustomerCodeGroups = num(dupRows[0]?.groups ?? 0);
  report.profileDuplicateCustomerCodeRows = num(dupRows[0]?.rows ?? 0);
  report.profileEmptyName = await countQuery(
    prisma,
    `SELECT COUNT(*) AS n FROM ${p} WHERE name IS NULL OR trim(name) = ''`,
  );
  report.profileEmptyCustomerCode = await countQuery(
    prisma,
    `SELECT COUNT(*) AS n FROM ${p} WHERE customerCode IS NULL OR trim(customerCode) = ''`,
  );

  return report;
}

// ─────────────────────────────────────────────────────────────────────────────
// 输出
// ─────────────────────────────────────────────────────────────────────────────

function cell(value: number | null): string {
  return value === null ? "-" : String(value);
}

function printColumnTable(title: string, reports: ColumnReport[]): void {
  console.log(`\n── ${title} ──`);
  const header = [
    "table".padEnd(28),
    "legacyColumn".padEnd(20),
    "newColumn".padEnd(20),
    "total".padStart(7),
    "legacyNN".padStart(9),
    "unbackf".padStart(8),
    "unmNN".padStart(6),
    "unmNF".padStart(6),
    "dangl".padStart(6),
    "misStale".padStart(9),
    "status".padStart(15),
  ].join(" ");
  console.log(header);
  console.log("-".repeat(header.length));
  for (const r of reports) {
    console.log(
      [
        r.table.padEnd(28),
        r.legacyColumn.padEnd(20),
        r.newColumn.padEnd(20),
        cell(r.total).padStart(7),
        cell(r.legacyNonNull).padStart(9),
        cell(r.unbackfilled).padStart(8),
        cell(r.unmappableNewNull).padStart(6),
        cell(r.unmappableNewFilled).padStart(6),
        cell(r.danglingNew).padStart(6),
        cell(r.mismatchStale).padStart(9),
        r.status.padStart(15),
      ].join(" "),
    );
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  // 先设置 DATABASE_URL，再动态 import prisma 客户端（仓库脚本惯例）
  process.env.DATABASE_URL = `file:${args.dbPath}`;
  const { prisma } = (await import("../src/lib/prisma")) as { prisma: PrismaLike };

  try {
    const customerTableExists = await tableExists(prisma, CUSTOMER_TABLE);
    const profileCols = (await tableExists(prisma, PROFILE_TABLE))
      ? await tableColumns(prisma, PROFILE_TABLE)
      : new Set<string>();
    const profileMappingAvailable = profileCols.has(PROFILE_SOURCE_COLUMN);

    // 锚点引用反查 spec（仅统计表、旧列、新列都存在的列；缺列列在 column 级已阻断）
    const hardGateRefs: ColSpec[] = [];
    for (const spec of HARD_GATE_SPECS) {
      if (!(await tableExists(prisma, spec.table))) continue;
      const cols = await tableColumns(prisma, spec.table);
      if (cols.has(spec.legacyColumn) && cols.has(spec.newColumn)) hardGateRefs.push(spec);
    }

    const hardGateReports: ColumnReport[] = [];
    for (const spec of HARD_GATE_SPECS) {
      hardGateReports.push(await columnReport(prisma, spec, profileMappingAvailable, true));
    }
    const bestEffortReports: ColumnReport[] = [];
    for (const spec of BEST_EFFORT_SPECS) {
      bestEffortReports.push(await columnReport(prisma, spec, profileMappingAvailable, true));
    }

    const globalChecks = await globalReport(
      prisma,
      customerTableExists,
      profileMappingAvailable,
      hardGateRefs,
    );

    // ── 硬阻断判定 ──
    const hardBlockers: string[] = [];
    const warnings: string[] = [];
    for (const r of hardGateReports) {
      const label = `${r.table}.${r.legacyColumn}`;
      if (r.status === "table-missing") {
        hardBlockers.push(`${label}: 硬门禁表缺失`);
        continue;
      }
      if (r.status === "new-missing") {
        hardBlockers.push(`${label}: 新列 ${r.newColumn} 缺失（schema 未 expand）`);
        continue;
      }
      if (r.status === "legacy-dropped") continue; // Phase E 已完成，无需检查
      if ((r.unbackfilled ?? 0) > 0) {
        const suffix =
          (r.unmappableNewNull ?? 0) > 0 ? `（其中 ${r.unmappableNewNull} 行无 Profile 映射，backfill 无法修复）` : "";
        hardBlockers.push(`${label}: unbackfilled=${r.unbackfilled}${suffix}`);
      }
      if ((r.danglingNew ?? 0) > 0) {
        hardBlockers.push(`${label}: danglingNew=${r.danglingNew}（${r.newColumn} 指向不存在的 Profile）`);
      }
      if ((r.unmappableNewFilled ?? 0) > 0) {
        warnings.push(
          `${label}: unmappableNewFilled=${r.unmappableNewFilled}（legacy 无映射但 ${r.newColumn} 已有效填充，随列消失）`,
        );
      }
      if ((r.mismatchStale ?? 0) > 0) {
        warnings.push(
          `${label}: mismatchStale=${r.mismatchStale}（${r.newColumn} 存在但与映射不符，merge 后旧锚点过期）`,
        );
      }
    }
    for (const r of bestEffortReports) {
      if (r.status !== "ok") continue;
      const label = `${r.table}.${r.legacyColumn}`;
      if ((r.unbackfilled ?? 0) > 0 || (r.danglingNew ?? 0) > 0) {
        warnings.push(
          `[best-effort] ${label}: unbackfilled=${r.unbackfilled ?? 0} danglingNew=${r.danglingNew ?? 0}（只报告，不阻断）`,
        );
      }
    }
    if ((globalChecks.anchorsWithoutProfileReferenced ?? 0) > 0) {
      hardBlockers.push(
        `Customer 锚点无 Profile 且仍被 new 为 null 的硬门禁行引用: ${globalChecks.anchorsWithoutProfileReferenced}`,
      );
    }
    if ((globalChecks.anchorsWithoutProfileReferencedFilled ?? 0) > 0) {
      warnings.push(
        `Customer 锚点无 Profile 但仅被 new 已填充的硬门禁行引用（随列消失）: ${globalChecks.anchorsWithoutProfileReferencedFilled}`,
      );
    }

    const ok = hardBlockers.length === 0;

    if (args.json) {
      console.log(
        JSON.stringify(
          {
            database: args.dbPath,
            generatedAt: new Date().toISOString(),
            profileMappingAvailable,
            customerTableExists,
            hardGate: hardGateReports,
            bestEffort: bestEffortReports,
            global: globalChecks,
            hardBlockers,
            warnings,
            ok,
          },
          null,
          2,
        ),
      );
    } else {
      console.log("=== Phase E Precheck（只读）===");
      console.log(`Database: ${args.dbPath}`);
      if (!profileMappingAvailable) {
        console.log(
          `ℹ️ ${PROFILE_TABLE}.${PROFILE_SOURCE_COLUMN} 不存在（映射列已删除），映射类统计跳过`,
        );
      }
      if (!customerTableExists) {
        console.log(`ℹ️ ${CUSTOMER_TABLE} 表不存在（Phase E 已完成），锚点检查跳过`);
      }

      printColumnTable("硬门禁表（unbackfilled / danglingNew 非零即阻断；unmNF / misStale 为 warn）", hardGateReports);
      printColumnTable("best-effort 表（只报告，不阻断）", bestEffortReports);

      console.log("\n── 全局检查 ──");
      console.log(`Customer 行数: ${cell(globalChecks.customerRows)}`);
      console.log(`无 Profile 的锚点: ${cell(globalChecks.anchorsWithoutProfile)}`);
      console.log(
        `  其中仍被 new 为 null 的硬门禁行引用（硬阻断）: ${cell(globalChecks.anchorsWithoutProfileReferenced)}`,
      );
      console.log(
        `  其中仅被 new 已填充的硬门禁行引用（warn）: ${cell(globalChecks.anchorsWithoutProfileReferencedFilled)}`,
      );
      for (const ref of globalChecks.anchorReferencesByColumn) {
        console.log(`    ⚠️ ${ref.table}.${ref.legacyColumn}: ${ref.referencedAnchors} 个锚点`);
      }
      console.log(`孤儿映射（sourceCustomerId 无 Customer 行的 Profile）: ${cell(globalChecks.orphanMappings)}`);
      console.log(`OrganizationReviewTask W7.3 遗留 PENDING: ${globalChecks.w73PendingReviewTasks}`);
      console.log(
        `CrmCustomerProfile customerCode 重复: ${globalChecks.profileDuplicateCustomerCodeGroups} 组 / ${globalChecks.profileDuplicateCustomerCodeRows} 行`,
      );
      console.log(`CrmCustomerProfile 空 name: ${globalChecks.profileEmptyName}`);
      console.log(`CrmCustomerProfile 空 customerCode: ${globalChecks.profileEmptyCustomerCode}`);

      // 明细（样本）
      for (const r of [...hardGateReports, ...bestEffortReports]) {
        const label = `${r.table}.${r.legacyColumn}`;
        if (r.danglingSampleIds && r.danglingSampleIds.length > 0) {
          console.log(`\n⚠️ ${label} danglingNew 样本（≤${SAMPLE_LIMIT}，硬阻断）:`);
          for (const s of r.danglingSampleIds) {
            console.log(`    id=${s.id} legacy=${s.legacy} current=${s.current}`);
          }
        }
        if (r.mismatchStaleSampleIds && r.mismatchStaleSampleIds.length > 0) {
          console.log(`\n⚠️ ${label} mismatchStale 样本（≤${SAMPLE_LIMIT}，warn）:`);
          for (const s of r.mismatchStaleSampleIds) {
            console.log(`    id=${s.id} legacy=${s.legacy} current=${s.current} expected=${s.expected}`);
          }
        }
        if (r.unmappableNewFilledLegacyValues && r.unmappableNewFilledLegacyValues.length > 0) {
          console.log(`\n⚠️ ${label} unmappableNewFilled legacy 值（≤${SAMPLE_LIMIT}，warn，随列消失）:`);
          for (const v of r.unmappableNewFilledLegacyValues) console.log(`    ${v}`);
        }
        if (r.unbackfilledSampleIds && r.unbackfilledSampleIds.length > 0) {
          console.log(`\n⚠️ ${label} unbackfilled 样本（≤${SAMPLE_LIMIT}，可经 phase-e-backfill 回填）:`);
          for (const s of r.unbackfilledSampleIds) console.log(`    id=${s.id} legacy=${s.legacy}`);
        }
      }

      console.log(`\n── 结果 ──`);
      if (ok) {
        console.log(`✅ PASS：无硬阻断项，可进入 Phase E 停服删列窗口（warn ${warnings.length} 项）`);
      } else {
        console.log(`❌ FAIL：${hardBlockers.length} 项硬阻断`);
        for (const b of hardBlockers) console.log(`  - ${b}`);
      }
      if (warnings.length > 0) {
        console.log(`\n── warn 明细（不阻断）──`);
        for (const w of warnings) console.log(`  - ${w}`);
      }
    }

    return ok ? 0 : 1;
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

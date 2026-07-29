/**
 * Phase C：Customer ID → Profile ID 外键回填与校验。
 *
 * 前提：schema 已 expand（各表 nullable profileId / *ProfileId 已存在），
 * Customer 旧列仍在。映射唯一来源：CrmCustomerProfile.sourceCustomerId。
 *
 * 规则：
 * - 任何非空旧 Customer ID 必须映射到 Profile；无法映射则阻断（禁止静默置 null）。
 * - 不创建虚构 Profile。
 * - 生命周期字段：把 Customer.deleted/deletedAt/mergedIntoId 复制到 Profile
 *   （mergedIntoId → mergedIntoProfileId，经 sourceCustomerId 二次映射）。
 *
 * 用法：
 *   DATABASE_URL=file:/abs/dev.db npx tsx scripts/expand-profile-fks.ts --precheck
 *   DATABASE_URL=file:/abs/dev.db npx tsx scripts/expand-profile-fks.ts --backfill
 *   DATABASE_URL=file:/abs/dev.db npx tsx scripts/expand-profile-fks.ts --verify
 */
import path from "node:path";
import Database from "better-sqlite3";

type CountRow = { n: number };
type IdRow = { id: string };
type MappingRow = { customerId: string; profileId: string };

type FkSpec = {
  table: string;
  customerColumn: string;
  profileColumn: string;
  /** 快照字段无 FK，仅写字符串 */
  label?: string;
};

const SINGLE_FK_SPECS: FkSpec[] = [
  { table: "Project", customerColumn: "customerId", profileColumn: "profileId" },
  { table: "ExternalOrder", customerColumn: "customerId", profileColumn: "profileId" },
  { table: "Order", customerColumn: "customerId", profileColumn: "profileId" },
  { table: "FinanceReceipt", customerColumn: "customerId", profileColumn: "profileId" },
  { table: "FinanceAdvance", customerColumn: "customerId", profileColumn: "profileId" },
  { table: "FinanceCost", customerColumn: "customerId", profileColumn: "profileId" },
  { table: "CostEntry", customerColumn: "customerId", profileColumn: "profileId" },
  { table: "CustomerRepTag", customerColumn: "customerId", profileColumn: "profileId" },
  { table: "CrmRepresentativeReportLine", customerColumn: "customerId", profileColumn: "profileId" },
  { table: "CustomerOrgBindingTask", customerColumn: "customerId", profileColumn: "profileId" },
  { table: "CustomerOrgTextDriftTask", customerColumn: "customerId", profileColumn: "profileId" },
  { table: "OrderImportRow", customerColumn: "suggestedCustomerId", profileColumn: "suggestedProfileId" },
  { table: "OrderImportRow", customerColumn: "confirmedCustomerId", profileColumn: "confirmedProfileId" },
  { table: "CustomerMergeTask", customerColumn: "customerIdA", profileColumn: "profileIdA" },
  { table: "CustomerMergeTask", customerColumn: "customerIdB", profileColumn: "profileIdB" },
  { table: "CustomerMergeLog", customerColumn: "sourceCustomerId", profileColumn: "sourceProfileId" },
  { table: "CustomerMergeLog", customerColumn: "targetCustomerId", profileColumn: "targetProfileId" },
  { table: "CustomerRelation", customerColumn: "fromCustomerId", profileColumn: "fromProfileId" },
  { table: "CustomerRelation", customerColumn: "toCustomerId", profileColumn: "toProfileId" },
];

/**
 * 审计/删除快照表：旧 customerId 可能指向已物理删除的客户。
 * 能映射则回填；不能映射则保留 profileId=null，记 warning，不阻断 expand。
 */
const BEST_EFFORT_SNAPSHOT_SPECS: FkSpec[] = [
  { table: "CustomerApiAuditLog", customerColumn: "customerId", profileColumn: "profileId" },
  { table: "FinanceReceiptDeletionLog", customerColumn: "customerId", profileColumn: "profileId" },
  { table: "ProgressReceivableAdjustment", customerColumn: "customerId", profileColumn: "profileId" },
];

/** 已有 profileId 的表：只校验非空旧 ID 是否都能映射，不强制覆盖已有 profileId */
const VERIFY_ONLY_IF_ALREADY_PROFILE: Array<{ table: string; customerColumn: string; profileColumn: string }> = [
  { table: "CrmCustomerStageHistory", customerColumn: "sourceCustomerId", profileColumn: "profileId" },
  {
    table: "CrmCustomerApplication",
    customerColumn: "createdCustomerId",
    profileColumn: "createdCrmProfileId",
  },
];

function databasePathFromEnv(): string {
  const value = process.env.DATABASE_URL;
  if (!value?.startsWith("file:")) {
    throw new Error("DATABASE_URL 必须是 file: SQLite 路径");
  }
  const withoutScheme = value.slice("file:".length).split("?")[0];
  if (!withoutScheme) throw new Error("DATABASE_URL 未包含数据库路径");
  return path.resolve(decodeURIComponent(withoutScheme));
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function tableExists(db: Database.Database, table: string): boolean {
  const row = db
    .prepare("SELECT 1 AS n FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as CountRow | undefined;
  return Boolean(row);
}

function columnExists(db: Database.Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as Array<{ name: string }>;
  return rows.some((r) => r.name === column);
}

function count(db: Database.Database, sql: string, params: unknown[] = []): number {
  return Number((db.prepare(sql).get(...params) as CountRow | undefined)?.n ?? 0);
}

function loadCustomerToProfileMap(db: Database.Database): Map<string, string> {
  const rows = db
    .prepare(`SELECT sourceCustomerId AS customerId, id AS profileId FROM CrmCustomerProfile`)
    .all() as MappingRow[];
  const map = new Map<string, string>();
  for (const row of rows) map.set(row.customerId, row.profileId);
  return map;
}

function assertExpandSchema(db: Database.Database): void {
  if (!tableExists(db, "Customer") || !tableExists(db, "CrmCustomerProfile")) {
    throw new Error("缺少 Customer 或 CrmCustomerProfile 表");
  }
  for (const col of ["deleted", "deletedAt", "mergedIntoProfileId"]) {
    if (!columnExists(db, "CrmCustomerProfile", col)) {
      throw new Error(`CrmCustomerProfile 缺少 expand 列 ${col}；请先 prisma db push`);
    }
  }
  const missing: string[] = [];
  for (const spec of SINGLE_FK_SPECS) {
    if (!tableExists(db, spec.table)) continue;
    if (!columnExists(db, spec.table, spec.profileColumn)) {
      missing.push(`${spec.table}.${spec.profileColumn}`);
    }
  }
  if (missing.length > 0) {
    throw new Error(`schema 尚未 expand，缺少列：${missing.join(", ")}`);
  }
}

type UnmappedHit = { table: string; column: string; customerId: string; rowCount: number };

function findUnmappedCustomerIds(
  db: Database.Database,
  map: Map<string, string>,
  specs: Array<{ table: string; customerColumn: string }>,
): UnmappedHit[] {
  const hits: UnmappedHit[] = [];
  for (const spec of specs) {
    if (!tableExists(db, spec.table) || !columnExists(db, spec.table, spec.customerColumn)) continue;
    const ids = db
      .prepare(
        `SELECT DISTINCT ${quoteIdentifier(spec.customerColumn)} AS id
         FROM ${quoteIdentifier(spec.table)}
         WHERE ${quoteIdentifier(spec.customerColumn)} IS NOT NULL
           AND trim(${quoteIdentifier(spec.customerColumn)}) <> ''`,
      )
      .all() as IdRow[];
    for (const row of ids) {
      if (map.has(row.id)) continue;
      const rowCount = count(
        db,
        `SELECT COUNT(*) AS n FROM ${quoteIdentifier(spec.table)}
         WHERE ${quoteIdentifier(spec.customerColumn)} = ?`,
        [row.id],
      );
      hits.push({
        table: spec.table,
        column: spec.customerColumn,
        customerId: row.id,
        rowCount,
      });
    }
  }
  return hits;
}

function precheck(db: Database.Database): void {
  assertExpandSchema(db);
  const map = loadCustomerToProfileMap(db);
  const customers = count(db, `SELECT COUNT(*) AS n FROM Customer`);
  const profiles = count(db, `SELECT COUNT(*) AS n FROM CrmCustomerProfile`);
  const orphanCustomers = count(
    db,
    `SELECT COUNT(*) AS n FROM Customer c
     LEFT JOIN CrmCustomerProfile p ON p.sourceCustomerId = c.id
     WHERE p.id IS NULL`,
  );
  const deletedCustomers = count(db, `SELECT COUNT(*) AS n FROM Customer WHERE deleted = 1`);
  const mergedCustomers = count(
    db,
    `SELECT COUNT(*) AS n FROM Customer WHERE mergedIntoId IS NOT NULL`,
  );

  const specs = [
    ...SINGLE_FK_SPECS.map((s) => ({ table: s.table, customerColumn: s.customerColumn })),
    ...VERIFY_ONLY_IF_ALREADY_PROFILE.map((s) => ({
      table: s.table,
      customerColumn: s.customerColumn,
    })),
  ];
  const unmapped = findUnmappedCustomerIds(db, map, specs);
  const snapshotUnmapped = findUnmappedCustomerIds(
    db,
    map,
    BEST_EFFORT_SNAPSHOT_SPECS.map((s) => ({
      table: s.table,
      customerColumn: s.customerColumn,
    })),
  );

  // 合并目标也必须能映射（生命周期回填需要）
  const mergeTargets = db
    .prepare(
      `SELECT DISTINCT mergedIntoId AS id FROM Customer
       WHERE mergedIntoId IS NOT NULL AND trim(mergedIntoId) <> ''`,
    )
    .all() as IdRow[];
  const unmappedMergeTargets = mergeTargets.filter((r) => !map.has(r.id));

  const result = {
    mode: "precheck",
    customers,
    profiles,
    orphanCustomers,
    deletedCustomers,
    mergedCustomers,
    mappingSize: map.size,
    unmappedFkHits: unmapped.length,
    snapshotUnmappedHits: snapshotUnmapped.length,
    unmappedMergeTargets: unmappedMergeTargets.length,
    blocking: orphanCustomers + unmapped.length + unmappedMergeTargets.length,
  };
  console.log(JSON.stringify(result, null, 2));
  if (unmapped.length > 0) {
    console.error("无法映射的业务 Customer FK 示例:", unmapped.slice(0, 30));
  }
  if (snapshotUnmapped.length > 0) {
    console.warn(
      "快照/审计表无法映射（将 best-effort 跳过，不阻断）:",
      snapshotUnmapped.slice(0, 30),
    );
  }
  if (unmappedMergeTargets.length > 0) {
    console.error(
      "无法映射的 mergedIntoId 目标:",
      unmappedMergeTargets.slice(0, 20).map((r) => r.id),
    );
  }
  if (result.blocking > 0) {
    throw new Error(`expand precheck 阻断：${result.blocking}（禁止静默跳过未映射 ID）`);
  }
  console.log("✅ expand precheck 通过");
}

function backfillTable(
  db: Database.Database,
  map: Map<string, string>,
  spec: FkSpec,
): { updated: number; already: number; nullRows: number } {
  if (!tableExists(db, spec.table)) return { updated: 0, already: 0, nullRows: 0 };
  if (!columnExists(db, spec.table, spec.profileColumn)) {
    throw new Error(`缺列 ${spec.table}.${spec.profileColumn}`);
  }

  const nullRows = count(
    db,
    `SELECT COUNT(*) AS n FROM ${quoteIdentifier(spec.table)}
     WHERE ${quoteIdentifier(spec.customerColumn)} IS NULL`,
  );
  const already = count(
    db,
    `SELECT COUNT(*) AS n FROM ${quoteIdentifier(spec.table)}
     WHERE ${quoteIdentifier(spec.customerColumn)} IS NOT NULL
       AND ${quoteIdentifier(spec.profileColumn)} IS NOT NULL`,
  );

  const pending = db
    .prepare(
      `SELECT rowid AS rowid, ${quoteIdentifier(spec.customerColumn)} AS customerId
       FROM ${quoteIdentifier(spec.table)}
       WHERE ${quoteIdentifier(spec.customerColumn)} IS NOT NULL
         AND ${quoteIdentifier(spec.profileColumn)} IS NULL`,
    )
    .all() as Array<{ rowid: number; customerId: string }>;

  const update = db.prepare(
    `UPDATE ${quoteIdentifier(spec.table)}
     SET ${quoteIdentifier(spec.profileColumn)} = ?
     WHERE rowid = ?`,
  );

  let updated = 0;
  const run = db.transaction(() => {
    for (const row of pending) {
      const profileId = map.get(row.customerId);
      if (!profileId) {
        throw new Error(
          `回填中断：${spec.table}.${spec.customerColumn}=${row.customerId} 无 Profile 映射`,
        );
      }
      update.run(profileId, row.rowid);
      updated++;
    }
  });
  run();

  return { updated, already, nullRows };
}

function backfillTableBestEffort(
  db: Database.Database,
  map: Map<string, string>,
  spec: FkSpec,
): { updated: number; skippedUnmapped: number; already: number } {
  if (!tableExists(db, spec.table) || !columnExists(db, spec.table, spec.profileColumn)) {
    return { updated: 0, skippedUnmapped: 0, already: 0 };
  }
  const already = count(
    db,
    `SELECT COUNT(*) AS n FROM ${quoteIdentifier(spec.table)}
     WHERE ${quoteIdentifier(spec.customerColumn)} IS NOT NULL
       AND ${quoteIdentifier(spec.profileColumn)} IS NOT NULL`,
  );
  const pending = db
    .prepare(
      `SELECT rowid AS rowid, ${quoteIdentifier(spec.customerColumn)} AS customerId
       FROM ${quoteIdentifier(spec.table)}
       WHERE ${quoteIdentifier(spec.customerColumn)} IS NOT NULL
         AND ${quoteIdentifier(spec.profileColumn)} IS NULL`,
    )
    .all() as Array<{ rowid: number; customerId: string }>;

  const update = db.prepare(
    `UPDATE ${quoteIdentifier(spec.table)}
     SET ${quoteIdentifier(spec.profileColumn)} = ?
     WHERE rowid = ?`,
  );
  let updated = 0;
  let skippedUnmapped = 0;
  const run = db.transaction(() => {
    for (const row of pending) {
      const profileId = map.get(row.customerId);
      if (!profileId) {
        skippedUnmapped++;
        continue;
      }
      update.run(profileId, row.rowid);
      updated++;
    }
  });
  run();
  return { updated, skippedUnmapped, already };
}

function backfillLifecycle(db: Database.Database, map: Map<string, string>): {
  lifecycleUpdated: number;
  mergeLinksUpdated: number;
} {
  const customers = db
    .prepare(
      `SELECT id, deleted, deletedAt, mergedIntoId FROM Customer`,
    )
    .all() as Array<{
    id: string;
    deleted: number;
    deletedAt: string | null;
    mergedIntoId: string | null;
  }>;

  const updateLifecycle = db.prepare(
    `UPDATE CrmCustomerProfile
     SET deleted = ?, deletedAt = ?, mergedIntoProfileId = ?
     WHERE sourceCustomerId = ?`,
  );

  let lifecycleUpdated = 0;
  let mergeLinksUpdated = 0;

  const run = db.transaction(() => {
    for (const c of customers) {
      const profileId = map.get(c.id);
      if (!profileId) {
        throw new Error(`生命周期回填：Customer ${c.id} 无 Profile`);
      }
      let mergedIntoProfileId: string | null = null;
      if (c.mergedIntoId) {
        mergedIntoProfileId = map.get(c.mergedIntoId) ?? null;
        if (!mergedIntoProfileId) {
          throw new Error(
            `生命周期回填：Customer ${c.id} mergedIntoId=${c.mergedIntoId} 无 Profile`,
          );
        }
        mergeLinksUpdated++;
      }
      updateLifecycle.run(
        c.deleted ? 1 : 0,
        c.deletedAt,
        mergedIntoProfileId,
        c.id,
      );
      lifecycleUpdated++;
    }
  });
  run();

  return { lifecycleUpdated, mergeLinksUpdated };
}

function backfillApplicationCreatedProfile(
  db: Database.Database,
  map: Map<string, string>,
): number {
  if (!tableExists(db, "CrmCustomerApplication")) return 0;
  if (!columnExists(db, "CrmCustomerApplication", "createdCrmProfileId")) return 0;

  const pending = db
    .prepare(
      `SELECT rowid AS rowid, createdCustomerId AS customerId
       FROM CrmCustomerApplication
       WHERE createdCustomerId IS NOT NULL
         AND createdCrmProfileId IS NULL`,
    )
    .all() as Array<{ rowid: number; customerId: string }>;

  const update = db.prepare(
    `UPDATE CrmCustomerApplication SET createdCrmProfileId = ? WHERE rowid = ?`,
  );
  let updated = 0;
  const run = db.transaction(() => {
    for (const row of pending) {
      const profileId = map.get(row.customerId);
      if (!profileId) {
        throw new Error(
          `CrmCustomerApplication.createdCustomerId=${row.customerId} 无 Profile`,
        );
      }
      update.run(profileId, row.rowid);
      updated++;
    }
  });
  run();
  return updated;
}

function backfill(db: Database.Database): void {
  assertExpandSchema(db);
  const map = loadCustomerToProfileMap(db);

  // 先跑与 precheck 相同的阻断检查
  const unmapped = findUnmappedCustomerIds(
    db,
    map,
    SINGLE_FK_SPECS.map((s) => ({ table: s.table, customerColumn: s.customerColumn })),
  );
  if (unmapped.length > 0) {
    console.error(unmapped.slice(0, 30));
    throw new Error(`回填前仍有 ${unmapped.length} 个未映射 FK，拒绝执行`);
  }

  const perTable: Record<string, { updated: number; already: number; nullRows: number }> = {};
  for (const spec of SINGLE_FK_SPECS) {
    const key = `${spec.table}.${spec.customerColumn}->${spec.profileColumn}`;
    perTable[key] = backfillTable(db, map, spec);
  }

  const snapshotTables: Record<
    string,
    { updated: number; skippedUnmapped: number; already: number }
  > = {};
  for (const spec of BEST_EFFORT_SNAPSHOT_SPECS) {
    const key = `${spec.table}.${spec.customerColumn}->${spec.profileColumn}`;
    snapshotTables[key] = backfillTableBestEffort(db, map, spec);
  }

  const lifecycle = backfillLifecycle(db, map);
  const applicationUpdated = backfillApplicationCreatedProfile(db, map);

  console.log(
    JSON.stringify(
      {
        mode: "backfill",
        mappingSize: map.size,
        perTable,
        snapshotTables,
        lifecycle,
        applicationCreatedProfileUpdated: applicationUpdated,
      },
      null,
      2,
    ),
  );
  console.log("✅ expand backfill 完成");
}

function verify(db: Database.Database): void {
  assertExpandSchema(db);
  const map = loadCustomerToProfileMap(db);
  const failures: Array<{ check: string; count: number }> = [];

  for (const spec of SINGLE_FK_SPECS) {
    if (!tableExists(db, spec.table)) continue;
    const missingProfile = count(
      db,
      `SELECT COUNT(*) AS n FROM ${quoteIdentifier(spec.table)}
       WHERE ${quoteIdentifier(spec.customerColumn)} IS NOT NULL
         AND ${quoteIdentifier(spec.profileColumn)} IS NULL`,
    );
    if (missingProfile > 0) {
      failures.push({
        check: `${spec.table}: ${spec.customerColumn} 有值但 ${spec.profileColumn} 为空`,
        count: missingProfile,
      });
    }

    // 映射一致性：profileId 必须等于 map(customerId)
    const mismatched = db
      .prepare(
        `SELECT ${quoteIdentifier(spec.customerColumn)} AS customerId,
                ${quoteIdentifier(spec.profileColumn)} AS profileId
         FROM ${quoteIdentifier(spec.table)}
         WHERE ${quoteIdentifier(spec.customerColumn)} IS NOT NULL
           AND ${quoteIdentifier(spec.profileColumn)} IS NOT NULL`,
      )
      .all() as Array<{ customerId: string; profileId: string }>;
    let bad = 0;
    for (const row of mismatched) {
      if (map.get(row.customerId) !== row.profileId) bad++;
    }
    if (bad > 0) {
      failures.push({
        check: `${spec.table}: ${spec.profileColumn} 与 sourceCustomerId 映射不一致`,
        count: bad,
      });
    }
  }

  for (const spec of VERIFY_ONLY_IF_ALREADY_PROFILE) {
    if (!tableExists(db, spec.table) || !columnExists(db, spec.table, spec.profileColumn)) continue;
    const missing = count(
      db,
      `SELECT COUNT(*) AS n FROM ${quoteIdentifier(spec.table)}
       WHERE ${quoteIdentifier(spec.customerColumn)} IS NOT NULL
         AND ${quoteIdentifier(spec.profileColumn)} IS NULL`,
    );
    if (missing > 0) {
      failures.push({
        check: `${spec.table}: ${spec.customerColumn} 有值但 ${spec.profileColumn} 为空`,
        count: missing,
      });
    }
  }

  // 快照表：仅校验「已填的 profileId」与映射一致；允许未映射旧 ID 保持 null
  for (const spec of BEST_EFFORT_SNAPSHOT_SPECS) {
    if (!tableExists(db, spec.table) || !columnExists(db, spec.table, spec.profileColumn)) continue;
    const mismatched = db
      .prepare(
        `SELECT ${quoteIdentifier(spec.customerColumn)} AS customerId,
                ${quoteIdentifier(spec.profileColumn)} AS profileId
         FROM ${quoteIdentifier(spec.table)}
         WHERE ${quoteIdentifier(spec.customerColumn)} IS NOT NULL
           AND ${quoteIdentifier(spec.profileColumn)} IS NOT NULL`,
      )
      .all() as Array<{ customerId: string; profileId: string }>;
    let bad = 0;
    for (const row of mismatched) {
      if (map.get(row.customerId) !== row.profileId) bad++;
    }
    if (bad > 0) {
      failures.push({
        check: `${spec.table}: 已回填 ${spec.profileColumn} 与映射不一致`,
        count: bad,
      });
    }
  }

  // 生命周期：每个 Customer 对应 Profile 的 deleted/merged 应一致
  const lifecycleDrift = count(
    db,
    `SELECT COUNT(*) AS n
     FROM Customer c
     JOIN CrmCustomerProfile p ON p.sourceCustomerId = c.id
     WHERE c.deleted <> p.deleted
        OR ifnull(c.deletedAt, '') <> ifnull(p.deletedAt, '')
        OR ifnull(
             (SELECT p2.id FROM CrmCustomerProfile p2 WHERE p2.sourceCustomerId = c.mergedIntoId),
             ''
           ) <> ifnull(p.mergedIntoProfileId, '')`,
  );
  if (lifecycleDrift > 0) {
    failures.push({ check: "Customer↔Profile 生命周期字段漂移", count: lifecycleDrift });
  }

  const result = {
    mode: "verify",
    mappingSize: map.size,
    failures,
    blocking: failures.reduce((sum, f) => sum + f.count, 0),
  };
  console.log(JSON.stringify(result, null, 2));
  if (result.blocking > 0) {
    throw new Error(`expand verify 失败：${result.blocking} 项`);
  }
  console.log("✅ expand verify 通过");
}

function main(): void {
  const argv = process.argv.slice(2);
  const mode = argv.includes("--backfill")
    ? "backfill"
    : argv.includes("--verify")
      ? "verify"
      : "precheck";
  const writable = mode === "backfill";
  const db = new Database(databasePathFromEnv(), { readonly: !writable, fileMustExist: true });
  try {
    if (mode === "backfill") backfill(db);
    else if (mode === "verify") verify(db);
    else precheck(db);
  } finally {
    db.close();
  }
}

try {
  main();
} catch (error) {
  console.error("[expand-profile-fks]", error);
  process.exitCode = 1;
}

/**
 * Customer -> CrmCustomerProfile 主权切换校验。
 *
 * 直接使用 SQLite 元数据和 SQL，故可同时运行在：
 * - 仍保留 Customer 旧业务列的数据库（删列前）
 * - 已完成 Customer anchor cutover 的数据库（删列后）
 *
 * profile-id-boundary allow-list:
 *   本文件使用原始 SQL 探测/回填旧列，属于专用 cutover 工具。
 *   已列入 scripts/profile-id-boundary-allowlist.ts 的 LEGACY_FIELD_SCAN_ALLOWLIST，
 *   边界扫描不得将其 SQL 字符串误判为 Prisma Customer 业务字段写入。
 *
 * 用法：
 *   DATABASE_URL=file:/abs/dev.db npx tsx scripts/check-customer-profile-migration.ts --detect
 *   DATABASE_URL=file:/abs/dev.db npx tsx scripts/check-customer-profile-migration.ts --prepare-cutover
 *   DATABASE_URL=file:/abs/dev.db npx tsx scripts/check-customer-profile-migration.ts --precheck
 *   DATABASE_URL=file:/abs/dev.db npx tsx scripts/check-customer-profile-migration.ts --postcheck
 *   DATABASE_URL=file:/abs/dev.db npx tsx scripts/check-customer-profile-migration.ts \
 *     --verify-cutover=/abs/dev.db.before-schema
 */
import path from "node:path";
import Database from "better-sqlite3";

const LEGACY_CUSTOMER_COLUMNS = [
  "customerCode",
  "name",
  "nameDisambiguator",
  "principal",
  "email",
  "wechat",
  "phone",
  "organization",
  "address",
  "addressNote",
  "receiverPhone",
  "receiverAddress",
  "miniProgramId",
  "organizationId",
  "organizationSiteId",
  "organizationRawInput",
  "labOrGroup",
  "archived",
  "archivedAt",
] as const;

const PROFILE_COPY_COLUMNS = LEGACY_CUSTOMER_COLUMNS.filter(
  (column) => column !== "archived" && column !== "archivedAt",
);

type CountRow = { n: number };
type ColumnRow = { name: string };
type TableRow = { name: string };
type MissingRow = { id: string; fields: string };

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

function tableColumns(db: Database.Database, table: string): Set<string> {
  return new Set(
    db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all().map((row) => (row as ColumnRow).name),
  );
}

function userTables(db: Database.Database): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => (row as TableRow).name);
}

function count(db: Database.Database, sql: string): number {
  return Number((db.prepare(sql).get() as CountRow | undefined)?.n ?? 0);
}

function legacyColumnsPresent(db: Database.Database): string[] {
  const columns = tableColumns(db, "Customer");
  return LEGACY_CUSTOMER_COLUMNS.filter((column) => columns.has(column));
}

function assertRequiredTables(db: Database.Database): void {
  const tables = new Set(userTables(db));
  for (const table of ["Customer", "CrmCustomerProfile"]) {
    if (!tables.has(table)) throw new Error(`数据库缺少 ${table} 表`);
  }
}

function commonIntegrityChecks(db: Database.Database): { summary: Record<string, number>; blocking: number } {
  let blocking = 0;
  const activeCustomerMissingProfile = count(
    db,
    `SELECT COUNT(*) AS n FROM Customer c
     LEFT JOIN CrmCustomerProfile p ON p.sourceCustomerId = c.id
     WHERE c.deleted = 0 AND c.mergedIntoId IS NULL AND p.id IS NULL`,
  );
  const activeProfileMissingIdentity = count(
    db,
    `SELECT COUNT(*) AS n FROM CrmCustomerProfile p
     JOIN Customer c ON c.id = p.sourceCustomerId
     WHERE c.deleted = 0 AND c.mergedIntoId IS NULL
       AND (p.name IS NULL OR trim(p.name) = '' OR p.customerCode IS NULL OR trim(p.customerCode) = '')`,
  );
  const duplicateProfileCodeGroups = count(
    db,
    `SELECT COUNT(*) AS n FROM (
       SELECT customerCode FROM CrmCustomerProfile
       WHERE customerCode IS NOT NULL AND trim(customerCode) <> ''
       GROUP BY customerCode HAVING COUNT(*) > 1
     )`,
  );
  const orphanProfiles = count(
    db,
    `SELECT COUNT(*) AS n FROM CrmCustomerProfile p
     LEFT JOIN Customer c ON c.id = p.sourceCustomerId WHERE c.id IS NULL`,
  );
  const profileOrgPointsToMissingOrDeleted = count(
    db,
    `SELECT COUNT(*) AS n FROM CrmCustomerProfile p
     LEFT JOIN Organization o ON o.id = p.organizationId
     WHERE p.organizationId IS NOT NULL AND (o.id IS NULL OR o.deleted = 1)`,
  );
  const profileSiteOrgMismatch = count(
    db,
    `SELECT COUNT(*) AS n FROM CrmCustomerProfile p
     JOIN OrganizationSite s ON s.id = p.organizationSiteId
     WHERE p.organizationSiteId IS NOT NULL
       AND (p.organizationId IS NULL OR s.organizationId <> p.organizationId)`,
  );

  blocking += activeCustomerMissingProfile;
  // name/customerCode 仍是 nullable-first（schema 中尚未收紧为必填）。这里保留
  // 可观测性，但不因历史测试/占位 Profile 的空 identity 阻断部署；若旧 Customer
  // 有值而 Profile 为空，precheck 的逐字段承接检查仍会阻断。
  blocking += duplicateProfileCodeGroups;
  blocking += orphanProfiles;
  // 机构引用/站点口径属于既有治理数据质量，不会因 Customer 旧列删除而
  // 丢失；部署中保留计数告警，但不阻断本次 anchor cutover。

  return {
    summary: {
      activeCustomerMissingProfile,
      activeProfileMissingIdentity,
      duplicateProfileCodeGroups,
      orphanProfiles,
      profileOrgPointsToMissingOrDeleted,
      profileSiteOrgMismatch,
    },
    blocking,
  };
}

function precheck(db: Database.Database): void {
  assertRequiredTables(db);
  const present = legacyColumnsPresent(db);
  const { summary, blocking: commonBlocking } = commonIntegrityChecks(db);
  let blocking = commonBlocking;
  let customersWithUnmigratedFields = 0;
  let deletedCustomersWithLegacyFields = 0;
  const examples: MissingRow[] = [];

  if (present.length > 0) {
    const comparable = PROFILE_COPY_COLUMNS.filter((column) => present.includes(column));
    const missingExpressions = comparable.map(
      (column) =>
        `(c.${quoteIdentifier(column)} IS NOT NULL AND trim(CAST(c.${quoteIdentifier(column)} AS TEXT)) <> ''` +
        ` AND (p.${quoteIdentifier(column)} IS NULL OR trim(CAST(p.${quoteIdentifier(column)} AS TEXT)) = ''))`,
    );
    const missingFieldList = comparable
      .map(
        (column) =>
          `CASE WHEN ${missingExpressions[comparable.indexOf(column)]} THEN '${column},' ELSE '' END`,
      )
      .join(" || ");

    if (missingExpressions.length > 0) {
      customersWithUnmigratedFields = count(
        db,
        `SELECT COUNT(*) AS n FROM Customer c
         LEFT JOIN CrmCustomerProfile p ON p.sourceCustomerId = c.id
         WHERE c.deleted = 0 AND c.mergedIntoId IS NULL
           AND (${missingExpressions.join(" OR ")})`,
      );
      examples.push(
        ...(db
          .prepare(
            `SELECT c.id, rtrim(${missingFieldList}, ',') AS fields
             FROM Customer c
             LEFT JOIN CrmCustomerProfile p ON p.sourceCustomerId = c.id
             WHERE c.deleted = 0 AND c.mergedIntoId IS NULL
               AND (${missingExpressions.join(" OR ")}) LIMIT 20`,
          )
          .all() as MissingRow[]),
      );

      deletedCustomersWithLegacyFields = count(
        db,
        `SELECT COUNT(*) AS n FROM Customer c
         LEFT JOIN CrmCustomerProfile p ON p.sourceCustomerId = c.id
         WHERE c.deleted = 1 AND (${missingExpressions.join(" OR ")})`,
      );
    }

  }

  // archived/archivedAt 是旧生命周期快照，不参与字段回填：Profile.archived
  // 已经是运行时主权，不能用可能陈旧的 Customer.archived 反向覆盖。
  blocking += customersWithUnmigratedFields;
  const result = {
    mode: "precheck",
    legacyCustomerColumnsPresent: present,
    ...summary,
    customersWithUnmigratedFields,
    deletedCustomersWithLegacyFields,
    blockingIssues: blocking,
  };
  console.log(JSON.stringify(result, null, 2));
  if (examples.length > 0) console.error("未承接字段示例:", examples);
  if (blocking > 0) throw new Error(`Customer/Profile 切换预检发现 ${blocking} 个阻断项`);
  console.log("✅ Customer/Profile 切换预检通过");
}

function prepareCutover(db: Database.Database): void {
  assertRequiredTables(db);
  const present = legacyColumnsPresent(db);
  if (present.length === 0) {
    console.log(JSON.stringify({ mode: "prepare-cutover", updatedByField: {}, totalFieldUpdates: 0 }, null, 2));
    return;
  }

  // customerCode 在 Profile 上有 unique 约束。先显式报告跨客户占用，避免
  // transaction 只抛出一个难以定位的 SQLITE_CONSTRAINT_UNIQUE。
  if (present.includes("customerCode")) {
    const codeConflicts = count(
      db,
      `SELECT COUNT(*) AS n FROM Customer c
       JOIN CrmCustomerProfile target ON target.sourceCustomerId = c.id
       JOIN CrmCustomerProfile existing
         ON existing.customerCode = c.customerCode AND existing.id <> target.id
       WHERE c.customerCode IS NOT NULL AND trim(c.customerCode) <> ''
         AND (target.customerCode IS NULL OR trim(target.customerCode) = '')`,
    );
    if (codeConflicts > 0) {
      throw new Error(`旧 Customer.customerCode 与其他 Profile 冲突 ${codeConflicts} 条，拒绝自动回填`);
    }
  }

  const updatedByField: Record<string, number> = {};
  const run = db.transaction(() => {
    for (const column of PROFILE_COPY_COLUMNS.filter((name) => present.includes(name))) {
      const quoted = quoteIdentifier(column);
      const result = db
        .prepare(
          `UPDATE CrmCustomerProfile
           SET ${quoted} = (
             SELECT c.${quoted} FROM Customer c
             WHERE c.id = CrmCustomerProfile.sourceCustomerId
           )
           WHERE (${quoted} IS NULL OR trim(CAST(${quoted} AS TEXT)) = '')
             AND EXISTS (
               SELECT 1 FROM Customer c
               WHERE c.id = CrmCustomerProfile.sourceCustomerId
                 AND c.${quoted} IS NOT NULL
                 AND trim(CAST(c.${quoted} AS TEXT)) <> ''
             )`,
        )
        .run();
      updatedByField[column] = result.changes;
    }
  });
  run();

  const totalFieldUpdates = Object.values(updatedByField).reduce((sum, value) => sum + value, 0);
  console.log(JSON.stringify({ mode: "prepare-cutover", updatedByField, totalFieldUpdates }, null, 2));
  console.log("✅ Customer 非空旧值已幂等补入 Profile 空字段（Profile 既有值未覆盖）");
}

function postcheck(db: Database.Database): void {
  assertRequiredTables(db);
  const present = legacyColumnsPresent(db);
  const { summary, blocking: commonBlocking } = commonIntegrityChecks(db);
  const blocking = commonBlocking + present.length;
  console.log(JSON.stringify({ mode: "postcheck", legacyCustomerColumnsPresent: present, ...summary, blockingIssues: blocking }, null, 2));
  if (blocking > 0) throw new Error(`Customer/Profile 切换后验收发现 ${blocking} 个阻断项`);
  console.log("✅ Customer 已收口为 anchor，Profile 完整性校验通过");
}

function verifyCutover(beforePath: string, afterDb: Database.Database): void {
  const beforeDb = new Database(path.resolve(beforePath), { readonly: true, fileMustExist: true });
  try {
    const beforeTables = userTables(beforeDb);
    const afterTables = new Set(userTables(afterDb));
    const removedTables = beforeTables.filter((table) => !afterTables.has(table));
    const removedColumns: string[] = [];
    for (const table of beforeTables.filter((name) => afterTables.has(name))) {
      const afterColumns = tableColumns(afterDb, table);
      for (const column of tableColumns(beforeDb, table)) {
        if (!afterColumns.has(column)) removedColumns.push(`${table}.${column}`);
      }
    }
    const allowed = new Set(LEGACY_CUSTOMER_COLUMNS.map((column) => `Customer.${column}`));
    const unexpectedRemovedColumns = removedColumns.filter((column) => !allowed.has(column));
    const legacyBefore = legacyColumnsPresent(beforeDb);
    const legacyAfter = legacyColumnsPresent(afterDb);
    console.log(JSON.stringify({ mode: "verify-cutover", removedTables, removedColumns, unexpectedRemovedColumns, legacyBefore, legacyAfter }, null, 2));
    if (removedTables.length > 0 || unexpectedRemovedColumns.length > 0 || legacyAfter.length > 0 || legacyBefore.length === 0) {
      throw new Error("schema push 不符合仅删除 Customer 旧业务列的受控切换范围");
    }
    console.log("✅ destructive schema 变更仅涉及已批准的 Customer 旧业务列");
  } finally {
    beforeDb.close();
  }
}

function main(): void {
  const argv = process.argv.slice(2);
  const prepare = argv.includes("--prepare-cutover");
  const db = new Database(databasePathFromEnv(), { readonly: !prepare, fileMustExist: true });
  try {
    if (argv.includes("--detect")) {
      assertRequiredTables(db);
      process.stdout.write(legacyColumnsPresent(db).length > 0 ? "required" : "not-needed");
      return;
    }
    const verifyArg = argv.find((arg) => arg.startsWith("--verify-cutover="));
    if (verifyArg) {
      verifyCutover(verifyArg.slice("--verify-cutover=".length), db);
      return;
    }
    if (prepare) {
      prepareCutover(db);
      return;
    }
    if (argv.includes("--postcheck")) postcheck(db);
    else precheck(db);
  } finally {
    db.close();
  }
}

try {
  main();
} catch (error) {
  console.error("[check-customer-profile-migration]", error);
  process.exitCode = 1;
}

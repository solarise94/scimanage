/**
 * Audit and repair non-ISO datetime strings in CrmVisitCheckin.
 *
 * Background:
 * Prisma + SQLite DateTime columns are expected to contain RFC 3339 / ISO 8601
 * strings. Historical rows like "2026-04-28 06:23:34" can trigger:
 *   P2023 Inconsistent column data
 * when Prisma reads/groupBy/max over these fields.
 *
 * Usage:
 *   npx tsx scripts/repair-crm-visit-checkin-datetimes.ts
 *   npx tsx scripts/repair-crm-visit-checkin-datetimes.ts --write
 *   npx tsx scripts/repair-crm-visit-checkin-datetimes.ts --write --timezone +08:00
 *   npx tsx scripts/repair-crm-visit-checkin-datetimes.ts --db /path/to/dev.db
 *
 * Notes:
 * - Dry-run by default; only writes when --write is passed.
 * - Default timezone suffix is Z, which matches SQLite CURRENT_TIMESTAMP semantics.
 * - If historical bad rows were written as local wall-clock time, pass an explicit
 *   offset such as --timezone +08:00 when repairing.
 */

import { execFileSync } from "node:child_process";
import path from "node:path";

type CheckinRow = {
  id: string;
  createdAt: unknown;
  updatedAt: unknown;
  completedAt: unknown;
};

type FieldName = "createdAt" | "updatedAt" | "completedAt";

type PlannedFix = {
  field: FieldName;
  from: string;
  to: string;
};

type RowPlan = {
  id: string;
  fixes: PlannedFix[];
};

type AuditResult = {
  totalRows: number;
  plannedRows: RowPlan[];
  validCount: number;
  unsupported: Array<{ id: string; field: FieldName; value: string }>;
};

const FIELD_NAMES: FieldName[] = ["createdAt", "updatedAt", "completedAt"];
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;
const SPACE_PATTERN = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?$/;
const T_NO_TZ_PATTERN = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?$/;
const DEFAULT_DB_PATH = path.resolve(process.cwd(), "prisma/dev.db");

function printUsage(): void {
  console.log(
    [
      "Usage:",
      "  npx tsx scripts/repair-crm-visit-checkin-datetimes.ts [--write] [--db <path>] [--timezone <Z|+08:00|-05:00>]",
    ].join("\n"),
  );
}

function parseArgs(argv: string[]) {
  let write = false;
  let dbArg: string | null = null;
  let timezone = "Z";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--write") {
      write = true;
      continue;
    }
    if (arg === "--db") {
      dbArg = argv[i + 1] ?? null;
      i++;
      continue;
    }
    if (arg === "--timezone") {
      timezone = argv[i + 1] ?? "";
      i++;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (dbArg === "") {
    throw new Error("--db requires a non-empty path");
  }
  if (!/^Z$|^[+-]\d{2}:\d{2}$/.test(timezone)) {
    throw new Error(`Invalid --timezone value: ${timezone}`);
  }

  return {
    write,
    dbPath: resolveDbPath(dbArg),
    timezone,
  };
}

function resolveDbPath(dbArg: string | null): string {
  if (dbArg) {
    return path.resolve(process.cwd(), dbArg);
  }

  const raw = process.env.DATABASE_URL?.trim();
  if (!raw) {
    return DEFAULT_DB_PATH;
  }

  if (raw.startsWith("file:")) {
    const withoutQuery = raw.slice("file:".length).split("?")[0] ?? "";
    if (!withoutQuery) {
      return DEFAULT_DB_PATH;
    }
    if (path.isAbsolute(withoutQuery)) {
      return withoutQuery;
    }
    return path.resolve(process.cwd(), withoutQuery);
  }

  return path.resolve(process.cwd(), raw);
}

function runSqliteJson<T>(dbPath: string, sql: string): T {
  try {
    const stdout = execFileSync("sqlite3", ["-json", dbPath, sql], {
      encoding: "utf8",
    });
    return stdout.trim() ? (JSON.parse(stdout) as T) : ([] as unknown as T);
  } catch (error: unknown) {
    if (error && typeof error === "object" && "code" in error && (error as { code: string }).code === "ENOENT") {
      console.error("[CHECKIN-DATETIME] sqlite3 CLI not found. Please install sqlite3 first.");
      process.exit(1);
    }
    throw error;
  }
}

function runSqlite(dbPath: string, sql: string): void {
  try {
    execFileSync("sqlite3", [dbPath, sql], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error: unknown) {
    if (error && typeof error === "object" && "code" in error && (error as { code: string }).code === "ENOENT") {
      console.error("[CHECKIN-DATETIME] sqlite3 CLI not found. Please install sqlite3 first.");
      process.exit(1);
    }
    throw error;
  }
}

function normalizeRepairableDate(value: string, timezone: string): string | null {
  const spaceMatch = value.match(SPACE_PATTERN);
  if (spaceMatch) {
    return formatIso(spaceMatch[1], spaceMatch[2], spaceMatch[3], timezone);
  }

  const tNoTzMatch = value.match(T_NO_TZ_PATTERN);
  if (tNoTzMatch) {
    return formatIso(tNoTzMatch[1], tNoTzMatch[2], tNoTzMatch[3], timezone);
  }

  return null;
}

function formatIso(datePart: string, timePart: string, fraction: string | undefined, timezone: string): string {
  const milliseconds = (fraction ?? "").slice(0, 3).padEnd(3, "0");
  return `${datePart}T${timePart}.${milliseconds}${timezone}`;
}

function auditRows(rows: CheckinRow[], timezone: string): AuditResult {
  const plannedRows: RowPlan[] = [];
  const unsupported: AuditResult["unsupported"] = [];
  let validCount = 0;

  for (const row of rows) {
    const fixes: PlannedFix[] = [];

    for (const field of FIELD_NAMES) {
      const raw = row[field];
      if (raw == null) continue;
      if (typeof raw !== "string") continue;
      if (ISO_PATTERN.test(raw)) {
        validCount++;
        continue;
      }

      const normalized = normalizeRepairableDate(raw, timezone);
      if (normalized) {
        fixes.push({ field, from: raw, to: normalized });
        continue;
      }

      unsupported.push({ id: row.id, field, value: raw });
    }

    if (fixes.length > 0) {
      plannedRows.push({ id: row.id, fixes });
    }
  }

  return {
    totalRows: rows.length,
    plannedRows,
    validCount,
    unsupported,
  };
}

function escapeSqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function buildUpdateSql(plan: RowPlan): string {
  const assignments = plan.fixes
    .map((fix) => `"${fix.field}" = ${escapeSqlString(fix.to)}`)
    .join(", ");

  return `UPDATE "CrmVisitCheckin" SET ${assignments} WHERE "id" = ${escapeSqlString(plan.id)};`;
}

function printSummary(result: AuditResult): void {
  const fixCount = result.plannedRows.reduce((sum, row) => sum + row.fixes.length, 0);

  console.log(`[CHECKIN-DATETIME] rows_scanned=${result.totalRows}`);
  console.log(`[CHECKIN-DATETIME] valid_fields=${result.validCount}`);
  console.log(`[CHECKIN-DATETIME] repairable_rows=${result.plannedRows.length}`);
  console.log(`[CHECKIN-DATETIME] repairable_fields=${fixCount}`);
  console.log(`[CHECKIN-DATETIME] unsupported_fields=${result.unsupported.length}`);

  if (result.plannedRows.length > 0) {
    console.log("[CHECKIN-DATETIME] Sample planned fixes:");
    for (const row of result.plannedRows.slice(0, 10)) {
      for (const fix of row.fixes) {
        console.log(`  - ${row.id} ${fix.field}: ${fix.from} -> ${fix.to}`);
      }
    }
  }

  if (result.unsupported.length > 0) {
    console.log("[CHECKIN-DATETIME] Unsupported values requiring manual review:");
    for (const item of result.unsupported.slice(0, 10)) {
      console.log(`  - ${item.id} ${item.field}: ${item.value}`);
    }
  }
}

async function main() {
  const { write, dbPath, timezone } = parseArgs(process.argv.slice(2));

  console.log(`[CHECKIN-DATETIME] db=${dbPath}`);
  console.log(`[CHECKIN-DATETIME] mode=${write ? "write" : "dry-run"}`);
  console.log(`[CHECKIN-DATETIME] timezone=${timezone}`);

  const rows = runSqliteJson<CheckinRow[]>(
    dbPath,
    `SELECT "id", "createdAt", "updatedAt", "completedAt" FROM "CrmVisitCheckin" ORDER BY "createdAt" ASC`,
  );

  const audit = auditRows(rows, timezone);
  printSummary(audit);

  if (!write) {
    if (audit.plannedRows.length > 0) {
      console.log("[CHECKIN-DATETIME] Dry-run only. Re-run with --write to apply repairs.");
    }
    if (audit.unsupported.length > 0) {
      process.exit(1);
    }
    return;
  }

  if (audit.unsupported.length > 0) {
    console.error("[CHECKIN-DATETIME] Abort write: unsupported datetime strings exist.");
    process.exit(1);
  }

  if (audit.plannedRows.length === 0) {
    console.log("[CHECKIN-DATETIME] No repairable rows found.");
    return;
  }

  const statements = audit.plannedRows.map(buildUpdateSql);
  runSqlite(dbPath, ["BEGIN IMMEDIATE;", ...statements, "COMMIT;"].join("\n"));
  console.log(`[CHECKIN-DATETIME] Applied updates to ${audit.plannedRows.length} rows.`);

  const postRows = runSqliteJson<CheckinRow[]>(
    dbPath,
    `SELECT "id", "createdAt", "updatedAt", "completedAt" FROM "CrmVisitCheckin" ORDER BY "createdAt" ASC`,
  );
  const postAudit = auditRows(postRows, timezone);
  printSummary(postAudit);

  if (postAudit.plannedRows.length > 0 || postAudit.unsupported.length > 0) {
    console.error("[CHECKIN-DATETIME] Repair incomplete; remaining suspect datetime values detected.");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("[CHECKIN-DATETIME] Fatal error:", error);
  process.exit(1);
});

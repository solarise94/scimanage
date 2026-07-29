/**
 * Phase E data disposition：删除 Customer 锚点前，对"锚点 deleted=true 且无 Profile"数据的处置。
 *
 * 方案：docs/customer-legacy-field-remediation-plan-2026-07-15.md Phase E 节（W6.7c 既定政策）。
 * 映射唯一来源：CrmCustomerProfile.sourceCustomerId（@unique）。
 *
 * 动作（全部幂等；dry-run 默认不写库、不写文件）：
 * 1. 墓碑 Profile 创建：对被 CustomerMergeLog / CustomerMergeTask 引用的无 Profile 锚点，
 *    从该锚点最近一次 merge log 的 source/target(Profile)SnapshotJson 提取业务字段
 *    （无快照则 name = `历史客户 <id>`），创建墓碑 Profile：
 *    sourceCustomerId=anchor.id、deleted=true、deletedAt=anchor.deletedAt（无则用 merge log
 *    createdAt）、mergedIntoProfileId=anchor.mergedIntoId 经 sourceCustomerId 映射（目标无
 *    Profile 置 null 并计数）、assignmentStatus='UNASSIGNED'、ownerUserId=merge log operatorId
 *    （回退第一个 ADMIN 用户）、stage='LEAD'。已存在映射的锚点跳过（幂等）。
 * 2. 陈旧绑定任务删除：CustomerOrgBindingTask 中 customerId 无 Profile 映射的任务，
 *    先把完整行导出为 JSON（scripts/out/org-binding-tasks-deleted-anchor-<ts>.json，
 *    该目录已加入 .gitignore），再删除。注意：本动作的目标集按**处置前**状态判定，
 *    事务内先 DELETE 再 INSERT 墓碑，保证引用了待建墓碑锚点的任务也被一并清除；
 *    二次运行 0 行（幂等）。
 * 3. 汇总报告 + 任何异常（非 deleted 锚点被 merge 表引用 / 锚点引用悬空 / 无可用 owner）exit 1。
 *
 * 前置条件：Phase C expand schema 已 db push（Profile 需有 deleted/deletedAt/mergedIntoProfileId）。
 *
 * 用法：
 *   npx tsx scripts/phase-e-data-disposition.ts [--db /abs/path/dev.db]            # dry-run（默认）
 *   npx tsx scripts/phase-e-data-disposition.ts [--db /abs/path/dev.db] --apply    # 单事务落库
 *
 * 退出码：异常 → 1；全绿（dry-run 或 apply 成功）→ 0。
 */

import fs from "node:fs";
import path from "node:path";
import { createId } from "@paralleldrive/cuid2";

// ─────────────────────────────────────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────────────────────────────────────

const PROFILE_TABLE = "CrmCustomerProfile";
const PROFILE_SOURCE_COLUMN = "sourceCustomerId";
const CUSTOMER_TABLE = "Customer";
const MERGE_LOG_TABLE = "CustomerMergeLog";
const MERGE_TASK_TABLE = "CustomerMergeTask";
const BINDING_TASK_TABLE = "CustomerOrgBindingTask";
const USER_TABLE = "User";
const PROFILE_LIFECYCLE_COLUMNS = ["deleted", "deletedAt", "mergedIntoProfileId"] as const;
const EXPORT_DIR = path.resolve(process.cwd(), "scripts/out");
const ANOMALY_SAMPLE_LIMIT = 20;

/** 从 merge 快照提取的 Profile 业务字段 */
const SNAPSHOT_BUSINESS_FIELDS = [
  "name",
  "customerCode",
  "nameDisambiguator",
  "principal",
  "labOrGroup",
  "phone",
  "wechat",
  "email",
  "miniProgramId",
  "address",
  "addressNote",
  "receiverPhone",
  "receiverAddress",
  "organization",
  "organizationId",
  "organizationSiteId",
  "organizationRawInput",
] as const;

type SnapshotBusinessField = (typeof SNAPSHOT_BUSINESS_FIELDS)[number];

// ─────────────────────────────────────────────────────────────────────────────
// 参数与 DB 路径解析（--db > DATABASE_URL env > 仓库 prisma/dev.db）
// ─────────────────────────────────────────────────────────────────────────────

type Args = { dbPath: string; apply: boolean };

function printUsage(): void {
  console.log(
    [
      "Usage:",
      "  npx tsx scripts/phase-e-data-disposition.ts [--db <path>]            # dry-run（默认，不写库）",
      "  npx tsx scripts/phase-e-data-disposition.ts [--db <path>] --apply    # 导出 JSON + 单事务落库",
      "",
      "异常（非 deleted 锚点被 merge 表引用 / 引用悬空 / 无可用 owner）→ exit 1。",
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

/** SQLite 日期列（epoch ms INTEGER）→ number | null */
function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return num(value);
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
// 类型
// ─────────────────────────────────────────────────────────────────────────────

type AnchorRow = {
  id: string;
  deleted: number | bigint;
  deletedAt: number | bigint | null;
  mergedIntoId: string | null;
};

type MergeLogRow = {
  id: string;
  operatorId: string;
  createdAt: number | bigint;
  legacySnapshotJson: string | null;
  profileSnapshotJson: string | null;
};

type TombstonePlan = {
  anchorId: string;
  newProfileId: string;
  name: string;
  fields: Record<SnapshotBusinessField, string | null>;
  customerCodeCollision: boolean;
  ownerUserId: string;
  ownerFallback: boolean;
  deletedAt: number;
  mergedIntoProfileId: string | null;
  mergedIntoUnmapped: boolean;
  snapshotSource: "merge-log-source" | "merge-log-target" | "none";
  snapshotParseFailed: boolean;
};

// ─────────────────────────────────────────────────────────────────────────────
// 快照解析
// ─────────────────────────────────────────────────────────────────────────────

function extractSnapshotFields(json: string | null): {
  fields: Record<SnapshotBusinessField, string | null> | null;
  parseFailed: boolean;
} {
  const empty = Object.fromEntries(
    SNAPSHOT_BUSINESS_FIELDS.map((f) => [f, null]),
  ) as Record<SnapshotBusinessField, string | null>;
  if (!json) return { fields: null, parseFailed: false };
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const fields = { ...empty };
    for (const f of SNAPSHOT_BUSINESS_FIELDS) {
      const v = parsed[f];
      if (typeof v === "string" && v.trim() !== "") fields[f] = v;
    }
    return { fields, parseFailed: false };
  } catch {
    return { fields: null, parseFailed: true };
  }
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
    console.log(`=== Phase E Data Disposition（${mode}）===`);
    console.log(`Database: ${args.dbPath}`);

    // ── 前置条件 ──
    if (!(await tableExists(prisma, CUSTOMER_TABLE))) {
      console.log(`ℹ️ ${CUSTOMER_TABLE} 表不存在（Phase E contract 已完成），无处置对象`);
      return 0;
    }
    if (!(await tableExists(prisma, PROFILE_TABLE))) {
      console.error(`❌ ${PROFILE_TABLE} 表缺失，无法建立映射`);
      return 1;
    }
    const profileCols = await tableColumns(prisma, PROFILE_TABLE);
    if (!profileCols.has(PROFILE_SOURCE_COLUMN)) {
      console.error(
        `❌ ${PROFILE_TABLE}.${PROFILE_SOURCE_COLUMN} 已删除，旧 ID→Profile ID 映射不可用；禁止继续`,
      );
      return 1;
    }
    const lifecycleColumnsReady = PROFILE_LIFECYCLE_COLUMNS.every((c) => profileCols.has(c));

    const p = qi(PROFILE_TABLE);
    const src = qi(PROFILE_SOURCE_COLUMN);
    const c = qi(CUSTOMER_TABLE);

    // merge 表引用臂（仅统计存在的表/列）
    const refArms: string[] = [];
    const mergeLogExists = await tableExists(prisma, MERGE_LOG_TABLE);
    const mergeTaskExists = await tableExists(prisma, MERGE_TASK_TABLE);
    if (mergeLogExists) {
      const cols = await tableColumns(prisma, MERGE_LOG_TABLE);
      if (cols.has("sourceCustomerId")) refArms.push(`SELECT "sourceCustomerId" AS cid FROM ${qi(MERGE_LOG_TABLE)}`);
      if (cols.has("targetCustomerId")) refArms.push(`SELECT "targetCustomerId" AS cid FROM ${qi(MERGE_LOG_TABLE)}`);
    }
    if (mergeTaskExists) {
      const cols = await tableColumns(prisma, MERGE_TASK_TABLE);
      if (cols.has("customerIdA")) refArms.push(`SELECT "customerIdA" AS cid FROM ${qi(MERGE_TASK_TABLE)}`);
      if (cols.has("customerIdB")) refArms.push(`SELECT "customerIdB" AS cid FROM ${qi(MERGE_TASK_TABLE)}`);
    }

    const anomalies: string[] = [];

    // ── 1. 墓碑候选锚点 ──
    console.log("\n── 1. 墓碑 Profile 候选（被 merge 表引用的无 Profile 锚点）──");
    let candidates: AnchorRow[] = [];
    if (refArms.length === 0) {
      console.log("  ℹ️ merge 表/列不存在（contract 已完成），无墓碑候选");
    } else {
      const refsUnion = refArms.join("\n       UNION\n       ");
      candidates = await prisma.$queryRawUnsafe<AnchorRow[]>(
        `SELECT c.id AS id, c."deleted" AS deleted, c."deletedAt" AS deletedAt, c."mergedIntoId" AS mergedIntoId
         FROM ${c} c
         WHERE NOT EXISTS (SELECT 1 FROM ${p} pp WHERE pp.${src} = c.id)
           AND c.id IN (${refsUnion})
         ORDER BY c.id`,
      );
      // 悬空引用（Customer 中已不存在的锚点）→ 异常
      const danglingRefs = await prisma.$queryRawUnsafe<Array<{ cid: string }>>(
        `SELECT DISTINCT cid FROM (${refsUnion})
         WHERE cid IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM ${p} pp WHERE pp.${src} = cid)
           AND NOT EXISTS (SELECT 1 FROM ${c} c WHERE c.id = cid)
         LIMIT ${ANOMALY_SAMPLE_LIMIT + 1}`,
      );
      if (danglingRefs.length > 0) {
        const shown = danglingRefs.slice(0, ANOMALY_SAMPLE_LIMIT);
        anomalies.push(
          `merge 表引用悬空锚点（Customer 不存在）${danglingRefs.length}${danglingRefs.length > ANOMALY_SAMPLE_LIMIT ? "+" : ""} 个: ${shown.map((r) => r.cid).join(", ")}`,
        );
      }
      // 非 deleted 锚点 → 异常（本动作只处置 deleted=true 的墓碑场景）
      const notDeleted = candidates.filter((a) => num(a.deleted) !== 1);
      if (notDeleted.length > 0) {
        anomalies.push(
          `merge 表引用的无 Profile 锚点中存在 deleted≠1: ${notDeleted.map((a) => a.id).join(", ")}`,
        );
      }
    }

    const tombstoneCandidates = candidates.filter((a) => num(a.deleted) === 1);
    console.log(`  候选锚点: ${tombstoneCandidates.length} 个`);
    if (tombstoneCandidates.length > 0 && !lifecycleColumnsReady) {
      console.error(
        `❌ ${PROFILE_TABLE} 生命周期列（${PROFILE_LIFECYCLE_COLUMNS.join("/")}）缺失；` +
          `请先以 Phase C expand schema 执行 prisma db push 再跑本脚本`,
      );
      return 1;
    }

    // ── 2. 逐锚点构建墓碑计划 ──
    // owner 回退：第一个 ADMIN 用户
    let fallbackOwnerId: string | null = null;
    const adminRows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id FROM ${qi(USER_TABLE)} WHERE role = 'ADMIN' ORDER BY "createdAt" ASC LIMIT 1`,
    );
    fallbackOwnerId = adminRows[0]?.id ?? null;

    const plans: TombstonePlan[] = [];
    const usedCodes = new Set<string>();
    for (const anchor of tombstoneCandidates) {
      // 最近一次 merge log：优先作为 source 的日志，其次作为 target 的日志
      let snapshotSource: TombstonePlan["snapshotSource"] = "none";
      let log: MergeLogRow | null = null;
      if (mergeLogExists) {
        const asSource = await prisma.$queryRawUnsafe<MergeLogRow[]>(
          `SELECT id, "operatorId", "createdAt",
                  "sourceSnapshotJson" AS legacySnapshotJson,
                  "sourceProfileSnapshotJson" AS profileSnapshotJson
           FROM ${qi(MERGE_LOG_TABLE)}
           WHERE "sourceCustomerId" = '${anchor.id.replaceAll("'", "''")}'
           ORDER BY "createdAt" DESC LIMIT 1`,
        );
        if (asSource.length > 0) {
          log = asSource[0]!;
          snapshotSource = "merge-log-source";
        } else {
          const asTarget = await prisma.$queryRawUnsafe<MergeLogRow[]>(
            `SELECT id, "operatorId", "createdAt",
                    "targetSnapshotJson" AS legacySnapshotJson,
                    "targetProfileSnapshotJson" AS profileSnapshotJson
             FROM ${qi(MERGE_LOG_TABLE)}
             WHERE "targetCustomerId" = '${anchor.id.replaceAll("'", "''")}'
             ORDER BY "createdAt" DESC LIMIT 1`,
          );
          if (asTarget.length > 0) {
            log = asTarget[0]!;
            snapshotSource = "merge-log-target";
          }
        }
      }

      // 快照：优先 Profile 权威快照，回退 legacy Customer 快照
      const emptyFields = Object.fromEntries(
        SNAPSHOT_BUSINESS_FIELDS.map((f) => [f, null]),
      ) as Record<SnapshotBusinessField, string | null>;
      let fields = emptyFields;
      let snapshotParseFailed = false;
      if (log) {
        const profileSnap = extractSnapshotFields(log.profileSnapshotJson);
        const legacySnap = extractSnapshotFields(log.legacySnapshotJson);
        snapshotParseFailed =
          (log.profileSnapshotJson != null && profileSnap.parseFailed) ||
          (log.profileSnapshotJson == null && legacySnap.parseFailed);
        fields = profileSnap.fields ?? legacySnap.fields ?? emptyFields;
      }

      // name：快照无 → 历史客户 <id>
      const name = fields.name ?? `历史客户 ${anchor.id}`;

      // customerCode：@unique，冲突则置 null 并计数
      let customerCodeCollision = false;
      let customerCode = fields.customerCode;
      if (customerCode) {
        if (usedCodes.has(customerCode)) {
          customerCodeCollision = true;
        } else {
          const taken = await countQuery(
            prisma,
            `SELECT COUNT(*) AS n FROM ${p} WHERE "customerCode" = '${customerCode.replaceAll("'", "''")}'`,
          );
          if (taken > 0) customerCodeCollision = true;
        }
        if (customerCodeCollision) {
          customerCode = null;
        } else {
          usedCodes.add(customerCode);
        }
      }

      // owner：merge log operatorId（须存在于 User），回退第一个 ADMIN
      let ownerUserId: string | null = null;
      let ownerFallback = false;
      if (log) {
        const operatorExists = await countQuery(
          prisma,
          `SELECT COUNT(*) AS n FROM ${qi(USER_TABLE)} WHERE id = '${log.operatorId.replaceAll("'", "''")}'`,
        );
        if (operatorExists > 0) ownerUserId = log.operatorId;
      }
      if (!ownerUserId) {
        ownerUserId = fallbackOwnerId;
        ownerFallback = true;
      }
      if (!ownerUserId) {
        anomalies.push(`锚点 ${anchor.id}: 无可用 owner（merge log operator 不存在且无 ADMIN 用户）`);
        continue;
      }

      // deletedAt：anchor.deletedAt → merge log createdAt → now
      const deletedAt = numOrNull(anchor.deletedAt) ?? (log ? num(log.createdAt) : Date.now());

      plans.push({
        anchorId: anchor.id,
        newProfileId: createId(),
        name,
        fields: { ...fields, customerCode },
        customerCodeCollision,
        ownerUserId,
        ownerFallback,
        deletedAt,
        mergedIntoProfileId: null, // 下方统一解析
        mergedIntoUnmapped: false,
        snapshotSource,
        snapshotParseFailed,
      });
    }

    // mergedIntoProfileId 解析：既有 Profile 映射 → 本次新建墓碑 → null（计数）
    const tombstoneIdByAnchor = new Map(plans.map((pl) => [pl.anchorId, pl.newProfileId]));
    let mergedIntoUnmappedCount = 0;
    let customerCodeCollisionCount = 0;
    let snapshotParseFailedCount = 0;
    for (const pl of plans) {
      const anchor = tombstoneCandidates.find((a) => a.id === pl.anchorId)!;
      if (anchor.mergedIntoId) {
        const mapped = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
          `SELECT id FROM ${p} WHERE ${src} = '${anchor.mergedIntoId.replaceAll("'", "''")}' LIMIT 1`,
        );
        pl.mergedIntoProfileId =
          mapped[0]?.id ?? tombstoneIdByAnchor.get(anchor.mergedIntoId) ?? null;
        if (!pl.mergedIntoProfileId) {
          pl.mergedIntoUnmapped = true;
          mergedIntoUnmappedCount++;
        }
      }
      if (pl.customerCodeCollision) customerCodeCollisionCount++;
      if (pl.snapshotParseFailed) snapshotParseFailedCount++;
    }

    console.log(`\n── 墓碑创建清单（${plans.length}）──`);
    for (const pl of plans) {
      console.log(
        `  ${pl.anchorId} → ${pl.newProfileId}  name=${pl.name}  code=${pl.fields.customerCode ?? "-"}  ` +
          `owner=${pl.ownerUserId}${pl.ownerFallback ? "(回退ADMIN)" : ""}  deletedAt=${pl.deletedAt}  ` +
          `mergedInto=${pl.mergedIntoProfileId ?? "null"}  快照=${pl.snapshotSource}`,
      );
    }
    if (mergedIntoUnmappedCount > 0) {
      console.log(`  ⚠️ ${mergedIntoUnmappedCount} 个锚点 mergedIntoId 目标无 Profile，mergedIntoProfileId 置 null`);
    }
    if (customerCodeCollisionCount > 0) {
      console.log(`  ⚠️ ${customerCodeCollisionCount} 个快照 customerCode 与既有 Profile 冲突，已置 null`);
    }
    if (snapshotParseFailedCount > 0) {
      console.log(`  ⚠️ ${snapshotParseFailedCount} 个快照 JSON 解析失败，按无快照处理（name=历史客户 <id>）`);
    }

    // ── 3. 陈旧绑定任务（customerId 无 Profile 映射，按处置前状态判定）──
    console.log("\n── 3. 陈旧绑定任务删除候选 ──");
    let bindingTasksToDelete: Array<Record<string, unknown>> = [];
    const bindingTaskExists = await tableExists(prisma, BINDING_TASK_TABLE);
    if (!bindingTaskExists) {
      console.log(`  ℹ️ ${BINDING_TASK_TABLE} 表不存在，跳过`);
    } else {
      const bindingCols = await tableColumns(prisma, BINDING_TASK_TABLE);
      if (!bindingCols.has("customerId")) {
        console.log(`  ℹ️ ${BINDING_TASK_TABLE}.customerId 已删除（contract 已完成），跳过`);
      } else {
        bindingTasksToDelete = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
          `SELECT t.* FROM ${qi(BINDING_TASK_TABLE)} t
           WHERE NOT EXISTS (SELECT 1 FROM ${p} pp WHERE pp.${src} = t."customerId")
           ORDER BY t.id`,
        );
        console.log(`  候选任务: ${bindingTasksToDelete.length} 行`);
        const byStatus = new Map<string, number>();
        for (const t of bindingTasksToDelete) {
          const status = String(t.status ?? "-");
          byStatus.set(status, (byStatus.get(status) ?? 0) + 1);
        }
        for (const [status, n] of [...byStatus.entries()].sort()) {
          console.log(`    status=${status}: ${n} 行`);
        }
      }
    }

    // ── 汇总（dry-run 到此为止）──
    console.log("\n── 汇总 ──");
    console.log(`  墓碑 Profile 待创建: ${plans.length}`);
    console.log(`  绑定任务待删除: ${bindingTasksToDelete.length}`);
    if (anomalies.length > 0) {
      console.error(`\n❌ 异常 ${anomalies.length} 项:`);
      for (const a of anomalies) console.error(`  - ${a}`);
      return 1;
    }

    if (!args.apply) {
      console.log("\nDRY-RUN：未写库、未导出文件。加 --apply 执行（先导出 JSON，再单事务落库）。");
      return 0;
    }

    // ── 4. 导出绑定任务完整行 ──
    let exportPath: string | null = null;
    if (bindingTasksToDelete.length > 0) {
      fs.mkdirSync(EXPORT_DIR, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      exportPath = path.join(EXPORT_DIR, `org-binding-tasks-deleted-anchor-${ts}.json`);
      fs.writeFileSync(
        exportPath,
        JSON.stringify(
          {
            exportedAt: new Date().toISOString(),
            database: args.dbPath,
            reason: "Phase E data disposition: CustomerOrgBindingTask.customerId 无 Profile 映射（W6.7c 既定政策删除）",
            rowCount: bindingTasksToDelete.length,
            rows: bindingTasksToDelete,
          },
          (_, v) => (typeof v === "bigint" ? Number(v) : v),
          2,
        ),
      );
      console.log(`\n── 4. 已导出 ${bindingTasksToDelete.length} 行绑定任务 → ${exportPath}`);
    } else {
      console.log("\n── 4. 无绑定任务需要导出");
    }

    // ── 5. 单事务执行：先 DELETE 绑定任务（按处置前状态判定目标集），再 INSERT 墓碑 ──
    console.log("\n── 5. 单事务执行 ──");
    const now = Date.now();
    const txResult = await prisma.$transaction(
      async (tx) => {
        let deletedTasks = 0;
        if (bindingTasksToDelete.length > 0) {
          deletedTasks = num(
            await tx.$executeRawUnsafe(
              // SQLite 的 DELETE 目标表别名必须带 AS（裸别名会 syntax error）
              `DELETE FROM ${qi(BINDING_TASK_TABLE)} AS t
               WHERE NOT EXISTS (SELECT 1 FROM ${p} pp WHERE pp.${src} = t."customerId")`,
            ),
          );
        }
        let inserted = 0;
        for (const pl of plans) {
          // 幂等守卫：并发/重跑时已存在映射则跳过
          const exists = await tx.$queryRawUnsafe<Array<{ id: string }>>(
            `SELECT id FROM ${p} WHERE ${src} = '${pl.anchorId.replaceAll("'", "''")}' LIMIT 1`,
          );
          if (exists.length > 0) continue;
          const f = pl.fields;
          await tx.$executeRawUnsafe(
            `INSERT INTO ${p} (
               "id", ${src}, "ownerUserId",
               "deleted", "deletedAt", "mergedIntoProfileId",
               "name", "customerCode", "nameDisambiguator", "principal", "labOrGroup",
               "phone", "wechat", "email", "miniProgramId",
               "address", "addressNote", "receiverPhone", "receiverAddress",
               "organization", "organizationId", "organizationSiteId", "organizationRawInput",
               "stage", "importance", "assignmentStatus", "archived",
               "createdAt", "updatedAt"
             ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'LEAD', 'NORMAL', 'UNASSIGNED', 0, ?, ?)`,
            pl.newProfileId,
            pl.anchorId,
            pl.ownerUserId,
            pl.deletedAt,
            pl.mergedIntoProfileId,
            pl.name,
            f.customerCode,
            f.nameDisambiguator,
            f.principal,
            f.labOrGroup,
            f.phone,
            f.wechat,
            f.email,
            f.miniProgramId,
            f.address,
            f.addressNote,
            f.receiverPhone,
            f.receiverAddress,
            f.organization,
            f.organizationId,
            f.organizationSiteId,
            f.organizationRawInput,
            now,
            now,
          );
          inserted++;
        }
        return { deletedTasks, inserted };
      },
      { timeout: 60000, maxWait: 10000 },
    );
    console.log(`  绑定任务已删除: ${txResult.deletedTasks} 行`);
    console.log(`  墓碑 Profile 已创建: ${txResult.inserted} 个`);
    if (txResult.deletedTasks !== bindingTasksToDelete.length) {
      console.error(
        `❌ 删除行数（${txResult.deletedTasks}）与计划（${bindingTasksToDelete.length}）不一致，疑似并发写入`,
      );
      return 1;
    }
    if (txResult.inserted !== plans.length) {
      console.error(`❌ 墓碑创建数（${txResult.inserted}）与计划（${plans.length}）不一致`);
      return 1;
    }

    console.log("\n✅ APPLY 完成（幂等；二次执行应为 0 删除 / 0 创建）");
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

/**
 * CrmProfileDepartmentState 存量回填（设计 §4.4 / §9.2）。
 *
 * 对每个 CrmCustomerProfile 确保存在恰好两行部门 state：
 *   - FIELD_SALES：从旧 profile 字段映射（ASSIGNED→CLAIMED；RECALL_CANDIDATE 保留 owner；
 *     RECALLED→POOL+RELEASED+releasedAt=recalledAt；UNASSIGNED/无 owner→隐藏 POOL）。
 *   - ONLINE_OPS：隐藏 POOL（poolEntryReason=null），不创建任何 CrmProfilePoolShare。
 *
 * 幂等：已有 state 不覆盖、不重复创建。dry-run（默认）只报告不写库。
 *
 * 用法：
 *   npx tsx scripts/backfill-department-states.ts [--db <path>]            # dry-run（默认，不写库）
 *   npx tsx scripts/backfill-department-states.ts [--db <path>] --apply    # 写库
 *   npx tsx scripts/backfill-department-states.ts --dry-run                # 显式 dry-run
 *
 * 退出码：apply 后缺 state 的 profile 数不为 0 → 1；否则 0（异常计数只报告不阻断）。
 */

import path from "node:path";

function printUsage(): void {
  console.log(
    [
      "Usage:",
      "  npx tsx scripts/backfill-department-states.ts [--db <path>] [--dry-run]  # dry-run（默认）",
      "  npx tsx scripts/backfill-department-states.ts [--db <path>] --apply      # 写库",
    ].join("\n"),
  );
}

function resolveDbPath(dbArg: string | null): string {
  if (dbArg) return path.resolve(process.cwd(), dbArg);
  const raw = process.env.DATABASE_URL?.trim();
  if (raw?.startsWith("file:")) {
    const withoutQuery = raw.slice("file:".length).split("?")[0] ?? "";
    if (withoutQuery) {
      return path.isAbsolute(withoutQuery)
        ? withoutQuery
        : path.resolve(process.cwd(), "prisma", withoutQuery);
    }
  }
  return path.resolve(process.cwd(), "prisma/dev.db");
}

function parseArgs(argv: string[]): { dbPath: string; apply: boolean } {
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
    if (arg === "--dry-run") {
      apply = false;
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

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  // 先设置 DATABASE_URL，再动态 import prisma 客户端（仓库脚本惯例）
  process.env.DATABASE_URL = `file:${args.dbPath}`;
  const { prisma } = await import("../src/lib/prisma");
  const { backfillDepartmentStates } = await import("./lib/department-states");

  try {
    console.log(`=== CrmProfileDepartmentState 回填（${args.apply ? "APPLY" : "DRY-RUN"}）===`);
    console.log(`Database: ${args.dbPath}`);

    const stats = await backfillDepartmentStates(prisma, { apply: args.apply });

    console.log(`\n扫描 profile 数:            ${stats.profilesScanned}`);
    console.log(`${args.apply ? "创建" : "计划创建"} FIELD_SALES state: ${stats.statesCreatedFieldSales}`);
    console.log(`${args.apply ? "创建" : "计划创建"} ONLINE_OPS state:  ${stats.statesCreatedOnlineOps}`);
    console.log(`跳过（已存在，不覆盖）:      ${stats.statesSkippedExisting}`);

    if (stats.plannedCreates.length > 0 && !args.apply) {
      console.log(`\n[dry-run] 计划创建明细（最多 20 条）:`);
      for (const plan of stats.plannedCreates.slice(0, 20)) {
        console.log(
          `  profile=${plan.profileId} dept=${plan.department} claimStatus=${plan.claimStatus}` +
            ` owner=${plan.ownerUserId ?? "-"} poolEntryReason=${plan.poolEntryReason ?? "-"}`,
        );
      }
    }

    console.log(`\n异常计数: ${stats.anomalies.length}`);
    const byKind = new Map<string, number>();
    for (const a of stats.anomalies) byKind.set(a.kind, (byKind.get(a.kind) ?? 0) + 1);
    for (const [kind, count] of byKind) console.log(`  ${kind}: ${count}`);
    for (const a of stats.anomalies.slice(0, 20)) {
      console.log(`  profile=${a.profileId} dept=${a.department} [${a.kind}] ${a.detail}`);
    }

    if (args.apply) {
      console.log(`\n[verify] apply 后缺 state 的 profile 数: ${stats.missingStateProfilesAfterApply}`);
      if (stats.missingStateProfilesAfterApply !== 0) {
        console.error("❌ 终态校验失败：仍存在缺 state 的 profile");
        return 1;
      }
      console.log("✅ 终态校验通过：每个 profile 恰好两行 state");
    } else {
      console.log(`\n[dry-run] 未写库。加 --apply 执行写入。`);
    }
    return 0;
  } finally {
    await prisma.$disconnect();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

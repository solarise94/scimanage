/**
 * 部门一致性扫描（设计 §12.3，上线前后运行）。只读，不写库。
 *
 * 扫描项：非法 department 值 / 必填 snapshot 空值 / Project↔Order 部门不一致 /
 * Invoice/Contract 跨部门覆盖 / Receipt 与 Payment allocation 部门不一致 /
 * profile 部门 state 完整性 / DepartmentState owner 与公海不变量 /
 * ACTIVE PoolShare 合法性 / Follow-up owner 部门一致性。
 *
 * 用法：
 *   npx tsx scripts/scan-department-consistency.ts [--db <path>]
 *
 * 退出码：全部计数为 0 → 0；任一非 0 → 1。
 */

import path from "node:path";

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

function parseArgs(argv: string[]): { dbPath: string } {
  let dbArg: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--db") {
      dbArg = argv[i + 1] ?? null;
      i++;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log("Usage: npx tsx scripts/scan-department-consistency.ts [--db <path>]");
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (dbArg === "") throw new Error("--db requires a non-empty path");
  return { dbPath: resolveDbPath(dbArg) };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  // 先设置 DATABASE_URL，再动态 import prisma 客户端（仓库脚本惯例）
  process.env.DATABASE_URL = `file:${args.dbPath}`;
  const { prisma } = await import("../src/lib/prisma");
  const { scanDepartmentConsistency } = await import("./lib/department-states");

  try {
    console.log(`=== 部门一致性扫描（§12.3，只读）===`);
    console.log(`Database: ${args.dbPath}\n`);

    const report = await scanDepartmentConsistency(prisma);

    const keyWidth = Math.max(...report.items.map((i) => i.key.length));
    console.log(`${"key".padEnd(keyWidth)}  count  label`);
    console.log(`${"-".repeat(keyWidth)}  -----  -----`);
    for (const item of report.items) {
      const mark = item.count === 0 ? " " : "!";
      console.log(`${item.key.padEnd(keyWidth)}  ${String(item.count).padStart(5)}  ${mark} ${item.label}`);
      for (const sample of item.samples) {
        console.log(`${"".padEnd(keyWidth)}         sample: ${sample}`);
      }
    }

    const bad = report.items.filter((i) => i.count > 0);
    console.log("");
    if (bad.length === 0) {
      console.log("✅ 全部扫描项计数为 0");
      return 0;
    }
    console.error(`❌ ${bad.length} 个扫描项存在异常计数（见上表，sample 为记录 id）`);
    return 1;
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

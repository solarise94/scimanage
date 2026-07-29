/**
 * Phase E：technical-owner 治理队列回填（上线前数据治理）。
 *
 * - Order：technicalOwnerUserId=null → 全部进 PENDING（无可靠历史字段，不自动回填）。
 * - Project：仅 techSupport 精确唯一匹配内部员工 User.name 时 RESOLVED_AUTO；否则 PENDING。
 *
 * Usage:
 *   npx tsx scripts/backfill-technical-owner-governance.ts --dry-run
 *   npx tsx scripts/backfill-technical-owner-governance.ts --apply
 *
 * ⚠️ 必须指向目标环境 DATABASE_URL（dev / demo / prod 串行，严禁并行）。
 * Agent 写对 owner=null 的资源 fail-closed；回填后 ADMIN 在 UI
 * `/api/orders/ownership-governance` 手工指派。
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const apply = process.argv.includes("--apply");
  const dryRun = process.argv.includes("--dry-run") || !apply;

  if (!apply && !process.argv.includes("--dry-run")) {
    console.log("Usage: npx tsx scripts/backfill-technical-owner-governance.ts --dry-run | --apply");
    console.log("Defaulting to --dry-run (no writes).\n");
  }

  const nullOrders = await prisma.order.count({
    where: { technicalOwnerUserId: null, deleted: false },
  });
  const nullProjects = await prisma.project.count({
    where: { technicalOwnerUserId: null, deleted: false },
  });
  const pendingTasks = await prisma.technicalOwnerGovernanceTask.count({
    where: { status: "PENDING" },
  });

  console.log("=== technical-owner governance precheck ===");
  console.log(`Order  technicalOwnerUserId=null : ${nullOrders}`);
  console.log(`Project technicalOwnerUserId=null: ${nullProjects}`);
  console.log(`Existing PENDING governance tasks: ${pendingTasks}`);

  if (dryRun) {
    console.log("\n--dry-run：未写入。确认后加 --apply。");
    return;
  }

  // 动态 import application service（与生产路径一致；避免脚本复制回填规则）。
  const {
    backfillOrderGovernanceTasks,
    backfillProjectGovernanceTasks,
  } = await import("../src/lib/orders/application/technical-owner-governance");

  console.log("\n=== applying Project backfill (exact-unique name only) ===");
  const projectResult = await backfillProjectGovernanceTasks();
  console.log(JSON.stringify(projectResult, null, 2));

  console.log("\n=== applying Order governance enqueue (all null → PENDING) ===");
  const orderResult = await backfillOrderGovernanceTasks();
  console.log(JSON.stringify(orderResult, null, 2));

  const pendingAfter = await prisma.technicalOwnerGovernanceTask.count({
    where: { status: "PENDING" },
  });
  console.log(`\nPENDING tasks after apply: ${pendingAfter}`);
  console.log("Next: ADMIN UI GET/POST /api/orders/ownership-governance 手工指派。");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

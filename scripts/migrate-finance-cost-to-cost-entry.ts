/**
 * Phase 4 迁移运行脚本：FinanceCost → CostEntry。
 *
 * 用法：npx tsx scripts/migrate-finance-cost-to-cost-entry.ts
 *
 * ⚠️ 此脚本只在停服迁移窗口内运行。
 * 运行后请立即部署新代码（迁移后旧 FinanceCost 读路径会与新 CostEntry 并行）。
 *
 * 环境顺序：dev → demo → prod。一个环境完整通过（含双轨核对）再动下一个。
 *
 * 注意：此脚本不创建任何用户账号、不触碰凭据。
 * actorUserId 使用系统中第一个 ADMIN 用户（迁移操作者）。
 */
import { prisma } from "@/lib/prisma";
import { migrateFinanceCostToCostEntry } from "@/lib/costing/migrate-from-finance-cost";

async function main() {
  console.log("=== Phase 4: FinanceCost → CostEntry 迁移 ===\n");

  // 找到操作者（第一个 ADMIN）
  const admin = await prisma.user.findFirst({
    where: { role: "ADMIN" },
    select: { id: true, email: true },
  });
  if (!admin) {
    console.error("未找到 ADMIN 用户，无法执行迁移。");
    process.exit(1);
  }
  console.log(`迁移操作者：${admin.email} (${admin.id})\n`);

  const result = await migrateFinanceCostToCostEntry(admin.id);

  console.log("\n=== 迁移结果 ===");
  console.log(`FinanceCost 总数：${result.total}`);
  console.log(`成功迁移：${result.migrated}`);
  console.log(`修正归属（旧版迁移记录 subjectType 校正）：${result.reconciled}`);
  console.log(`幂等跳过（已正确，无需变更）：${result.skipped}`);
  console.log(`失败：${result.errors}`);
  console.log(`重算快照数：${result.recomputedSnapshots}`);

  if (result.errors > 0) {
    console.log("\n⚠️ 有迁移失败记录，请检查上方错误日志。");
    process.exit(1);
  }

  console.log("\n✓ 迁移完成。请运行双轨核对确认差异为 0：");
  console.log("  curl -H 'Cookie: ...' http://localhost:PORT/api/costing/dual-track");
}

main()
  .catch((e) => {
    console.error("迁移失败:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

/**
 * 存量 Order.buyerOrganizationId 回填脚本（profile 主权）。
 *
 * 用法（DATABASE_URL 需用绝对路径，相对路径会导致 SQLite 无法打开）：
 *   # dry-run
 *   DATABASE_URL="file:$(pwd)/prisma/dev.db" npx tsx scripts/backfill-order-buyer-organization.ts
 *
 *   # 实际写入（遇异常禁写全部）
 *   WRITE=1 DATABASE_URL="file:$(pwd)/prisma/dev.db" npx tsx scripts/backfill-order-buyer-organization.ts
 *
 *   # 只写安全 plans，跳过异常条目（invalidProfileOrg / hasFinance 仍单独列出）
 *   WRITE=1 ALLOW_PARTIAL=1 DATABASE_URL="file:$(pwd)/prisma/dev.db" npx tsx scripts/backfill-order-buyer-organization.ts
 *
 * 规则（与治理接口 /api/admin/governance/backfill-order-buyer-org 共享 src/lib/orders/buyer-org-backfill.ts）：
 *   - org 来源 = order.profile.organizationId（profile 主权，不 fallback Customer 旧列）。
 *   - 机构必须存在、未删除、未归档。
 *   - 有发票/回款等财务关联的订单单独列出（hasFinance），不自动写入。
 *   - 默认遇异常禁写全部；ALLOW_PARTIAL=1 才允许只写安全 plans。
 */
import { PrismaClient } from "@prisma/client";
import { executeBackfill } from "../src/lib/orders/buyer-org-backfill";

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("[backfill-order-buyer-org] 必须设置 DATABASE_URL");
    process.exit(2);
  }
  const WRITE = process.env.WRITE === "1";
  const ALLOW_PARTIAL = process.env.ALLOW_PARTIAL === "1";
  console.log(`[backfill-order-buyer-org] mode=${WRITE ? "WRITE" : "DRY-RUN"} allowPartial=${ALLOW_PARTIAL} db=${dbUrl}`);

  const prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });

  try {
    const result = await executeBackfill(prisma, { dryRun: !WRITE, allowPartial: ALLOW_PARTIAL });

    console.log(
      `[backfill-order-buyer-org] scanned=${result.scanned} plans=${result.plans.length} ` +
      `skippedNoProfileOrg=${result.skippedNoProfileOrg.length} ` +
      `invalidProfileOrg=${result.invalidProfileOrg.length} ` +
      `hasFinance=${result.hasFinance.length}` +
      (WRITE ? ` updated=${result.updated}` : ""),
    );

    const printSection = (label: string, items: Array<{ orderId: string; orderNo: string; reason?: string }>, limit = 50) => {
      if (items.length === 0) return;
      console.log(`[backfill-order-buyer-org] ${label} (${items.length}):`);
      for (const a of items.slice(0, limit)) {
        console.log(`  - ${a.orderNo}(${a.orderId}): ${a.reason ?? ""}`);
      }
      if (items.length > limit) console.log(`  ... and ${items.length - limit} more`);
    };

    printSection("invalidProfileOrg（机构删除/归档/不存在）", result.invalidProfileOrg);
    printSection("hasFinance（有财务关联，需人工确认）", result.hasFinance);
    printSection("skippedNoProfileOrg（profile 无机构或客户异常）", result.skippedNoProfileOrg);

    if (!WRITE) {
      console.log("[backfill-order-buyer-org] dry-run 完成。如需写入，请加 WRITE=1 重新运行。");
    } else if (result.updated === 0 && result.plans.length > 0) {
      console.error("[backfill-order-buyer-org] 存在异常数据，已禁写。请先处理 invalidProfileOrg/hasFinance，或加 ALLOW_PARTIAL=1 只写安全 plans。");
      process.exit(1);
    } else {
      console.log(`[backfill-order-buyer-org] 写入完成 updated=${result.updated}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

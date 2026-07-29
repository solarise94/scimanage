/**
 * 清理 CONTRACT_LEDGER 来源订单及其关联数据（重建前使用）。
 *
 * 用法：
 *   npx tsx scripts/clean-contract-ledger-orders.ts            # 预览将删除的行数（--dry-run）
 *   npx tsx scripts/clean-contract-ledger-orders.ts --apply     # 实际执行删除
 *
 * 按依赖逆序删除（外键约束），Project 不删（projectNo 可能被其它来源引用，
 * 重建时 upsert 会覆盖）。见 docs/history-orders-import-design.md §4.2。
 *
 * 注意：此脚本直接操作数据库，无需认证。请在停服窗口执行，执行前务必备份数据库。
 */
import { prisma } from "../src/lib/prisma";

async function main() {
  const apply = process.argv.includes("--apply");
  console.log(`[clean-contract-ledger] 模式: ${apply ? "APPLY（实际删除）" : "DRY-RUN（预览）"}`);

  // 1. 找出所有 CONTRACT_LEDGER 订单 ID
  const sourceRecords = await prisma.orderSourceRecord.findMany({
    where: { source: "CONTRACT_LEDGER" },
    select: { orderId: true },
  });
  const orderIds = [...new Set(sourceRecords.map((r) => r.orderId).filter((id): id is string => !!id))];
  console.log(`  目标订单数（source=CONTRACT_LEDGER）: ${orderIds.length}`);

  if (orderIds.length === 0) {
    console.log("  无 CONTRACT_LEDGER 订单，无需清理。");
    return;
  }

  // 2. 统计各关联表将删除的行数
  const [
    refunds,
    receipts,
    commissions,
    costs,
    invoiceReqs,
    attachments,
    projectLinks,
    orderLines,
    statusHistory,
  ] = await Promise.all([
    prisma.financeAdvanceRefund.count({
      where: { settledByReceipt: { orderId: { in: orderIds } } },
    }),
    prisma.financeReceipt.count({ where: { orderId: { in: orderIds } } }),
    prisma.financeCommission.count({ where: { orderId: { in: orderIds } } }),
    prisma.financeCost.count({ where: { orderId: { in: orderIds } } }),
    prisma.externalOrderInvoiceRequest.count({ where: { orderId: { in: orderIds } } }),
    prisma.contractAttachment.count({ where: { orderId: { in: orderIds } } }),
    prisma.orderProjectLink.count({ where: { orderId: { in: orderIds } } }),
    prisma.orderLine.count({ where: { orderId: { in: orderIds } } }),
    prisma.orderStatusHistory.count({ where: { orderId: { in: orderIds } } }),
  ]);

  console.log("  将删除的关联数据行数：");
  console.log(`    FinanceAdvanceRefund : ${refunds}`);
  console.log(`    FinanceReceipt       : ${receipts}`);
  console.log(`    FinanceCommission    : ${commissions}`);
  console.log(`    FinanceCost          : ${costs}`);
  console.log(`    InvoiceRequest       : ${invoiceReqs}`);
  console.log(`    ContractAttachment   : ${attachments}`);
  console.log(`    OrderProjectLink     : ${projectLinks}`);
  console.log(`    OrderLine            : ${orderLines}`);
  console.log(`    OrderStatusHistory   : ${statusHistory}`);
  console.log(`    OrderSourceRecord    : ${sourceRecords.length}`);
  console.log(`    Order                : ${orderIds.length}`);

  // 3. 还原受影响 advance 的状态（删除 refund 后需重算 HELD/PARTIAL_REFUNDED/REFUNDED）
  const affectedAdvances = await prisma.financeAdvanceRefund.findMany({
    where: { settledByReceipt: { orderId: { in: orderIds } } },
    select: { advanceId: true },
    distinct: ["advanceId"],
  });
  const affectedAdvanceIds = affectedAdvances.map((a) => a.advanceId);
  console.log(`    受影响 Advance（需重算状态）: ${affectedAdvanceIds.length}`);

  if (!apply) {
    console.log("\n  [DRY-RUN] 未实际删除。加 --apply 执行。");
    return;
  }

  // 4. 按依赖逆序实际删除
  console.log("\n  [APPLY] 开始删除...");
  await prisma.financeAdvanceRefund.deleteMany({
    where: { settledByReceipt: { orderId: { in: orderIds } } },
  });
  await prisma.financeReceipt.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.financeCommission.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.financeCost.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.externalOrderInvoiceRequest.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.contractAttachment.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.orderProjectLink.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.orderLine.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.orderStatusHistory.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.orderSourceRecord.deleteMany({ where: { source: "CONTRACT_LEDGER" } });
  await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  console.log("  订单及关联数据已删除。");

  // 5. 重算受影响 advance 的状态
  for (const advId of affectedAdvanceIds) {
    const adv = await prisma.financeAdvance.findUnique({
      where: { id: advId },
      select: { amount: true, refunds: { select: { amount: true } } },
    });
    if (!adv) continue;
    const stillRefunded = adv.refunds.reduce((s, r) => s + r.amount, 0);
    const status =
      stillRefunded <= 0
        ? "HELD"
        : stillRefunded >= adv.amount
          ? "REFUNDED"
          : "PARTIAL_REFUNDED";
    await prisma.financeAdvance.update({ where: { id: advId }, data: { status } });
  }
  console.log(`  ${affectedAdvanceIds.length} 条 advance 状态已重算。`);

  // 6. Project 不删。统计孤立 Project（无关联订单）供人工参考
  const orphanProjects = await prisma.project.count({
    where: { orderLinks: { none: {} } },
  });
  console.log(`  [提示] 孤立 Project（无关联订单）: ${orphanProjects}（未删除，重建时 upsert 覆盖）`);

  console.log("\n  [完成] CONTRACT_LEDGER 清理完毕。");
}

main()
  .catch((e) => {
    console.error("[ERROR]", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

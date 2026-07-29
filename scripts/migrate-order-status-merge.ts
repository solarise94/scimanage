/**
 * 订单状态合并迁移：把 deliveryStatus 合进 status（四态单状态机）。
 *
 * 见 docs/orders-ui-review-round3.md §1.4 / §五 批次2。
 * 映射：
 *   status=CANCELLED                              → CLOSED（吸收取消）
 *   deliveryStatus=DELIVERED 且 status∈{DRAFT,CONFIRMED} → DELIVERED（已交付）
 *   其余保持不变（DRAFT/CONFIRMED + 未交付；CLOSED 保持 CLOSED）
 *
 * ⚠️ 必须在 `prisma db push` 删除 deliveryStatus 列【之前】运行（此时列仍存在）。
 * 用 raw SQL，故不依赖已重新生成的 Prisma client。
 *
 * 流程（按 AGENTS.md 停服迁移规范）：停服 → 备份 .db → 跑本脚本 → prisma db push → 部署新代码 → 重启 → smoke。
 */
import { prisma } from "../src/lib/prisma";

async function dist(label: string) {
  const rows = await prisma.$queryRawUnsafe<Array<{ status: string; deliveryStatus: string | null; n: number }>>(
    `SELECT status, deliveryStatus, COUNT(*) as n FROM "Order" GROUP BY status, deliveryStatus ORDER BY status, deliveryStatus`,
  );
  console.log(`\n[${label}] status x deliveryStatus:`);
  for (const r of rows) console.log(`   ${r.status} + ${r.deliveryStatus ?? "—"} => ${Number(r.n)}`);
}

async function distByStatus(label: string) {
  const rows = await prisma.$queryRawUnsafe<Array<{ status: string; n: number }>>(
    `SELECT status, COUNT(*) as n FROM "Order" GROUP BY status ORDER BY status`,
  );
  console.log(`\n[${label}] status:`);
  for (const r of rows) console.log(`   ${r.status} => ${Number(r.n)}`);
}

async function main() {
  // 列是否存在（迁移幂等：列已删则跳过）
  const cols = await prisma.$queryRawUnsafe<Array<{ name: string }>>(`PRAGMA table_info("Order")`);
  const hasDelivery = cols.some((c) => c.name === "deliveryStatus");
  if (!hasDelivery) {
    console.log("deliveryStatus 列已不存在，迁移已完成或无需迁移，跳过。");
    await distByStatus("当前");
    return;
  }

  await dist("迁移前");

  const cancelled = await prisma.$executeRawUnsafe(`UPDATE "Order" SET status='CLOSED' WHERE status='CANCELLED'`);
  console.log(`\nCANCELLED → CLOSED: ${cancelled} 行`);

  const delivered = await prisma.$executeRawUnsafe(
    `UPDATE "Order" SET status='DELIVERED' WHERE deliveryStatus='DELIVERED' AND status IN ('DRAFT','CONFIRMED')`,
  );
  console.log(`deliveryStatus=DELIVERED & status∈{DRAFT,CONFIRMED} → DELIVERED: ${delivered} 行`);

  await dist("迁移后（删列前）");
  console.log("\n✅ 数据迁移完成。下一步：npx prisma db push（删除 deliveryStatus 列）。");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());

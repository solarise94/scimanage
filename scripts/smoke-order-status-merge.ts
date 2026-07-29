/**
 * 临时功能烟测：状态合并后 transition map / stats 口径 / 数据完整性 / 一次真实流转往返。
 * 跑完即可删除。
 */
import { prisma } from "../src/lib/prisma";
import { ORDER_STATUS_TRANSITIONS, ORDER_STATUS } from "../src/lib/orders/constants";
import { getOrderStatusActions } from "../src/components/orders/order-transition-controls";

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error("❌ " + msg); process.exitCode = 1; } else { console.log("✓ " + msg); }
}

async function main() {
  // 1. 四态枚举与 transition map
  assert(Object.keys(ORDER_STATUS).sort().join(",") === "CLOSED,CONFIRMED,DELIVERED,DRAFT", "ORDER_STATUS 为四态");
  assert(JSON.stringify(ORDER_STATUS_TRANSITIONS.CONFIRMED) === JSON.stringify(["DELIVERED", "CLOSED"]), "CONFIRMED→DELIVERED/CLOSED");
  assert(JSON.stringify(ORDER_STATUS_TRANSITIONS.DELIVERED) === JSON.stringify(["CLOSED"]), "DELIVERED→CLOSED");
  assert(JSON.stringify(ORDER_STATUS_TRANSITIONS.DRAFT) === JSON.stringify(["CONFIRMED", "CLOSED"]), "DRAFT→CONFIRMED/CLOSED");
  assert(JSON.stringify(ORDER_STATUS_TRANSITIONS.CLOSED) === JSON.stringify(["CONFIRMED"]), "CLOSED→CONFIRMED(重开)");

  // 2. getOrderStatusActions：CLOSED 动作需 needsReason
  const confActions = getOrderStatusActions("CONFIRMED");
  assert(confActions.some(a => a.to === "DELIVERED" && !a.needsReason), "CONFIRMED 含『标记已交付』无需原因");
  assert(confActions.some(a => a.to === "CLOSED" && a.needsReason), "CONFIRMED 含『关闭订单』需原因");

  // 3. 数据完整性：所有订单 status 在四态内，且无残留 PENDING 等
  const bad = await prisma.$queryRawUnsafe<Array<{ status: string; n: number }>>(
    `SELECT status, COUNT(*) n FROM "Order" WHERE status NOT IN ('DRAFT','CONFIRMED','DELIVERED','CLOSED') GROUP BY status`,
  );
  assert(bad.length === 0, `无非法 status（发现 ${bad.length} 类）`);

  // 4. stats confirmedWhere = status ∈ {CONFIRMED, DELIVERED} 能聚合（含原已交付订单）
  const confirmedAgg = await prisma.order.aggregate({
    where: { deleted: false, status: { in: ["CONFIRMED", "DELIVERED"] } },
    _sum: { totalAmount: true }, _count: { _all: true },
  });
  console.log(`  confirmed(含已交付) 订单数=${confirmedAgg._count._all} 金额(分)=${confirmedAgg._sum.totalAmount ?? 0}`);
  assert(confirmedAgg._count._all >= 1, "confirmedWhere 聚合到至少 1 单（含 DELIVERED）");

  // 5. 真实流转往返：取一个 CONFIRMED 单 → DELIVERED → 还原（不写 history，纯字段验证 transition 合法性）
  const sample = await prisma.order.findFirst({ where: { status: "CONFIRMED", deleted: false }, select: { id: true, status: true } });
  if (sample) {
    assert(ORDER_STATUS_TRANSITIONS[sample.status].includes("DELIVERED"), "样本 CONFIRMED 可转 DELIVERED");
    await prisma.order.update({ where: { id: sample.id }, data: { status: "DELIVERED" } });
    const after = await prisma.order.findUnique({ where: { id: sample.id }, select: { status: true } });
    assert(after?.status === "DELIVERED", "样本流转到 DELIVERED 成功");
    await prisma.order.update({ where: { id: sample.id }, data: { status: "CONFIRMED" } }); // 还原
    console.log("  样本已还原为 CONFIRMED");
  } else {
    console.log("  （无 CONFIRMED 样本可测流转，跳过）");
  }

  console.log("\n烟测完成。");
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());

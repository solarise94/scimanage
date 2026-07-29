/**
 * 将历史订单的展示字段 `Order.techSupport` 从已治理的技术负责人回填。
 *
 * 订单是技术支持的业务事实源；本脚本不读取或反推 Project.techSupport。
 * 仅补空值，已填写的订单不会被覆盖。有效订单若仍无可用负责人姓名，--apply
 * 会失败退出，避免以猜测值掩盖数据问题。
 *
 * 用法：
 *   DATABASE_URL='file:/path/dev.db' npx tsx scripts/backfill-order-tech-support.ts --dry-run
 *   DATABASE_URL='file:/path/dev.db' npx tsx scripts/backfill-order-tech-support.ts --apply
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function main() {
  const activeOrders = await prisma.order.findMany({
    where: { deleted: false },
    select: {
      id: true,
      techSupport: true,
      technicalOwner: { select: { name: true, email: true } },
    },
  });

  const toBackfill = activeOrders.filter((order) => {
    const existing = order.techSupport?.trim() ?? "";
    const ownerName = order.technicalOwner?.name?.trim() ?? "";
    return !existing && !!ownerName;
  });
  const unresolved = activeOrders.filter((order) => {
    const existing = order.techSupport?.trim() ?? "";
    const ownerName = order.technicalOwner?.name?.trim() ?? "";
    return !existing && !ownerName;
  });

  console.log(`[ORDER_TECH_SUPPORT] active=${activeOrders.length} backfill=${toBackfill.length} unresolved=${unresolved.length}`);
  if (!APPLY) {
    console.log("[ORDER_TECH_SUPPORT] dry-run only; pass --apply to write.");
    return;
  }
  if (unresolved.length > 0) {
    throw new Error(`有 ${unresolved.length} 个有效订单没有可用技术负责人，拒绝写入猜测值。`);
  }

  const idsByName = new Map<string, string[]>();
  for (const order of toBackfill) {
    const name = order.technicalOwner!.name!.trim();
    const ids = idsByName.get(name) ?? [];
    ids.push(order.id);
    idsByName.set(name, ids);
  }

  let updated = 0;
  for (const [name, ids] of idsByName) {
    for (const idBatch of chunk(ids, 200)) {
      const result = await prisma.order.updateMany({
        where: {
          id: { in: idBatch },
          deleted: false,
          OR: [{ techSupport: null }, { techSupport: "" }],
        },
        data: { techSupport: name },
      });
      updated += result.count;
    }
  }

  const remaining = await prisma.order.count({
    where: {
      deleted: false,
      OR: [{ techSupport: null }, { techSupport: "" }],
    },
  });
  if (remaining > 0) {
    throw new Error(`回填后仍有 ${remaining} 个有效订单缺少技术支持。`);
  }
  console.log(`[ORDER_TECH_SUPPORT] updated=${updated} remaining=${remaining}`);
}

main()
  .catch((error) => {
    console.error("[ORDER_TECH_SUPPORT] failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

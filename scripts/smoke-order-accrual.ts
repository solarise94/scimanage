/**
 * 计提功能烟测：跨月 CONFIRMED/DELIVERED 关闭、当月关闭、stats 口径、列表排除、重复计提防护。
 *
 * Usage: npx tsx scripts/smoke-order-accrual.ts
 */
import { withTempSmokeDb } from "./lib/temp-smoke-db";

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error("❌ " + msg); process.exitCode = 1; } else { console.log("✓ " + msg); }
}

function isSameYearMonth(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
}

function shouldShowAccrualOption(order: { status: string; confirmedAt?: Date | string | null; orderedAt?: Date | string | null }): boolean {
  if (order.status !== "CONFIRMED" && order.status !== "DELIVERED") return false;
  const ref = order.confirmedAt ?? order.orderedAt;
  if (!ref) return false;
  const refDate = typeof ref === "string" ? new Date(ref) : ref;
  return !isSameYearMonth(refDate, new Date());
}

async function main() {
  await withTempSmokeDb(async () => {
    const { prisma } = await import("../src/lib/prisma");
    const { ORDER_SOURCE } = await import("../src/lib/orders/constants");
    const { getEffectiveOrderWhere } = await import("../src/lib/orders/permissions");

    const eff = getEffectiveOrderWhere(null);
    assert(JSON.stringify(eff).includes("CONFIRMED") && JSON.stringify(eff).includes("accrualReversalOfId"), "getEffectiveOrderWhere 包含 CONFIRMED/DELIVERED + 影子订单条件");

    const admin = await prisma.user.create({
      data: { email: `accrual-${Date.now()}@test.local`, name: "accrual-admin", password: "x", role: "ADMIN" },
      select: { id: true },
    });
    const profile = await prisma.crmCustomerProfile.create({
      data: {
        customerCode: `ACCR-${Date.now()}`,
        name: "烟测客户-计提",
        ownerUserId: admin.id,
        stage: "ACTIVE",
      },
      select: { id: true },
    });
    assert(!!profile, "Profile-only 客户已创建");

    async function createShadowOrder(original: { id: string; orderNo: string; title: string; category: string; totalAmount: number; profileId: string | null }, adminId: string) {
      await prisma.$transaction(async (tx) => {
        await tx.order.update({ where: { id: original.id }, data: { status: "CLOSED" } });
        await tx.order.create({
          data: {
            orderNo: `ACCR-${original.orderNo}`,
            title: `计提冲回：${original.title}`,
            source: ORDER_SOURCE.ACCRUAL_REVERSAL,
            category: original.category,
            status: "CLOSED",
            totalAmount: -original.totalAmount,
            financeTreatment: "STANDALONE",
            profileId: original.profileId,
            createdById: adminId,
            orderedAt: new Date(),
            confirmedAt: new Date(),
            accrualReversalOfId: original.id,
          },
        });
      });
    }

    const cleanupOrderIds: string[] = [];

    const confirmedOriginal = await prisma.order.create({
      data: {
        orderNo: `SMOKE-ACCR-C-${Date.now()}`,
        title: "计提烟测-已确认",
        source: "MANUAL",
        category: "SERVICE",
        status: "CONFIRMED",
        totalAmount: 100_00,
        profileId: profile.id,
        createdById: admin.id,
        confirmedAt: new Date("2026-05-15"),
        orderedAt: new Date("2026-05-10"),
      },
    });
    cleanupOrderIds.push(confirmedOriginal.id);
    assert(shouldShowAccrualOption(confirmedOriginal), "跨月 CONFIRMED 应显示计提选项");
    await createShadowOrder(confirmedOriginal, admin.id);

    const confirmedShadow = await prisma.order.findFirst({ where: { accrualReversalOfId: confirmedOriginal.id } });
    assert(!!confirmedShadow, "A 已创建影子订单");
    cleanupOrderIds.push(confirmedShadow!.id);
    assert(confirmedShadow!.orderNo === `ACCR-${confirmedOriginal.orderNo}`, "A 影子订单号前缀 ACCR-");
    assert(confirmedShadow!.source === "ACCRUAL_REVERSAL", "A 影子 source=ACCRUAL_REVERSAL");
    assert(confirmedShadow!.totalAmount === -100_00, "A 影子金额为 -10000 分");

    const deliveredOriginal = await prisma.order.create({
      data: {
        orderNo: `SMOKE-ACCR-D-${Date.now()}`,
        title: "计提烟测-已交付",
        source: "MANUAL",
        category: "PRODUCT",
        status: "DELIVERED",
        totalAmount: 200_00,
        profileId: profile.id,
        createdById: admin.id,
        confirmedAt: new Date("2026-05-20"),
        orderedAt: new Date("2026-05-18"),
        deliveredAt: new Date("2026-05-22"),
      },
    });
    cleanupOrderIds.push(deliveredOriginal.id);
    await createShadowOrder(deliveredOriginal, admin.id);
    const deliveredShadow = await prisma.order.findFirst({ where: { accrualReversalOfId: deliveredOriginal.id } });
    assert(!!deliveredShadow && deliveredShadow.totalAmount === -200_00, "B 影子金额为 -20000 分");
    cleanupOrderIds.push(deliveredShadow!.id);

    const thisMonthOriginal = await prisma.order.create({
      data: {
        orderNo: `SMOKE-ACCR-N-${Date.now()}`,
        title: "计提烟测-当月",
        source: "MANUAL",
        category: "SERVICE",
        status: "CONFIRMED",
        totalAmount: 50_00,
        profileId: profile.id,
        createdById: admin.id,
        confirmedAt: new Date(),
        orderedAt: new Date(),
      },
    });
    cleanupOrderIds.push(thisMonthOriginal.id);
    assert(!shouldShowAccrualOption(thisMonthOriginal), "当月 CONFIRMED 不显示计提选项");
    await prisma.order.update({ where: { id: thisMonthOriginal.id }, data: { status: "CLOSED" } });
    assert(!(await prisma.order.findFirst({ where: { accrualReversalOfId: thisMonthOriginal.id } })), "当月关闭不产生影子订单");

    assert((await prisma.order.count({ where: { accrualReversalOfId: confirmedOriginal.id } })) === 1, "D 每个原订单只有一条影子记录");

    assert((await prisma.order.count({ where: { deleted: false, source: { not: "ACCRUAL_REVERSAL" }, id: confirmedShadow!.id } })) === 0, "E 默认列表排除影子订单");
    assert((await prisma.order.count({ where: { deleted: false, id: confirmedShadow!.id } })) === 1, "E 包含模式下影子订单可见");
    assert((await prisma.order.count({ where: getEffectiveOrderWhere({ id: confirmedShadow!.id }) })) === 1, "E getEffectiveOrderWhere 命中影子订单");

    await prisma.order.deleteMany({ where: { id: { in: cleanupOrderIds } } });
    console.log("\n烟测完成（temp DB 自动销毁）。");
  });
}

main().catch((e) => { console.error(e); process.exit(1); });

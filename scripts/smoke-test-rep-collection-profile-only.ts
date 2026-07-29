/**
 * Smoke: W5.2 代表 KPI 按 Profile-only 计算回款率 / 周期。
 *
 * Fixture：无 Customer 锚点的 Profile + 订单 + ISSUED 发票 + 回款分摊。
 * 断言 preloadRepresentativeCollectionData + buildRepresentativeCollectionMetrics
 * 在仅传 profileId 时得到非空的回款率与平均周期。
 *
 * 运行机制：withTempSmokeDb 临时库（严禁写 prisma/dev.db），业务模块在回调内动态 import。
 *
 * Usage: npx tsx scripts/smoke-test-rep-collection-profile-only.ts
 */

import { withTempSmokeDb } from "./lib/temp-smoke-db";

const PREFIX = `SMOKE-REPCOL-${Date.now().toString(36)}`;
let pass = 0;
let fail = 0;

function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`  ✅ ${msg}`);
    pass++;
  } else {
    console.log(`  ❌ ${msg}`);
    fail++;
  }
}

async function main() {
  await withTempSmokeDb(async () => {
    const { prisma } = await import("../src/lib/prisma");
    const {
      buildRepresentativeCollectionMetrics,
      preloadRepresentativeCollectionData,
      RECEIVABLE_BELOW_THRESHOLD_CENTS,
      MIN_CYCLE_PAIR_COUNT,
    } = await import("../src/lib/finance/collection-analysis");

    const admin = await prisma.user.create({
      data: {
        email: `${PREFIX}@test.local`,
        name: `${PREFIX} Admin`,
        password: "x",
        role: "ADMIN",
      },
      select: { id: true },
    });

    const org = await prisma.organization.create({
      data: {
        orgCode: `${PREFIX}-ORG`,
        canonicalName: `${PREFIX} 机构`,
        normalizedName: `${PREFIX}-org`,
        isInvoiceSubject: true,
        taxId: `${PREFIX}TAX`,
      },
    });

    const profile = await prisma.crmCustomerProfile.create({
      data: {
        customerCode: `${PREFIX}-P`,
        name: `${PREFIX} Profile-only`,
        organizationId: org.id,
        organization: org.canonicalName,
        ownerUserId: admin.id,
        stage: "ACTIVE",
        assignmentStatus: "ASSIGNED",
        assignedAt: new Date(),
      },
    });

    // 季度内产品订单：整额进应收，金额需高于回款阈值以免 rate 被压成 null
    const orderAmount = Math.max(RECEIVABLE_BELOW_THRESHOLD_CENTS + 100_000, 2_000_000);
    const orderedAt = new Date();
    const order = await prisma.order.create({
      data: {
        orderNo: `${PREFIX}-ORD`,
        title: `${PREFIX} 测试订单`,
        source: "MANUAL",
        category: "PRODUCT",
        status: "CONFIRMED",
        financeTreatment: "STANDALONE",
        totalAmount: orderAmount,
        profileId: profile.id,
        orderedAt,
        confirmedAt: orderedAt,
        createdById: admin.id,
      },
    });

    // MIN_CYCLE_PAIR_COUNT 条配对；开票/回款日期必须落在「季度至今」窗口内（periodEnd=今天），不能用未来日
    const pairCount = MIN_CYCLE_PAIR_COUNT;
    const invoices = [];
    const receipts = [];
    for (let i = 0; i < pairCount; i++) {
      const issuedAt = new Date(orderedAt.getTime() - (pairCount - i + 5) * 86_400_000);
      const receivedAt = new Date(issuedAt.getTime() + (i + 2) * 86_400_000);
      const partAmount = Math.floor(orderAmount / pairCount);

      const invoice = await prisma.externalOrderInvoiceRequest.create({
        data: {
          orderId: order.id,
          buyerOrganizationName: org.canonicalName,
          buyerOrganizationId: org.id,
          totalAmount: partAmount,
          status: "ISSUED",
          actualIssuedAt: issuedAt,
          createdById: admin.id,
        },
      });
      invoices.push(invoice);

      await prisma.orderInvoiceCoverage.create({
        data: {
          orderId: order.id,
          invoiceRequestId: invoice.id,
          amount: partAmount,
        },
      });

      const receipt = await prisma.financeReceipt.create({
        data: {
          amount: partAmount,
          receivedAt,
          profileId: profile.id,
          orderId: order.id,
          source: "MANUAL",
          createdById: admin.id,
        },
      });
      receipts.push(receipt);

      await prisma.financeReceiptAllocation.create({
        data: {
          receiptId: receipt.id,
          invoiceId: invoice.id,
          orderId: order.id,
          amount: partAmount,
          createdById: admin.id,
        },
      });
    }

    console.log("\n--- Profile-only 代表回款 KPI ---");
    const preload = await preloadRepresentativeCollectionData([profile.id]);
    const metrics = buildRepresentativeCollectionMetrics(
      [profile.id],
      preload.pairs,
      preload.quarterReceivableMap,
      preload.yearReceivableMap,
    );

    // fixture 为 Profile-only：创建时未写任何 Customer 锚点列（由 contract 扫描静态强制）
    assert(Boolean(profile.id), "fixture Profile 已创建（无 Customer 锚点）");
    assert(
      (preload.quarterReceivableMap.get(profile.id) || 0) > 0,
      `季度应收 > 0（got ${preload.quarterReceivableMap.get(profile.id) ?? 0}）`,
    );
    assert(
      metrics.collectionPairCount >= MIN_CYCLE_PAIR_COUNT,
      `collectionPairCount >= ${MIN_CYCLE_PAIR_COUNT}（got ${metrics.collectionPairCount}）`,
    );
    assert(
      metrics.avgCollectionCycleDays != null && metrics.avgCollectionCycleDays >= 0,
      `avgCollectionCycleDays 非空（got ${metrics.avgCollectionCycleDays}）`,
    );
    assert(
      metrics.quarterlyReceiptRate != null && metrics.quarterlyReceiptRate > 0,
      `quarterlyReceiptRate 非空（got ${metrics.quarterlyReceiptRate}）`,
    );
    assert(
      metrics.yearlyReceiptRate != null && metrics.yearlyReceiptRate > 0,
      `yearlyReceiptRate 非空（got ${metrics.yearlyReceiptRate}）`,
    );

    console.log("\nTest data in temp DB (auto-disposed).");
    console.log(`\n结果: ${pass} pass / ${fail} fail`);
    if (fail > 0) process.exit(1);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

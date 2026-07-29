/**
 * W6.7d P1 回归：RECALLED Profile 不得被 G3 重新写入代表缓存。
 *
 * 夹具：RECALLED + 非空 owner（与 Representative 邮箱桥接）+ Order.representativeId=null
 * 断言：
 *  1. scanRepresentativeMismatch 不出现该订单
 *  2. syncOrderRepresentativesFromEffective 不写代表（skipped）
 *  3. resolve-empty-shell-orgs 可写机构，但不得恢复 Order/Project 代表
 *
 * Usage: npx tsx scripts/smoke-test-g3-recalled-no-rep-backfill.ts
 */

import { withTempSmokeDb } from "./lib/temp-smoke-db";

const PREFIX = `SMOKE-G3R-${Date.now().toString(36)}`;
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

function assertEq<T>(actual: T, expected: T, msg: string) {
  assert(actual === expected, `${msg} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}

async function main() {
  console.log("=== G3 RECALLED no-rep-backfill smoke ===");

  await withTempSmokeDb(async (handle) => {
    handle.assertSafePath();
    const { prisma } = await import("../src/lib/prisma");
    const { REPRESENTATIVE_KIND } = await import("../src/lib/crm/system-representative");
    const {
      scanRepresentativeMismatch,
      syncOrderRepresentativesFromEffective,
    } = await import("../src/lib/orders/governance-scan");
    const { resolveEffectiveRepresentativesForProfiles } = await import(
      "../src/lib/crm/customer-effective-representative"
    );

    const admin = await prisma.user.create({
      data: {
        email: `${PREFIX}-admin@test.local`,
        name: "G3 Admin",
        password: "x",
        role: "ADMIN",
      },
    });
    const owner = await prisma.user.create({
      data: {
        email: `${PREFIX}-rep@test.local`,
        name: "G3 Owner Rep",
        password: "x",
        role: "REPRESENTATIVE",
      },
    });
    const rep = await prisma.representative.create({
      data: {
        name: "G3 Owner Rep",
        email: owner.email,
        kind: REPRESENTATIVE_KIND.HUMAN,
      },
    });
    const org = await prisma.organization.create({
      data: {
        orgCode: `${PREFIX}-ORG`,
        canonicalName: `${PREFIX} 测试大学`,
        normalizedName: `${PREFIX}-test-org`,
        isInvoiceSubject: true,
        taxId: `${PREFIX}TAX`,
      },
    });

    // 故意保留非空 owner：模拟 recall 后 owner 未清干净 / resolver 仍可能解析出代表
    const recalled = await prisma.crmCustomerProfile.create({
      data: {
        customerCode: `${PREFIX}-RC`,
        name: `${PREFIX} Recalled`,
        organization: `${PREFIX} 测试大学`,
        organizationId: null,
        ownerUserId: owner.id,
        stage: "ACTIVE",
        assignmentStatus: "RECALLED",
        recalledAt: new Date(),
        recalledByUserId: admin.id,
        deleted: false,
        archived: false,
      },
    });

    const order = await prisma.order.create({
      data: {
        orderNo: `${PREFIX}-ORD`,
        title: `${PREFIX} recalled order`,
        source: "MANUAL",
        category: "SERVICE",
        status: "CONFIRMED",
        financeTreatment: "STANDALONE",
        totalAmount: 10000,
        profileId: recalled.id,
        representativeId: null,
        createdById: admin.id,
      },
    });

    const project = await prisma.project.create({
      data: {
        name: `${PREFIX} project`,
        status: "ACTIVE",
        profileId: recalled.id,
        representativeId: null,
        representative: null,
        deleted: false,
        archived: false,
      },
    });

    // 证明：若不挡 RECALLED，effective resolver 会从非空 owner 解析出代表
    const effMap = await resolveEffectiveRepresentativesForProfiles([recalled.id]);
    const eff = effMap.get(recalled.id);
    assert(!!eff?.representativeId, "precondition: resolver still finds rep via non-empty owner");
    assertEq(eff?.representativeId, rep.id, "precondition: effective rep is owner bridge");
    assertEq(eff?.source, "EXPLICIT_ASSIGNMENT", "precondition: EXPLICIT_ASSIGNMENT");

    console.log("\n--- G3 scan excludes RECALLED ---");
    const scanned = await scanRepresentativeMismatch();
    assert(
      !scanned.some((r) => r.orderId === order.id),
      "RECALLED order absent from G3 scan",
    );

    console.log("\n--- batch-sync does not write rep ---");
    const syncResult = await prisma.$transaction((tx) =>
      syncOrderRepresentativesFromEffective([order.id], tx),
    );
    assertEq(syncResult.synced, 0, "sync synced=0");
    assertEq(syncResult.skipped, 1, "sync skipped=1 (not ASSIGNED)");
    const orderAfterSync = await prisma.order.findUnique({
      where: { id: order.id },
      select: { representativeId: true },
    });
    assertEq(orderAfterSync?.representativeId, null, "order.representativeId still null after sync");

    console.log("\n--- org resolve may bind org but must not restore Order/Project rep ---");
    const { GOVERNANCE_ORDER_STATUSES } = await import("../src/lib/governance/common");
    await prisma.$transaction(async (tx) => {
      // 与 resolve-empty-shell-orgs 写路径对齐
      const profileBefore = await tx.crmCustomerProfile.findUnique({
        where: { id: recalled.id },
        select: { assignmentStatus: true },
      });
      await tx.crmCustomerProfile.update({
        where: { id: recalled.id },
        data: {
          organizationId: org.id,
          organization: org.canonicalName,
        },
      });
      if (profileBefore?.assignmentStatus === "ASSIGNED") {
        const map = await resolveEffectiveRepresentativesForProfiles([recalled.id], tx);
        const e = map.get(recalled.id);
        if (e?.representativeId && e.source !== "NONE") {
          await tx.order.updateMany({
            where: {
              profileId: recalled.id,
              deleted: false,
              archived: false,
              status: { in: [...GOVERNANCE_ORDER_STATUSES] },
            },
            data: { representativeId: e.representativeId },
          });
          await tx.project.updateMany({
            where: {
              profileId: recalled.id,
              deleted: false,
              archived: false,
            },
            data: { representativeId: e.representativeId, representative: e.representativeName },
          });
        }
      }
    });

    const orderFinal = await prisma.order.findUnique({
      where: { id: order.id },
      select: { representativeId: true },
    });
    const projectFinal = await prisma.project.findUnique({
      where: { id: project.id },
      select: { representativeId: true },
    });
    const profileFinal = await prisma.crmCustomerProfile.findUnique({
      where: { id: recalled.id },
      select: { assignmentStatus: true, organizationId: true },
    });
    assertEq(profileFinal?.assignmentStatus, "RECALLED", "profile stays RECALLED");
    assertEq(profileFinal?.organizationId, org.id, "org resolve can still set organizationId");
    assertEq(orderFinal?.representativeId, null, "order rep not restored after org resolve");
    assertEq(projectFinal?.representativeId, null, "project rep not restored after org resolve");

    // 对照：ASSIGNED 同结构订单应可被 G3 扫到并可 sync
    console.log("\n--- control: ASSIGNED mismatch is syncable ---");
    const assigned = await prisma.crmCustomerProfile.create({
      data: {
        customerCode: `${PREFIX}-AS`,
        name: `${PREFIX} Assigned`,
        organizationId: org.id,
        organization: org.canonicalName,
        ownerUserId: owner.id,
        stage: "ACTIVE",
        assignmentStatus: "ASSIGNED",
        deleted: false,
        archived: false,
      },
    });
    const assignedOrder = await prisma.order.create({
      data: {
        orderNo: `${PREFIX}-ORD-AS`,
        title: `${PREFIX} assigned order`,
        source: "MANUAL",
        category: "SERVICE",
        status: "CONFIRMED",
        financeTreatment: "STANDALONE",
        totalAmount: 20000,
        profileId: assigned.id,
        representativeId: null,
        createdById: admin.id,
      },
    });
    const assignedScan = await scanRepresentativeMismatch();
    assert(
      assignedScan.some((r) => r.orderId === assignedOrder.id && r.autoFixable),
      "ASSIGNED mismatch appears in G3 scan",
    );
    const assignedSync = await prisma.$transaction((tx) =>
      syncOrderRepresentativesFromEffective([assignedOrder.id], tx),
    );
    assertEq(assignedSync.synced, 1, "ASSIGNED sync synced=1");
    const assignedOrderAfter = await prisma.order.findUnique({
      where: { id: assignedOrder.id },
      select: { representativeId: true },
    });
    assertEq(assignedOrderAfter?.representativeId, rep.id, "ASSIGNED order got effective rep");
  });

  console.log(`\n=== done: ${pass} passed, ${fail} failed ===`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error("\n冒烟测试失败:", err);
  process.exit(1);
});

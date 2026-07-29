/**
 * Smoke test for R-1: CustomerRelation merge→rollback round-trip (W6.5 Profile-only).
 *
 * Verifies that:
 *  1. executeMerge migrates CustomerRelation edges (both from/to directions)
 *     from source Profile to target Profile.
 *  2. reverseMerge restores those edges back to source, per-direction.
 *  3. migratedIdsJson stores the { from: [], to: [] } shape (not a flat array).
 *  4. Order match snapshots restore on reverse.
 *  5. Fixtures are Profile-only（Phase E contract：旧 `*CustomerId*` 列已删，null 断言已随列移除）。
 *
 * Usage: npx tsx scripts/smoke-test-customer-merge-rollback.ts
 */

import { withTempSmokeDb } from "./lib/temp-smoke-db";

const PREFIX = `SMOKE-${Date.now().toString(36)}`;
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
  console.log("=== Customer merge rollback (Profile-only / W6.5) ===");

  await withTempSmokeDb(async (handle) => {
    handle.assertSafePath();

    const { prisma } = await import("../src/lib/prisma");
    const { executeMerge, reverseMerge } = await import("../src/lib/customers/customer-merge");

    const org = await prisma.organization.create({
      data: {
        orgCode: `${PREFIX}-ORG`,
        canonicalName: `${PREFIX} 测试机构`,
        normalizedName: `${PREFIX}-test-org`,
        isInvoiceSubject: true,
        taxId: `${PREFIX}TAX`,
      },
    });

    const admin = await prisma.user.create({
      data: {
        email: `${PREFIX}-admin@test.local`,
        name: "Merge Rollback Admin",
        password: "x",
        role: "ADMIN",
      },
    });

    const [profileA, profileB, profileC] = await Promise.all([
      prisma.crmCustomerProfile.create({
        data: {
          customerCode: `${PREFIX}-A`,
          name: `${PREFIX} 张三`,
          organizationId: org.id,
          organization: org.canonicalName,
          ownerUserId: admin.id,
          stage: "LEAD",
          assignmentStatus: "ASSIGNED",
        },
      }),
      prisma.crmCustomerProfile.create({
        data: {
          customerCode: `${PREFIX}-B`,
          name: `${PREFIX} 李四`,
          organizationId: org.id,
          organization: org.canonicalName,
          ownerUserId: admin.id,
          stage: "LEAD",
          assignmentStatus: "ASSIGNED",
        },
      }),
      prisma.crmCustomerProfile.create({
        data: {
          customerCode: `${PREFIX}-C`,
          name: `${PREFIX} 王五`,
          organizationId: org.id,
          organization: org.canonicalName,
          ownerUserId: admin.id,
          stage: "LEAD",
          assignmentStatus: "ASSIGNED",
        },
      }),
    ]);

    const edgeAB = await prisma.customerRelation.create({
      data: {
        fromProfileId: profileA.id,
        toProfileId: profileB.id,
        type: "COLLABORATION",
        createdByUserId: admin.id,
      },
    });
    const edgeCA = await prisma.customerRelation.create({
      data: {
        fromProfileId: profileC.id,
        toProfileId: profileA.id,
        type: "INTRODUCTION",
        createdByUserId: admin.id,
      },
    });

    const orderOnA = await prisma.order.create({
      data: {
        orderNo: `${PREFIX}-ORD`,
        title: `${PREFIX} 测试订单`,
        totalAmount: 10000,
        profileId: profileA.id,
        customerMatchStatus: "AUTO_MATCHED",
        customerMatchScore: 80,
        customerMatchReason: "wechat_exact_match",
        status: "CONFIRMED",
        source: "MANUAL",
        category: "SERVICE",
        createdById: admin.id,
      },
    });

    console.log(`\n📦 Setup: A=${profileA.id.slice(-6)} B=${profileB.id.slice(-6)} C=${profileC.id.slice(-6)}`);
    console.log(`   edges: A→B(${edgeAB.id.slice(-6)}) [from], C→A(${edgeCA.id.slice(-6)}) [to]`);
    console.log(`   order: ${orderOnA.id.slice(-6)} on A (AUTO_MATCHED, score=80, Profile-only)`);

    console.log("\n▶ Merge A → B (KEEP_TARGET, KEEP_TARGET_ORG)");
    const result = await executeMerge(profileA.id, profileB.id, "KEEP_TARGET", "KEEP_TARGET_ORG", admin.id);

    console.log(`   migratedCounts: ${JSON.stringify(result.migratedCounts)}`);

    const log = await prisma.customerMergeLog.findUnique({ where: { id: result.mergeLogId } });
    const storedIds = JSON.parse(log!.migratedIdsJson) as Record<string, unknown>;
    const relStored = storedIds.customerRelations as { from?: string[]; to?: string[] } | string[] | undefined;

    assert(
      !!relStored && !Array.isArray(relStored) && Array.isArray(relStored.from) && Array.isArray(relStored.to),
      "migratedIds.customerRelations stored as { from: [], to: [] } (not flat array)",
    );

    const edgeABAfter = await prisma.customerRelation.findUnique({ where: { id: edgeAB.id } });
    const edgeCAAfter = await prisma.customerRelation.findUnique({ where: { id: edgeCA.id } });

    assert(
      edgeABAfter?.fromProfileId === profileB.id && edgeABAfter?.toProfileId === profileB.id,
      `A→B edge migrated: fromProfile A→B (got ${edgeABAfter?.fromProfileId.slice(-6)}→${edgeABAfter?.toProfileId.slice(-6)})`,
    );
    assert(
      edgeCAAfter?.fromProfileId === profileC.id && edgeCAAfter?.toProfileId === profileB.id,
      `C→A edge migrated: toProfile A→B (got ${edgeCAAfter?.fromProfileId.slice(-6)}→${edgeCAAfter?.toProfileId.slice(-6)})`,
    );

    const aAfterMerge = await prisma.crmCustomerProfile.findUnique({ where: { id: profileA.id } });
    assert(
      aAfterMerge?.deleted === true && aAfterMerge?.mergedIntoProfileId === profileB.id,
      "Source profile A soft-deleted + mergedIntoProfileId set",
    );

    const orderAfterMerge = await prisma.order.findUnique({ where: { id: orderOnA.id } });
    assert(
      orderAfterMerge?.profileId === profileB.id,
      `Order profileId migrated A→B (got ${orderAfterMerge?.profileId?.slice(-6) ?? "null"})`,
    );
    assert(
      orderAfterMerge?.customerMatchStatus === "MANUAL_MATCHED",
      `Order matchStatus re-stamped to MANUAL_MATCHED (got ${orderAfterMerge?.customerMatchStatus})`,
    );
    assert(
      orderAfterMerge?.customerMatchReason === "existing_customer_binding",
      `Order matchReason = existing_customer_binding (got ${orderAfterMerge?.customerMatchReason})`,
    );
    assert(
      orderAfterMerge?.customerMatchScore === null,
      `Order matchScore cleared (got ${orderAfterMerge?.customerMatchScore})`,
    );

    console.log("\n◀ Reverse merge");
    await reverseMerge(result.mergeLogId, admin.id, "smoke test rollback");

    const edgeABRev = await prisma.customerRelation.findUnique({ where: { id: edgeAB.id } });
    const edgeCARev = await prisma.customerRelation.findUnique({ where: { id: edgeCA.id } });

    assert(
      edgeABRev?.fromProfileId === profileA.id && edgeABRev?.toProfileId === profileB.id,
      `A→B edge restored: fromProfile B→A (got ${edgeABRev?.fromProfileId.slice(-6)}→${edgeABRev?.toProfileId.slice(-6)})`,
    );
    assert(
      edgeCARev?.fromProfileId === profileC.id && edgeCARev?.toProfileId === profileA.id,
      `C→A edge restored: toProfile B→A (got ${edgeCARev?.fromProfileId.slice(-6)}→${edgeCARev?.toProfileId.slice(-6)})`,
    );

    const aAfterRev = await prisma.crmCustomerProfile.findUnique({ where: { id: profileA.id } });
    assert(
      aAfterRev?.deleted === false && aAfterRev?.mergedIntoProfileId === null,
      "Source profile A restored (deleted=false, mergedIntoProfileId=null)",
    );

    const orderAfterRev = await prisma.order.findUnique({ where: { id: orderOnA.id } });
    assert(
      orderAfterRev?.profileId === profileA.id,
      `Order profileId restored B→A (got ${orderAfterRev?.profileId?.slice(-6) ?? "null"})`,
    );
    assert(
      orderAfterRev?.customerMatchStatus === "AUTO_MATCHED",
      `Order matchStatus restored to AUTO_MATCHED (got ${orderAfterRev?.customerMatchStatus})`,
    );
    assert(
      orderAfterRev?.customerMatchScore === 80,
      `Order matchScore restored to 80 (got ${orderAfterRev?.customerMatchScore})`,
    );
    assert(
      orderAfterRev?.customerMatchReason === "wechat_exact_match",
      `Order matchReason restored (got ${orderAfterRev?.customerMatchReason})`,
    );
  });

  console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error("\n💥 SMOKE TEST CRASHED:", err);
  process.exit(1);
});

/**
 * W5.4 KPI 固定集对账
 *
 * - 临时库（不写 prisma/dev.db）
 * - 冻结时钟 NOW = 2026-06-15T12:00:00+08:00，经 helper 的 now 参数传入
 * - Fixture：Profile-only + 已合并 survivor + 多代表归属
 * - 明确数值断言 + 隔离断言
 *
 * Usage: npx tsx scripts/smoke-test-kpi-fixed-set-reconcile.ts
 */

import { withTempSmokeDb } from "./lib/temp-smoke-db";

/** Frozen clock — all windows (30/90d, month, quarter, year, dormant) use this. */
const NOW = new Date("2026-06-15T12:00:00+08:00");
const PREFIX = `KPI-${NOW.getTime().toString(36)}`;

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
  assert(actual === expected, `${msg} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
}

async function main() {
  console.log("=== W5.4 KPI fixed-set reconcile ===");
  console.log(`Frozen NOW=${NOW.toISOString()}`);

  await withTempSmokeDb(async (handle) => {
    handle.assertSafePath();

    const { prisma } = await import("../src/lib/prisma");
    const { REPRESENTATIVE_KIND } = await import("../src/lib/crm/system-representative");
    const { getCrmLifecycleSummariesForProfiles } = await import("../src/lib/crm/lifecycle");
    const { buildRepresentativePerformanceScope } = await import("../src/lib/crm/representative-performance");
    const { getCrmCommunicationMetrics } = await import("../src/lib/crm/communication-metrics");
    const {
      getMonthlyCustomerGrowth,
      getMonthlyAverageOrderValue,
      getRepurchaseCategoryConversion,
    } = await import("../src/lib/crm/representative-trends");
    const {
      getBusinessRecognitionEvents,
      sumRecognitionEvents,
    } = await import("../src/lib/finance/business-recognition");
    const {
      preloadRepresentativeCollectionData,
      buildRepresentativeCollectionMetrics,
      RECEIVABLE_BELOW_THRESHOLD_CENTS,
      MIN_CYCLE_PAIR_COUNT,
    } = await import("../src/lib/finance/collection-analysis");
    const { resolveDashboardScope, buildDashboardRows } = await import("../src/lib/crm/dashboard-data");
    const { resolveEffectiveRepresentativesForProfiles } = await import(
      "../src/lib/crm/customer-effective-representative"
    );
    const { assertCrmProfileAccess, getEffectiveCrmVisibleProfileIds } = await import(
      "../src/lib/crm/permissions"
    );

    // ── Actors ─────────────────────────────────────────────────────
    const admin = await prisma.user.create({
      data: {
        email: `${PREFIX}-admin@test.local`,
        name: "KPI Admin",
        password: "x",
        role: "ADMIN",
      },
    });
    const userA = await prisma.user.create({
      data: {
        email: `${PREFIX}-rep-a@test.local`,
        name: "Rep A",
        password: "x",
        role: "REPRESENTATIVE",
      },
    });
    const userB = await prisma.user.create({
      data: {
        email: `${PREFIX}-rep-b@test.local`,
        name: "Rep B",
        password: "x",
        role: "REPRESENTATIVE",
      },
    });
    const repA = await prisma.representative.create({
      data: {
        name: "Rep A",
        email: userA.email,
        kind: REPRESENTATIVE_KIND.HUMAN,
      },
    });
    const repB = await prisma.representative.create({
      data: {
        name: "Rep B",
        email: userB.email,
        kind: REPRESENTATIVE_KIND.HUMAN,
      },
    });

    const orgA = await prisma.organization.create({
      data: {
        orgCode: `${PREFIX}-OA`,
        canonicalName: `${PREFIX} Org A`,
        normalizedName: `${PREFIX}-org-a`,
      },
    });
    const orgB = await prisma.organization.create({
      data: {
        orgCode: `${PREFIX}-OB`,
        canonicalName: `${PREFIX} Org B`,
        normalizedName: `${PREFIX}-org-b`,
      },
    });

    await prisma.representativeOrganization.create({
      data: {
        representativeId: repA.id,
        organizationId: orgA.id,
        organizationSiteId: null,
        status: "ACTIVE",
        isPrimary: true,
        reviewedAt: NOW,
      },
    });
    await prisma.representativeOrganization.create({
      data: {
        representativeId: repB.id,
        organizationId: orgB.id,
        organizationSiteId: null,
        status: "ACTIVE",
        isPrimary: true,
        reviewedAt: NOW,
      },
    });

    const assignedAtJune = new Date("2026-06-01T10:00:00+08:00");
    const dormantAssignedAt = new Date("2026-01-01T10:00:00+08:00"); // >60d before NOW

    // Profile-only under A: active repeat customer (2 confirmed PRODUCT orders)
    const p1 = await prisma.crmCustomerProfile.create({
      data: {
        customerCode: `${PREFIX}-P1`,
        name: `${PREFIX} P1`,
        organizationId: orgA.id,
        organization: orgA.canonicalName,
        ownerUserId: userA.id,
        stage: "ACTIVE",
        assignmentStatus: "ASSIGNED",
        assignedAt: assignedAtJune,
        createdAt: assignedAtJune,
      },
    });

    // Profile-only under A: communicated once
    const p2 = await prisma.crmCustomerProfile.create({
      data: {
        customerCode: `${PREFIX}-P2`,
        name: `${PREFIX} P2`,
        organizationId: orgA.id,
        organization: orgA.canonicalName,
        ownerUserId: userA.id,
        stage: "FOLLOWING",
        assignmentStatus: "ASSIGNED",
        assignedAt: assignedAtJune,
        createdAt: assignedAtJune,
      },
    });

    // Profile-only under A: dormant risk (old assign, no orders/interactions)
    const p3 = await prisma.crmCustomerProfile.create({
      data: {
        customerCode: `${PREFIX}-P3`,
        name: `${PREFIX} P3`,
        organizationId: orgA.id,
        organization: orgA.canonicalName,
        ownerUserId: userA.id,
        stage: "LEAD",
        assignmentStatus: "ASSIGNED",
        assignedAt: dormantAssignedAt,
        createdAt: dormantAssignedAt,
        lastFollowUpAt: dormantAssignedAt,
      },
    });

    // Merged pair under A: source deleted/merged, survivor holds the only order
    const pSource = await prisma.crmCustomerProfile.create({
      data: {
        customerCode: `${PREFIX}-SRC`,
        name: `${PREFIX} Source`,
        organizationId: orgA.id,
        organization: orgA.canonicalName,
        ownerUserId: userA.id,
        stage: "ACTIVE",
        assignmentStatus: "ASSIGNED",
        assignedAt: assignedAtJune,
        deleted: true,
        deletedAt: NOW,
      },
    });
    const pSurvivor = await prisma.crmCustomerProfile.create({
      data: {
        customerCode: `${PREFIX}-SV`,
        name: `${PREFIX} Survivor`,
        organizationId: orgA.id,
        organization: orgA.canonicalName,
        ownerUserId: userA.id,
        stage: "ACTIVE",
        assignmentStatus: "ASSIGNED",
        assignedAt: assignedAtJune,
      },
    });
    await prisma.crmCustomerProfile.update({
      where: { id: pSource.id },
      data: { mergedIntoProfileId: pSurvivor.id },
    });

    // Profile under B — must not appear in A's scope
    const pB = await prisma.crmCustomerProfile.create({
      data: {
        customerCode: `${PREFIX}-PB`,
        name: `${PREFIX} PB`,
        organizationId: orgB.id,
        organization: orgB.canonicalName,
        ownerUserId: userB.id,
        stage: "ACTIVE",
        assignmentStatus: "ASSIGNED",
        assignedAt: assignedAtJune,
      },
    });

    // Conflict: org bound to A, but explicit owner = B (pool reassignment)
    // Stale MANAGING tag for A must NOT grant A visibility/KPI (resolver-only auth).
    const pConflict = await prisma.crmCustomerProfile.create({
      data: {
        customerCode: `${PREFIX}-CF`,
        name: `${PREFIX} Conflict`,
        organizationId: orgA.id,
        organization: orgA.canonicalName,
        ownerUserId: userB.id,
        stage: "ACTIVE",
        assignmentStatus: "ASSIGNED",
        assignedAt: assignedAtJune,
      },
    });
    await prisma.customerRepTag.create({
      data: {
        profileId: pConflict.id,
        representativeId: repA.id,
        tagType: "MANAGING",
        isActive: true,
        isPrimary: false,
        createdByUserId: admin.id,
        source: "ASSIGNMENT_MIGRATION",
        note: "stale leftover tag for A",
      },
    });
    await prisma.customerRepTag.create({
      data: {
        profileId: pConflict.id,
        representativeId: repB.id,
        tagType: "MANAGING",
        isActive: true,
        isPrimary: true,
        createdByUserId: admin.id,
        source: "ASSIGNMENT_MIGRATION",
      },
    });

    const orderAmount = Math.max(RECEIVABLE_BELOW_THRESHOLD_CENTS + 100_000, 2_000_000);
    const orderedAt = new Date("2026-06-02T12:00:00+08:00");

    // P1: two PRODUCT standalone orders → repeat
    for (let i = 0; i < 2; i++) {
      await prisma.order.create({
        data: {
          orderNo: `${PREFIX}-P1-O${i}`,
          title: `${PREFIX} P1 order ${i}`,
          source: "MANUAL",
          category: "PRODUCT",
          status: "CONFIRMED",
          financeTreatment: "STANDALONE",
          totalAmount: 500_000,
          profileId: p1.id,
          orderedAt: new Date(orderedAt.getTime() + i * 86_400_000),
          confirmedAt: new Date(orderedAt.getTime() + i * 86_400_000),
          createdById: admin.id,
        },
      });
    }

    // Survivor: PRODUCT order（Profile-only，KPI 只按 profileId 归集）
    const survivorOrder = await prisma.order.create({
      data: {
        orderNo: `${PREFIX}-SV-O`,
        title: `${PREFIX} survivor collection order`,
        source: "MANUAL",
        category: "PRODUCT",
        status: "CONFIRMED",
        financeTreatment: "STANDALONE",
        totalAmount: orderAmount,
        profileId: pSurvivor.id,
        orderedAt,
        confirmedAt: orderedAt,
        createdById: admin.id,
      },
    });

    // Source profile must NOT get a duplicate order counted for KPI after merge
    // (no orders on pSource)

    // Collection pairs for survivor (3 pairs, known cycles)
    const invoices = [];
    const receipts = [];
    for (let i = 0; i < MIN_CYCLE_PAIR_COUNT; i++) {
      const issuedAt = new Date(orderedAt.getTime() - (MIN_CYCLE_PAIR_COUNT - i + 3) * 86_400_000);
      const receivedAt = new Date(issuedAt.getTime() + 2 * 86_400_000); // cycle = 2 days
      const part = Math.floor(orderAmount / MIN_CYCLE_PAIR_COUNT);
      const inv = await prisma.externalOrderInvoiceRequest.create({
        data: {
          orderId: survivorOrder.id,
          buyerOrganizationName: orgA.canonicalName,
          buyerOrganizationId: orgA.id,
          totalAmount: part,
          status: "ISSUED",
          actualIssuedAt: issuedAt,
          createdById: admin.id,
        },
      });
      invoices.push(inv);
      await prisma.orderInvoiceCoverage.create({
        data: { orderId: survivorOrder.id, invoiceRequestId: inv.id, amount: part },
      });
      const rec = await prisma.financeReceipt.create({
        data: {
          amount: part,
          receivedAt,
          profileId: pSurvivor.id,
          orderId: survivorOrder.id,
          source: "MANUAL",
          createdById: admin.id,
        },
      });
      receipts.push(rec);
      await prisma.financeReceiptAllocation.create({
        data: {
          receiptId: rec.id,
          invoiceId: inv.id,
          orderId: survivorOrder.id,
          amount: part,
          createdById: admin.id,
        },
      });
    }

    // Communication: only p2 has a COMPLETED checkin in window
    const windowFrom = new Date("2026-05-16T00:00:00+08:00");
    await prisma.crmVisitCheckin.create({
      data: {
        profileId: p2.id,
        userId: userA.id,
        status: "COMPLETED",
        createdAt: new Date("2026-06-10T09:00:00+08:00"),
        completedAt: new Date("2026-06-10T09:00:00+08:00"),
        lat: 0,
        lng: 0,
      },
    });

    // P1 also PRODUCT→SERVICE repurchase for conversion
    await prisma.order.create({
      data: {
        orderNo: `${PREFIX}-P1-SVC`,
        title: `${PREFIX} P1 service`,
        source: "MANUAL",
        category: "SERVICE",
        status: "CONFIRMED",
        financeTreatment: "STANDALONE",
        totalAmount: 300_000,
        profileId: p1.id,
        orderedAt: new Date("2026-06-12T12:00:00+08:00"),
        confirmedAt: new Date("2026-06-12T12:00:00+08:00"),
        createdById: admin.id,
      },
    });

    console.log("\n--- Lifecycle ---");
    const life = await getCrmLifecycleSummariesForProfiles(
      [p1.id, p2.id, p3.id, pSource.id, pSurvivor.id, pB.id],
      prisma,
      NOW,
    );
    assertEq(life.get(p1.id)?.historicalOrderCount, 3, "P1 historicalOrderCount=3 (2 PRODUCT + 1 SERVICE)");
    assertEq(life.get(p1.id)?.isRepeatCustomer, true, "P1 isRepeatCustomer");
    assertEq(life.get(p3.id)?.dormantRisk, true, "P3 dormantRisk");
    assert(
      !life.has(pSource.id) || life.get(pSource.id)?.historicalOrderCount === 0,
      "merged source contributes 0 orders to KPI",
    );
    const lifeLive = await getCrmLifecycleSummariesForProfiles(
      [pSurvivor.id],
      prisma,
      NOW,
    );
    assertEq(lifeLive.get(pSurvivor.id)?.historicalOrderCount, 1, "survivor historicalOrderCount=1 (source not double-counted)");

    console.log("\n--- Representative scope ---");
    const scopeA = await buildRepresentativePerformanceScope(repA.id);
    const scopeB = await buildRepresentativePerformanceScope(repB.id);
    assert(scopeA.profileIds.includes(p1.id), "A includes Profile-only P1");
    assert(scopeA.profileIds.includes(p2.id), "A includes P2");
    assert(scopeA.profileIds.includes(p3.id), "A includes P3");
    assert(scopeA.profileIds.includes(pSurvivor.id), "A includes survivor");
    assert(!scopeA.profileIds.includes(pSource.id), "A excludes deleted merged source");
    assert(!scopeA.profileIds.includes(pB.id), "A does not see B's profile");
    assert(scopeB.profileIds.includes(pB.id), "B includes PB");
    assert(!scopeB.profileIds.includes(p1.id), "B does not see A's Profile-only");
    assertEq(scopeA.profileIds.length, 4, "A effective profile count = 4 (P1,P2,P3,survivor)");
    assert(!scopeA.profileIds.includes(pConflict.id), "A does not own conflict (explicit owner=B)");
    assert(scopeB.profileIds.includes(pConflict.id), "B owns conflict via EXPLICIT despite orgA binding");

    const conflictEff = (await resolveEffectiveRepresentativesForProfiles([pConflict.id])).get(pConflict.id);
    assertEq(conflictEff?.source, "EXPLICIT_ASSIGNMENT", "conflict source=EXPLICIT_ASSIGNMENT");
    assertEq(conflictEff?.ownerUserId, userB.id, "conflict effective owner=userB");
    assertEq(conflictEff?.representativeId, repB.id, "conflict effective rep=repB");

    // Visibility: B can access conflict; A cannot (owner/MANAGING/effective all point to B)
    await assertCrmProfileAccess(pConflict.id, userB.id, "REPRESENTATIVE");
    let aForbidden = false;
    try {
      await assertCrmProfileAccess(pConflict.id, userA.id, "REPRESENTATIVE");
    } catch (err) {
      aForbidden = err instanceof Error && err.message === "FORBIDDEN";
    }
    assert(aForbidden, "A gets FORBIDDEN on conflict profile detail");
    const visibleA = await getEffectiveCrmVisibleProfileIds(userA.id, "REPRESENTATIVE");
    const visibleB = await getEffectiveCrmVisibleProfileIds(userB.id, "REPRESENTATIVE");
    assert(visibleA != null && !visibleA.has(pConflict.id), "A list excludes conflict (stale MANAGING ignored)");
    assert(visibleB != null && visibleB.has(pConflict.id), "B list includes conflict");

    // Admin overview 预警口径：owner=B + 残留 tag=A 时只归 B（effective，非 raw MANAGING 聚合）
    console.log("\n--- Admin overview rep alerts (stale MANAGING) ---");
    await prisma.crmFollowUpTask.create({
      data: {
        profileId: pConflict.id,
        title: `${PREFIX} overdue conflict`,
        status: "OPEN",
        dueAt: new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000),
        ownerUserId: userB.id,
        createdByUserId: admin.id,
      },
    });
    const alertAssigned = await prisma.crmCustomerProfile.findMany({
      where: {
        id: { in: [pConflict.id, p1.id, pB.id] },
        assignmentStatus: "ASSIGNED",
        archived: false,
        deleted: false,
      },
      select: { id: true },
    });
    const alertEff = await resolveEffectiveRepresentativesForProfiles(alertAssigned.map((p) => p.id));
    const alertRepMap = new Map<string, Set<string>>();
    for (const row of alertAssigned) {
      const rid = alertEff.get(row.id)?.representativeId;
      if (!rid) continue;
      const set = alertRepMap.get(rid) ?? new Set<string>();
      set.add(row.id);
      alertRepMap.set(rid, set);
    }
    assert(alertRepMap.get(repB.id)?.has(pConflict.id) === true, "admin alert groups conflict under B");
    assert(alertRepMap.get(repA.id)?.has(pConflict.id) !== true, "admin alert does not group conflict under A (stale MANAGING)");
    const overdueOnB = await prisma.crmFollowUpTask.count({
      where: {
        profileId: { in: [...(alertRepMap.get(repB.id) ?? [])] },
        status: "OPEN",
        dueAt: { lt: NOW },
      },
    });
    const overdueOnA = await prisma.crmFollowUpTask.count({
      where: {
        profileId: { in: [...(alertRepMap.get(repA.id) ?? [])] },
        status: "OPEN",
        dueAt: { lt: NOW },
      },
    });
    assert(overdueOnB >= 1, "B overdue count includes conflict task");
    assertEq(overdueOnA, 0, "A overdue count excludes conflict task (stale tag ignored)");

    console.log("\n--- Recall final state ---");
    const { ensureHqRepresentative } = await import("../src/lib/crm/system-representative");
    const { clearProfileAssignmentOnRecall } = await import("../src/lib/crm/customer-representative-sync");
    const { retireManagingTag } = await import("../src/lib/crm/customer-rep-tag-helpers");
    await ensureHqRepresentative();

    const pRecall = await prisma.crmCustomerProfile.create({
      data: {
        customerCode: `${PREFIX}-RC`,
        name: `${PREFIX} Recall`,
        organizationId: orgA.id,
        organization: orgA.canonicalName,
        ownerUserId: userA.id,
        stage: "ACTIVE",
        assignmentStatus: "ASSIGNED",
        assignedAt: assignedAtJune,
      },
    });
    await prisma.customerRepTag.create({
      data: {
        profileId: pRecall.id,
        representativeId: repA.id,
        tagType: "MANAGING",
        isActive: true,
        isPrimary: true,
        createdByUserId: admin.id,
        source: "ASSIGNMENT_MIGRATION",
      },
    });

    await prisma.$transaction(async (tx) => {
      await tx.crmCustomerProfile.update({
        where: { id: pRecall.id },
        data: {
          assignmentStatus: "RECALLED",
          recalledAt: NOW,
          recalledByUserId: admin.id,
        },
      });
      await retireManagingTag(tx, {
        profileId: pRecall.id,
        representativeId: repA.id,
        now: NOW,
        actingUserId: admin.id,
        note: "smoke recall",
      });
      await clearProfileAssignmentOnRecall(pRecall.id, tx);
    });

    const recalled = await prisma.crmCustomerProfile.findUnique({
      where: { id: pRecall.id },
      select: { assignmentStatus: true, ownerUserId: true },
    });
    assertEq(recalled?.assignmentStatus, "RECALLED", "recall keeps RECALLED (not re-ASSIGNED by org sync)");
    assert(recalled?.ownerUserId !== userA.id, "recall moves owner off previous sales user");
    let recallForbidden = false;
    try {
      await assertCrmProfileAccess(pRecall.id, userA.id, "REPRESENTATIVE");
    } catch (err) {
      recallForbidden = err instanceof Error && err.message === "FORBIDDEN";
    }
    assert(recallForbidden, "previous owner cannot access recalled profile");
    const visibleAfterRecall = await getEffectiveCrmVisibleProfileIds(userA.id, "REPRESENTATIVE");
    assert(visibleAfterRecall != null && !visibleAfterRecall.has(pRecall.id), "previous owner list excludes recalled");

    // 机构同步不得复活 RECALLED
    const { syncProfileRepresentativeLinks, syncEffectiveRepresentativeLinksForOrganization } = await import(
      "../src/lib/crm/customer-representative-sync"
    );
    await syncProfileRepresentativeLinks(pRecall.id);
    await syncEffectiveRepresentativeLinksForOrganization({ organizationId: orgA.id });
    const afterOrgSync = await prisma.crmCustomerProfile.findUnique({
      where: { id: pRecall.id },
      select: { assignmentStatus: true },
    });
    assertEq(afterOrgSync?.assignmentStatus, "RECALLED", "org sync must not revive RECALLED");

    const scopeAAfterRecall = await buildRepresentativePerformanceScope(repA.id);
    assert(!scopeAAfterRecall.profileIds.includes(pRecall.id), "performance scope excludes RECALLED");
    const dashAAfterRecall = await resolveDashboardScope(userA.id, "REPRESENTATIVE");
    assert(!dashAAfterRecall.visibleProfileIds.has(pRecall.id), "dashboard excludes RECALLED for sales");
    assert(!dashAAfterRecall.myProfileIds.has(pRecall.id), "dashboard my-set excludes RECALLED");

    console.log("\n--- Receipt profile fail-closed ---");
    const { requireOrderProfileIdForReceipt, ReceiptMissingProfileError } = await import(
      "../src/lib/finance/receipt-profile"
    );
    const orphanOrder = await prisma.order.create({
      data: {
        orderNo: `${PREFIX}-ORPHAN`,
        title: `${PREFIX} orphan`,
        source: "MANUAL",
        category: "PRODUCT",
        status: "CONFIRMED",
        financeTreatment: "STANDALONE",
        totalAmount: 100_000,
        profileId: null,
        orderedAt: NOW,
        confirmedAt: NOW,
        createdById: admin.id,
      },
    });
    const profileOrder = await prisma.order.create({
      data: {
        orderNo: `${PREFIX}-RCP`,
        title: `${PREFIX} receipt ok`,
        source: "MANUAL",
        category: "PRODUCT",
        status: "DRAFT",
        financeTreatment: "STANDALONE",
        totalAmount: 100_000,
        profileId: p1.id,
        orderedAt: NOW,
        createdById: admin.id,
      },
    });

    const receiptCountBefore = await prisma.financeReceipt.count();
    let orphanRejected = false;
    try {
      requireOrderProfileIdForReceipt(orphanOrder.profileId);
    } catch (err) {
      orphanRejected = err instanceof ReceiptMissingProfileError;
    }
    assert(orphanRejected, "requireOrderProfileIdForReceipt rejects null profileId");
    // Guard must run before create: no receipt row for orphan path
    assertEq(
      await prisma.financeReceipt.count(),
      receiptCountBefore,
      "rejecting missing profileId must not insert FinanceReceipt",
    );

    const okProfileId = requireOrderProfileIdForReceipt(profileOrder.profileId);
    const okReceipt = await prisma.financeReceipt.create({
      data: {
        orderId: profileOrder.id,
        profileId: okProfileId,
        amount: 50_000,
        receivedAt: NOW,
        source: "MANUAL",
        createdById: admin.id,
      },
    });
    assertEq(okReceipt.profileId, p1.id, "Profile-only receipt stores profileId");

    console.log("\n--- Communication coverage ---");
    const comm = await getCrmCommunicationMetrics(
      {
        profileIds: [p1.id, p2.id],
        actorUserIds: [userA.id],
        from: windowFrom,
        to: NOW,
        now: NOW,
      },
      prisma,
    );
    assertEq(comm.assignedCustomerCount, 2, "comm assigned=2");
    assertEq(comm.communicatedCustomerCount, 1, "comm communicated=1 (Profile-only P2)");
    assertEq(comm.communicationCoverageRate, 0.5, "comm coverage=0.5");

    console.log("\n--- Growth / AOV / repurchase ---");
    const growthMap = getMonthlyCustomerGrowth(
      new Map([[userA.id, [p1.id, p2.id, p3.id, pSurvivor.id]]]),
      new Map([
        [p1.id, assignedAtJune],
        [p2.id, assignedAtJune],
        [p3.id, dormantAssignedAt],
        [pSurvivor.id, assignedAtJune],
      ]),
      3,
      NOW,
    );
    const juneKey = "2026-06";
    const growthPts = growthMap.get(userA.id) ?? [];
    const junePt = growthPts.find((p) => p.month === juneKey);
    assertEq(junePt?.newCount, 3, "June newCount=3 (P1,P2,survivor; P3 earlier)");

    const aovMap = await getMonthlyAverageOrderValue(
      new Map([[userA.id, [p1.id, pSurvivor.id]]]),
      3,
      prisma,
      NOW,
    );
    const aovJune = (aovMap.get(userA.id) ?? []).find((p) => p.month === juneKey);
    assert(aovJune != null && aovJune.orderCount > 0, `AOV June orderCount>0 (got ${aovJune?.orderCount})`);
    assert(aovJune != null && aovJune.avgOrderValue > 0, `AOV June avg>0 (got ${aovJune?.avgOrderValue})`);

    const convMap = await getRepurchaseCategoryConversion(
      new Map([[userA.id, [p1.id]]]),
      3,
      prisma,
      NOW,
    );
    const convJune = (convMap.get(userA.id)?.points ?? []).find((p) => p.month === juneKey);
    assertEq(convJune?.repeatCustomerCount, 1, "repurchase repeatCustomerCount=1");
    assertEq(convJune?.convertedToServiceCount, 1, "convertedToServiceCount=1");
    assertEq(convJune?.conversionRate, 1, "conversionRate=1");

    console.log("\n--- Business recognition ---");
    const events = await getBusinessRecognitionEvents({
      profileIds: [p1.id, pSurvivor.id],
      periodStart: new Date("2026-06-01T00:00:00+08:00"),
      periodEnd: NOW,
    });
    const sum = sumRecognitionEvents(events);
    const { ratioCents } = await import("../src/lib/finance/money");
    // P1: 500k+500k PRODUCT + SERVICE 30% of 300k; survivor: orderAmount full PRODUCT
    const expectedMin =
      500_000 + 500_000 + ratioCents(300_000, 3, 10) + orderAmount;
    assertEq(sum.confirmedBusinessCents, expectedMin, "confirmedBusinessCents matches hand total");

    console.log("\n--- Collection ---");
    const preload = await preloadRepresentativeCollectionData([pSurvivor.id], NOW);
    const collection = buildRepresentativeCollectionMetrics(
      [pSurvivor.id],
      preload.pairs,
      preload.quarterReceivableMap,
      preload.yearReceivableMap,
      NOW,
    );
    assertEq(collection.collectionPairCount, MIN_CYCLE_PAIR_COUNT, `pairCount=${MIN_CYCLE_PAIR_COUNT}`);
    assertEq(collection.avgCollectionCycleDays, 2, "avgCollectionCycleDays=2");
    assert(
      collection.quarterlyReceiptRate != null && Math.abs(collection.quarterlyReceiptRate - 1) < 1e-5,
      `quarterlyReceiptRate≈1 (got ${collection.quarterlyReceiptRate})`,
    );
    console.log("\n--- Dashboard isolation ---");
    const dashA = await resolveDashboardScope(userA.id, "REPRESENTATIVE");
    assert(dashA.myProfileIds.has(p1.id), "dashboard A sees Profile-only P1");
    assert(!dashA.myProfileIds.has(pB.id), "dashboard A does not see PB");
    const rows = await buildDashboardRows([p3.id], NOW);
    assert(
      rows.some((r) => r.profileId === p3.id && r.warningReasons.includes("休眠预警")),
      "dashboard dormant warning on P3",
    );

    console.log("\n--- Isolation extras ---");
    assertEq(
      (await prisma.order.count({ where: { profileId: pSource.id } })),
      0,
      "merged source has zero orders (no double count)",
    );

    // 终态导入会话：healer 必须 no-op（GET 已不调 healer；此处防误调用/commit 旁路）
    console.log("\n--- Terminal import session heal is no-op ---");
    const { healLegacyConfirmedImportRows, SESSION_STATUS, ROW_STATUS } = await import(
      "../src/lib/orders/import-session"
    );
    const terminalSess = await prisma.orderImportSession.create({
      data: {
        source: "PINGOODMICE",
        category: "PRODUCT",
        status: SESSION_STATUS.COMMITTED,
        fileName: `${PREFIX}-terminal.csv`,
        createdById: admin.id,
      },
    });
    // 终态会话 + 无确认 ID 的历史行：若 healer 在终态仍写库，会改 reviewStatus / 写入 ID。
    const terminalRow = await prisma.orderImportRow.create({
      data: {
        sessionId: terminalSess.id,
        rowNo: 1,
        rawPayloadJson: "{}",
        normalizedPayloadJson: "{}",
        reviewStatus: ROW_STATUS.CONFIRMED_EXISTING,
        confirmedProfileId: null,
        decisionType: "PICK_EXISTING",
        finalError: null,
      },
    });
    const beforeHeal = await prisma.orderImportRow.findUnique({
      where: { id: terminalRow.id },
      select: {
        reviewStatus: true,
        confirmedProfileId: true,
        decisionType: true,
        finalError: true,
      },
    });
    const healResult = await healLegacyConfirmedImportRows(terminalSess.id, prisma);
    assertEq(healResult.backfilled, 0, "terminal heal backfilled=0");
    assertEq(healResult.demoted, 0, "terminal heal demoted=0");
    const afterHeal = await prisma.orderImportRow.findUnique({
      where: { id: terminalRow.id },
      select: {
        reviewStatus: true,
        confirmedProfileId: true,
        decisionType: true,
        finalError: true,
      },
    });
    assertEq(afterHeal?.reviewStatus, beforeHeal?.reviewStatus, "terminal row reviewStatus unchanged");
    assertEq(afterHeal?.confirmedProfileId, beforeHeal?.confirmedProfileId, "terminal row confirmedProfileId unchanged");
    assertEq(afterHeal?.decisionType, beforeHeal?.decisionType, "terminal row decisionType unchanged");
    assertEq(afterHeal?.finalError, beforeHeal?.finalError, "terminal row finalError unchanged");
  });

  console.log(`\n结果: ${pass} pass / ${fail} fail`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * Wave R4：代表运营修复固定回归（临时库，逻辑级）
 *
 * 直接导入生产 helper，不复制实现。
 * Usage: npx tsx scripts/smoke-test-rep-ops-r4-regress.ts
 */

import { withTempSmokeDb } from "./lib/temp-smoke-db";

const PREFIX = `R4-REP-${Date.now().toString(36)}`;
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
  assert(
    actual === expected,
    `${msg} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`,
  );
}

async function main() {
  console.log("=== Wave R4 rep-ops regression ===");
  console.log(`PREFIX=${PREFIX}`);

  await withTempSmokeDb(async (handle) => {
    handle.assertSafePath();

    const { prisma } = await import("../src/lib/prisma");
    const { REPRESENTATIVE_KIND } = await import("../src/lib/crm/system-representative");
    const { buildRepresentativePerformanceScope } = await import(
      "../src/lib/crm/representative-performance"
    );
    const { loadRepresentativeOpsFacts, loadRepresentativeOpsFactsBatch } = await import(
      "../src/lib/crm/representative-ops-facts"
    );
    const {
      getBusinessWeekWindow,
      formatShanghaiDate,
      BUSINESS_TIME_ZONE,
    } = await import("../src/lib/business-time");
    const { centsToYuan } = await import("../src/lib/finance/money");
    const {
      checkinHappenedAt,
      getLastCheckinHappenedAtByProfileIds,
      getLastCheckinHappenedAtByUserAndProfile,
      getRecentScopedCheckinIds,
    } = await import("../src/lib/crm/checkin-event-time");
    const { syncEffectiveRepresentativeLinksForOrganization } = await import(
      "../src/lib/crm/customer-representative-sync"
    );

    const now = new Date("2026-07-17T15:00:00+08:00");
    const d30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const thresholdDate = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);

    // ── Actors ──────────────────────────────────────────────────────
    const admin = await prisma.user.create({
      data: {
        email: `${PREFIX}-admin@test.local`,
        name: "R4 Admin",
        password: "x",
        role: "ADMIN",
      },
    });
    const userA = await prisma.user.create({
      data: {
        email: `${PREFIX}-rep-a@test.local`,
        name: "R4 Rep A",
        password: "x",
        role: "REPRESENTATIVE",
      },
    });
    const userB = await prisma.user.create({
      data: {
        email: `${PREFIX}-rep-b@test.local`,
        name: "R4 Rep B",
        password: "x",
        role: "REPRESENTATIVE",
      },
    });
    const repA = await prisma.representative.create({
      data: { name: "R4 Rep A", email: userA.email, kind: REPRESENTATIVE_KIND.HUMAN },
    });
    const repB = await prisma.representative.create({
      data: { name: "R4 Rep B", email: userB.email, kind: REPRESENTATIVE_KIND.HUMAN },
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

    // ── 1) 金额 helper ──────────────────────────────────────────────
    console.log("\n--- Amount cents (shared helper) ---");
    assertEq(centsToYuan(12345), 123.45, "centsToYuan(12345)=123.45");
    assertEq(
      new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(centsToYuan(12345)),
      "¥123.45",
      "display helper formats 12345 cents as ¥123.45",
    );
    assertEq(BUSINESS_TIME_ZONE, "Asia/Shanghai", "business TZ constant");

    // ── 2) Profiles + pagination stability ──────────────────────────
    console.log("\n--- Pagination stability ---");
    const PROFILE_COUNT = 55;
    const fixedUpdatedAt = new Date("2026-07-01T00:00:00+08:00");
    const profileIdsA: string[] = [];
    for (let i = 0; i < PROFILE_COUNT; i++) {
      const p = await prisma.crmCustomerProfile.create({
        data: {
          customerCode: `${PREFIX}-A-${String(i).padStart(3, "0")}`,
          name: `${PREFIX} Customer A ${i}`,
          organizationId: orgA.id,
          organization: orgA.canonicalName,
          ownerUserId: userA.id,
          stage: "ACTIVE",
          assignmentStatus: "ASSIGNED",
          assignedAt: now,
          deleted: false,
          archived: false,
          updatedAt: fixedUpdatedAt,
        },
      });
      profileIdsA.push(p.id);
    }
    // force same updatedAt (create may ignore)
    await prisma.crmCustomerProfile.updateMany({
      where: { id: { in: profileIdsA } },
      data: { updatedAt: fixedUpdatedAt },
    });

    const profileB = await prisma.crmCustomerProfile.create({
      data: {
        customerCode: `${PREFIX}-B-001`,
        name: `${PREFIX} Customer B`,
        organizationId: orgB.id,
        organization: orgB.canonicalName,
        ownerUserId: userB.id,
        stage: "ACTIVE",
        assignmentStatus: "ASSIGNED",
        assignedAt: now,
      },
    });
    const profileRecalled = await prisma.crmCustomerProfile.create({
      data: {
        customerCode: `${PREFIX}-R-001`,
        name: `${PREFIX} Recalled`,
        organizationId: orgA.id,
        organization: orgA.canonicalName,
        ownerUserId: userA.id,
        stage: "LEAD",
        assignmentStatus: "RECALLED",
      },
    });

    const scopeA = await buildRepresentativePerformanceScope(repA.id);
    assertEq(scopeA.profileIds.length, PROFILE_COUNT, `scopeA=${PROFILE_COUNT}`);
    assert(!scopeA.profileIds.includes(profileB.id), "scopeA excludes B");
    assert(!scopeA.profileIds.includes(profileRecalled.id), "scopeA excludes RECALLED");

    // 候选并集不得漏掉 owner 路径结果（与全量 ASSIGNED 解析后的 owned 集一致）
    const { collectCandidateProfileIdsForRepresentative } = await import(
      "../src/lib/crm/representative-performance"
    );
    const { resolveEffectiveRepresentativesForProfiles } = await import(
      "../src/lib/crm/customer-effective-representative"
    );
    const candidates = await collectCandidateProfileIdsForRepresentative(repA.id, userA.id);
    assert(candidates.length >= PROFILE_COUNT, "candidate superset covers owned profiles");
    assert(
      !candidates.includes(profileRecalled.id),
      "RECALLED profile not in active candidate set",
    );
    // full scan owned set for equivalence
    const allAssigned = (
      await prisma.crmCustomerProfile.findMany({
        where: { archived: false, deleted: false, assignmentStatus: "ASSIGNED" },
        select: { id: true },
      })
    ).map((p) => p.id);
    const fullMap = await resolveEffectiveRepresentativesForProfiles(allAssigned);
    const fullOwned = allAssigned
      .filter((id) => fullMap.get(id)?.representativeId === repA.id)
      .sort();
    assertEq(
      [...scopeA.profileIds].sort().join(","),
      fullOwned.join(","),
      "candidate-narrowed scope equals full-scan owned set",
    );

    const pageSize = 50;
    const orderBy = [{ updatedAt: "desc" as const }, { id: "asc" as const }];
    const page1 = await prisma.crmCustomerProfile.findMany({
      where: { id: { in: scopeA.profileIds } },
      orderBy,
      skip: 0,
      take: pageSize,
      select: { id: true },
    });
    const page2 = await prisma.crmCustomerProfile.findMany({
      where: { id: { in: scopeA.profileIds } },
      orderBy,
      skip: pageSize,
      take: pageSize,
      select: { id: true },
    });
    const page1b = await prisma.crmCustomerProfile.findMany({
      where: { id: { in: scopeA.profileIds } },
      orderBy,
      skip: 0,
      take: pageSize,
      select: { id: true },
    });
    const ids1 = page1.map((p) => p.id);
    const ids2 = page2.map((p) => p.id);
    assertEq(page1.length, 50, "page1=50");
    assertEq(page2.length, 5, "page2=5");
    assert(new Set(ids1).size === ids1.length, "page1 no internal dup");
    assert(ids1.every((id) => !ids2.includes(id)), "page1/page2 no overlap");
    assertEq(new Set([...ids1, ...ids2]).size, PROFILE_COUNT, "union=total");
    assertEq(ids1.join(","), page1b.map((p) => p.id).join(","), "stable page1 order");

    // ── 3) Ops facts: cross-scope / orphan tasks ────────────────────
    console.log("\n--- Ops facts scope ---");
    const fixedDue = new Date("2026-07-01T00:00:00+08:00");
    for (let i = 0; i < 25; i++) {
      await prisma.crmFollowUpTask.create({
        data: {
          profileId: profileIdsA[i % profileIdsA.length],
          ownerUserId: userA.id,
          createdByUserId: admin.id,
          title: `${PREFIX} task ${i}`,
          dueAt: fixedDue,
          status: "OPEN",
        },
      });
    }
    // orphan: owner=A profile=B
    await prisma.crmFollowUpTask.create({
      data: {
        profileId: profileB.id,
        ownerUserId: userA.id,
        createdByUserId: admin.id,
        title: `${PREFIX} orphan overdue`,
        dueAt: new Date("2026-01-01T00:00:00+08:00"),
        status: "OPEN",
      },
    });

    // communication task orphan: owner A, profile B, sourceType in communication set
    await prisma.crmFollowUpTask.create({
      data: {
        profileId: profileB.id,
        ownerUserId: userA.id,
        createdByUserId: admin.id,
        title: `${PREFIX} orphan comm task`,
        dueAt: new Date("2026-07-01T00:00:00+08:00"),
        status: "OPEN",
        sourceType: "PROJECT_TICKET",
      },
    });

    // in-scope checkin (older)
    const inScopeAt = new Date("2026-07-15T10:00:00+08:00");
    await prisma.crmVisitCheckin.create({
      data: {
        profileId: profileIdsA[0],
        userId: userA.id,
        status: "COMPLETED",
        addressSnapshot: "in-scope",
        completedAt: inScopeAt,
        createdAt: inScopeAt,
      },
    });
    // cross-scope checkin A on B — NEWER; must NOT become A's lastCheckinAt
    const crossAt = new Date("2026-07-17T12:00:00+08:00");
    await prisma.crmVisitCheckin.create({
      data: {
        profileId: profileB.id,
        userId: userA.id,
        status: "COMPLETED",
        addressSnapshot: "cross",
        completedAt: crossAt,
        createdAt: crossAt,
      },
    });
    // RECALLED checkin
    await prisma.crmVisitCheckin.create({
      data: {
        profileId: profileRecalled.id,
        userId: userA.id,
        status: "COMPLETED",
        addressSnapshot: "recalled",
        completedAt: now,
      },
    });

    // COALESCE sort fixture: old completedAt, newer null completedAt
    const olderCompleted = await prisma.crmVisitCheckin.create({
      data: {
        profileId: profileIdsA[2],
        userId: userA.id,
        status: "COMPLETED",
        addressSnapshot: "older-completed",
        completedAt: new Date("2026-07-10T10:00:00+08:00"),
        createdAt: new Date("2026-07-10T09:00:00+08:00"),
      },
    });
    const newerNullCompleted = await prisma.crmVisitCheckin.create({
      data: {
        profileId: profileIdsA[2],
        userId: userA.id,
        status: "COMPLETED",
        addressSnapshot: "newer-null-completed",
        completedAt: null,
        createdAt: new Date("2026-07-16T12:00:00+08:00"),
      },
    });

    const subjects = [
      {
        representativeId: repA.id,
        linkedUserId: userA.id,
        profileIds: scopeA.profileIds,
      },
      {
        representativeId: repB.id,
        linkedUserId: userB.id,
        profileIds: (await buildRepresentativePerformanceScope(repB.id)).profileIds,
      },
    ];
    const factsMap = await loadRepresentativeOpsFactsBatch(subjects, {
      from: d30,
      to: now,
      now,
      longUnvisitedThresholdDate: thresholdDate,
    });
    const factsA = factsMap.get(repA.id)!;
    const factsB = factsMap.get(repB.id)!;

    assertEq(factsA.openFollowUps, 25, "A open follow-ups scope only");
    assert(factsA.orphanedOpenFollowUpCount >= 1, "A orphan task counted separately");
    assertEq(factsA.overdueFollowUps, 25, "A overdue only in-scope (fixed due past)");
    assertEq(factsB.overdueFollowUps, 0, "B does not take A orphan task");
    assertEq(factsB.openFollowUps, 0, "B open=0");
    assertEq(factsB.dueCommunicationTaskCount, 0, "B dueCommunication ignores owner-A orphan");
    assertEq(factsB.overdueCommunicationTaskCount, 0, "B overdueCommunication ignores owner-A orphan");

    // 沟通任务：owner=A profile=B 不计入 B 的沟通 KPI（facts 在后面加载；此处先建夹具）
    // （夹具已在 open task orphan 创建；communication task 需 sourceType）
    assert(factsA.visitCheckinCount >= 1, "A visit count includes in-scope");
    // cross-scope 最新签到不得成为 A 的 lastCheckinAt
    const expectedInScopeLast = checkinHappenedAt({
      completedAt: null,
      createdAt: new Date("2026-07-16T12:00:00+08:00"),
    });
    assert(!!factsA.lastCheckinAt, "A lastCheckinAt present");
    assertEq(
      factsA.lastCheckinAt!.toISOString(),
      expectedInScopeLast.toISOString(),
      "A lastCheckinAt ignores newer cross-scope checkin",
    );
    assert(
      factsA.lastCheckinAt!.getTime() !== crossAt.getTime(),
      "A lastCheckinAt != crossAt",
    );

    const lastByProfile = await getLastCheckinHappenedAtByProfileIds([profileIdsA[2]]);
    const lastOnP2 = lastByProfile.get(profileIdsA[2])!;
    assertEq(
      lastOnP2.toISOString(),
      expectedInScopeLast.toISOString(),
      "COALESCE last checkin prefers newer null-completedAt",
    );
    const pairs = await getLastCheckinHappenedAtByUserAndProfile({
      userIds: [userA.id],
      profileIds: [...scopeA.profileIds, profileB.id],
    });
    const maxInScope = pairs
      .filter((p) => p.userId === userA.id && scopeA.profileIds.includes(p.profileId))
      .sort((a, b) => b.happenedAt.getTime() - a.happenedAt.getTime())[0];
    assert(!!maxInScope, "in-scope user/profile pair exists");
    assert(maxInScope.profileId !== profileB.id, "max in-scope pair not cross profile");

    // 超过旧 take:80 窗口：写入 90 条更旧签到 + 1 条最新，top-1 必须是最新
    for (let i = 0; i < 90; i++) {
      await prisma.crmVisitCheckin.create({
        data: {
          profileId: profileIdsA[3],
          userId: userA.id,
          status: "COMPLETED",
          addressSnapshot: `old-${i}`,
          completedAt: new Date(`2026-06-01T00:${String(i % 60).padStart(2, "0")}:00+08:00`),
          createdAt: new Date(`2026-06-01T00:${String(i % 60).padStart(2, "0")}:00+08:00`),
        },
      });
    }
    const newest = await prisma.crmVisitCheckin.create({
      data: {
        profileId: profileIdsA[3],
        userId: userA.id,
        status: "COMPLETED",
        addressSnapshot: "newest-beyond-80",
        completedAt: new Date("2026-07-16T18:00:00+08:00"),
        createdAt: new Date("2026-07-16T18:00:00+08:00"),
      },
    });
    const recentIds = await getRecentScopedCheckinIds({
      userId: userA.id,
      profileIds: scopeA.profileIds,
      take: 20,
    });
    assert(recentIds.length >= 1, "recent scoped checkin ids non-empty");
    assertEq(recentIds[0], newest.id, "top-N returns true newest beyond old take:80 window");
    // top-N must not include cross/recalled ids: verify by loading rows
    const recentRows = await prisma.crmVisitCheckin.findMany({
      where: { id: { in: recentIds } },
      select: { id: true, profileId: true },
    });
    assert(
      recentRows.every((r) => scopeA.profileIds.includes(r.profileId)),
      "recent ids all in scope",
    );

    // 无 linked user：行为指标 0，客户数仍保留
    const unlinkedFacts = await loadRepresentativeOpsFacts(
      {
        representativeId: repA.id,
        linkedUserId: null,
        profileIds: scopeA.profileIds,
      },
      {
        from: d30,
        to: now,
        now,
        longUnvisitedThresholdDate: thresholdDate,
      },
    );
    assertEq(unlinkedFacts.customerCount, PROFILE_COUNT, "unlinked customerCount preserved");
    assertEq(unlinkedFacts.visitCheckinCount, 0, "unlinked visit=0");
    assertEq(unlinkedFacts.overdueFollowUps, 0, "unlinked overdue=0");
    assertEq(unlinkedFacts.openFollowUps, 0, "unlinked open=0");

    // list/detail consistency via same helper（在全部签到夹具写完后重算）
    const factsAFinal = await loadRepresentativeOpsFactsBatch(subjects, {
      from: d30,
      to: now,
      now,
      longUnvisitedThresholdDate: thresholdDate,
    });
    const factsA2 = await loadRepresentativeOpsFacts(subjects[0], {
      from: d30,
      to: now,
      now,
      longUnvisitedThresholdDate: thresholdDate,
    });
    assertEq(
      factsA2.overdueFollowUps,
      factsAFinal.get(repA.id)!.overdueFollowUps,
      "single=batch overdue",
    );
    assertEq(
      factsA2.visitCheckinCount,
      factsAFinal.get(repA.id)!.visitCheckinCount,
      "single=batch visit",
    );
    assertEq(
      factsA2.communicatedCustomerCount,
      factsAFinal.get(repA.id)!.communicatedCustomerCount,
      "single=batch communicated",
    );

    // ── 4) Business week TZ independent ─────────────────────────────
    console.log("\n--- Business week Asia/Shanghai ---");
    // 业务周 = 周一 00:00 ~ 下周一 00:00；周日 23:59 仍属当周，跨到次日周一才换周
    const monday = new Date("2026-07-13T00:00:00+08:00");
    const sundaySameWeek = new Date("2026-07-19T23:59:59+08:00");
    const sundayPrev = new Date("2026-07-12T23:59:59+08:00");
    const wMon = getBusinessWeekWindow(monday);
    const wSunSame = getBusinessWeekWindow(sundaySameWeek);
    const wSunPrev = getBusinessWeekWindow(sundayPrev);
    assertEq(wMon.periodKey, "2026-07-13", "Mon 00:00+08 week key");
    assertEq(wSunSame.periodKey, "2026-07-13", "Sun 23:59 same week shares Monday key");
    assertEq(wSunPrev.periodKey, "2026-07-06", "prev Sun still previous week");
    assertEq(wMon.periodStartDate, wSunSame.periodStartDate, "Mon/Sun same start date");
    assertEq(wMon.start.toISOString(), wSunSame.start.toISOString(), "Mon/Sun same UTC start");
    assertEq(formatShanghaiDate(wMon.start), "2026-07-13", "formatShanghaiDate start");
    assertEq(wMon.periodEndDate, "2026-07-20", "end next Monday");

    // ── 5) Sync awaitable ───────────────────────────────────────────
    console.log("\n--- Sync await ---");
    const n = await syncEffectiveRepresentativeLinksForOrganization({
      organizationId: "non-existent-org",
      organizationSiteId: null,
    });
    assertEq(n, 0, "missing org sync=0");

    // task pagination stability with same dueAt
    const fuWhere = {
      ownerUserId: userA.id,
      status: "OPEN" as const,
      profileId: { in: scopeA.profileIds },
    };
    const fu1 = await prisma.crmFollowUpTask.findMany({
      where: fuWhere,
      orderBy: [{ dueAt: "asc" }, { id: "asc" }],
      skip: 0,
      take: 20,
      select: { id: true },
    });
    const fu2 = await prisma.crmFollowUpTask.findMany({
      where: fuWhere,
      orderBy: [{ dueAt: "asc" }, { id: "asc" }],
      skip: 20,
      take: 20,
      select: { id: true },
    });
    assertEq(fu1.length, 20, "fu page1=20");
    assertEq(fu2.length, 5, "fu page2=5");
    assert(fu1.every((t) => !fu2.some((x) => x.id === t.id)), "fu pages no overlap");

    // silence unused fixture refs
    assert(!!olderCompleted.id && !!newerNullCompleted.id, "coalesce fixtures created");
  });

  console.log(`\n=== Result: ${pass} passed, ${fail} failed ===`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

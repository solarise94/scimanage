/**
 * Smoke: W4 Profile-only merge coverage (P1/P2 review gaps).
 *
 * Covers:
 *  1. Profile-only source → anchored target
 *  2. Anchored source → Profile-only target
 *  3. Duplicate relation conflict (P2002) → deleted snapshot → reverse recreate
 *  4. Secondary refs (CostEntry / ProgressReceivableAdjustment) migrate by profileId
 *  5. KEEP_SOURCE owner preserved (not overwritten by org sync)
 *  6. W6.8：S5=preflight 冻结目标拒绝；S6=`afterPreflight` seam 命中事务内冻结竞态
 *
 * 运行在 withTempSmokeDb 临时库（严禁写 prisma/dev.db）。
 * Phase E contract：Customer 锚点模型与全部旧 `*CustomerId*` 列已删除，
 * 原 anchored 夹具 / 锚点 lifecycle 断言 / 待删列 null 断言均已随列移除，
 * 全部夹具 Profile-only（预期通过数 56 → 45）。
 *
 * Usage: npx tsx scripts/smoke-test-customer-merge-profile-only.ts
 */

import { withTempSmokeDb } from "./lib/temp-smoke-db";

const PREFIX = `SMOKE-PO-${Date.now().toString(36)}`;
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
  await withTempSmokeDb(async (handle) => {
    handle.assertSafePath();

    const { prisma } = await import("../src/lib/prisma");
    const { executeMerge, reverseMerge } = await import("../src/lib/customers/customer-merge");

    const admin = await prisma.user.create({
      data: {
        email: `${PREFIX}-admin@test.local`,
        name: "Merge PO Admin",
        password: "x",
        role: "ADMIN",
      },
    });
    // Two owners: KEEP_SOURCE should keep ownerUserSource, not org-binding overwrite.
    const ownerUserSource = await prisma.user.create({
      data: {
        email: `${PREFIX}-owner@test.local`,
        name: "Merge PO Owner",
        password: "x",
        role: "USER",
      },
    });
    const ownerSourceId = ownerUserSource.id;
    const ownerTargetId = admin.id;

    const org = await prisma.organization.create({
      data: {
        orgCode: `${PREFIX}-ORG`,
        canonicalName: `${PREFIX} 测试机构`,
        normalizedName: `${PREFIX}-test-org`,
        isInvoiceSubject: true,
        taxId: `${PREFIX}TAX`,
      },
    });

    // ── Scenario 1: Profile-only source → Profile-only target ──
    console.log("\n--- Scenario 1: Profile-only source → Profile-only target ---");
    const profileOnlySource = await prisma.crmCustomerProfile.create({
      data: {
        customerCode: `${PREFIX}-S1`,
        name: `${PREFIX} 仅档案甲`,
        organizationId: org.id,
        organization: org.canonicalName,
        ownerUserId: ownerSourceId,
        stage: "CONTACTED",
      },
    });
    const anchoredTarget1 = await prisma.crmCustomerProfile.create({
      data: {
        customerCode: `${PREFIX}-T1`,
        name: `${PREFIX} 锚点乙`,
        organizationId: org.id,
        organization: org.canonicalName,
        ownerUserId: ownerTargetId,
        stage: "FOLLOWING",
      },
    });

    const orderOnOnly = await prisma.order.create({
      data: {
        orderNo: `${PREFIX}-ORD1`,
        title: `${PREFIX} PO order`,
        totalAmount: 1000,
        profileId: profileOnlySource.id,
        status: "CONFIRMED",
        source: "MANUAL",
        category: "SERVICE",
        createdById: admin.id,
        customerMatchStatus: "UNMATCHED",
      },
    });
    const costOnOnly = await prisma.costEntry.create({
      data: {
        subjectType: "CUSTOMER",
        profileId: profileOnlySource.id,
        bucket: "REAL",
        costType: "OTHER",
        status: "ACTUAL",
        amount: 500,
        createdById: admin.id,
        sourceType: "MANUAL",
        sourceKey: `${PREFIX}-cost1`,
      },
    });

    const merge1 = await executeMerge(
      profileOnlySource.id,
      anchoredTarget1.id,
      "KEEP_SOURCE",
      "KEEP_TARGET_ORG",
      admin.id,
    );

    const orderAfter1 = await prisma.order.findUnique({ where: { id: orderOnOnly.id } });
    assert(orderAfter1?.profileId === anchoredTarget1.id, "S1 order migrated to target profile");
    const costAfter1 = await prisma.costEntry.findUnique({ where: { id: costOnOnly.id } });
    assert(costAfter1?.profileId === anchoredTarget1.id, "S1 costEntry migrated by profileId");
    const srcAfter1 = await prisma.crmCustomerProfile.findUnique({ where: { id: profileOnlySource.id } });
    assert(srcAfter1?.mergedIntoProfileId === anchoredTarget1.id, "S1 source mergedIntoProfileId set");
    assert(srcAfter1?.deleted === true, "S1 source deleted");

    const tgtOwner1 = await prisma.crmCustomerProfile.findUnique({
      where: { id: anchoredTarget1.id },
      select: { ownerUserId: true },
    });
    assert(tgtOwner1?.ownerUserId === ownerSourceId, "S1 KEEP_SOURCE preserves source owner on target");

    await reverseMerge(merge1.mergeLogId, admin.id, "s1 reverse");
    const orderRev1 = await prisma.order.findUnique({ where: { id: orderOnOnly.id } });
    assert(orderRev1?.profileId === profileOnlySource.id, "S1 reverse restores order profileId");
    const costRev1 = await prisma.costEntry.findUnique({ where: { id: costOnOnly.id } });
    assert(costRev1?.profileId === profileOnlySource.id, "S1 reverse restores cost profileId");
    const srcRev1 = await prisma.crmCustomerProfile.findUnique({ where: { id: profileOnlySource.id } });
    assert(srcRev1?.deleted === false && srcRev1?.mergedIntoProfileId === null, "S1 source lifecycle restored");
    assert(srcRev1?.ownerUserId === ownerSourceId, "S1 source owner restored");
    assert(srcRev1?.customerCode === `${PREFIX}-S1`, "S1 KEEP_SOURCE reverse restores source customerCode");
    const tgtRev1 = await prisma.crmCustomerProfile.findUnique({ where: { id: anchoredTarget1.id } });
    assert(tgtRev1?.customerCode === `${PREFIX}-T1`, "S1 KEEP_SOURCE reverse restores target customerCode");

    // stage history + application on source
    const stage1 = await prisma.crmCustomerStageHistory.create({
      data: {
        profileId: profileOnlySource.id,
        nextStage: "CONTACTED",
        reason: `${PREFIX} stage`,
      },
    });
    const app1 = await prisma.crmCustomerApplication.create({
      data: {
        name: `${PREFIX} 申请甲`,
        organization: org.canonicalName,
        status: "APPROVED",
        createdCrmProfileId: profileOnlySource.id,
        submittedByUserId: admin.id,
      },
    });
    // Remerge briefly to verify app/stage migrate+reverse cleanly
    const merge1b = await executeMerge(
      profileOnlySource.id,
      anchoredTarget1.id,
      "KEEP_TARGET",
      "KEEP_TARGET_ORG",
      admin.id,
    );
    const stageAfter = await prisma.crmCustomerStageHistory.findUnique({ where: { id: stage1.id } });
    assert(stageAfter?.profileId === anchoredTarget1.id, "S1b stageHistory migrated to target profile");
    const appAfter = await prisma.crmCustomerApplication.findUnique({ where: { id: app1.id } });
    assert(appAfter?.createdCrmProfileId === anchoredTarget1.id, "S1b application createdCrmProfileId migrated");
    await reverseMerge(merge1b.mergeLogId, admin.id, "s1b reverse");
    const stageRev = await prisma.crmCustomerStageHistory.findUnique({ where: { id: stage1.id } });
    assert(stageRev?.profileId === profileOnlySource.id, "S1b stage reverse profile-only");
    const appRev = await prisma.crmCustomerApplication.findUnique({ where: { id: app1.id } });
    assert(appRev?.createdCrmProfileId === profileOnlySource.id, "S1b app reverse profile-only");

    // ── Scenario 2: Profile-only source → Profile-only target（adjustment 迁移）──
    console.log("\n--- Scenario 2: Profile-only source → Profile-only target ---");
    const anchoredSource2 = await prisma.crmCustomerProfile.create({
      data: {
        customerCode: `${PREFIX}-S2`,
        name: `${PREFIX} 锚点丙`,
        organizationId: org.id,
        organization: org.canonicalName,
        ownerUserId: ownerSourceId,
        stage: "LEAD",
      },
    });
    const profileOnlyTarget2 = await prisma.crmCustomerProfile.create({
      data: {
        customerCode: `${PREFIX}-T2`,
        name: `${PREFIX} 仅档案丁`,
        organizationId: org.id,
        organization: org.canonicalName,
        ownerUserId: ownerTargetId,
        stage: "ACTIVE",
      },
    });

    const orderForAdj = await prisma.order.create({
      data: {
        orderNo: `${PREFIX}-ORD2`,
        title: `${PREFIX} adj order`,
        totalAmount: 2000,
        profileId: anchoredSource2.id,
        status: "CONFIRMED",
        source: "MANUAL",
        category: "SERVICE",
        createdById: admin.id,
      },
    });
    const revision = await prisma.orderRevision.create({
      data: {
        orderId: orderForAdj.id,
        revisionNo: 1,
        oldTotalAmount: 2000,
        newTotalAmount: 2100,
        deltaTotalAmount: 100,
        oldFinanceAmount: 2000,
        newFinanceAmount: 2100,
        deltaFinanceAmount: 100,
        effectivePeriod: `${PREFIX}-P`,
        reason: `${PREFIX} adj`,
        createdById: admin.id,
      },
    });
    const adj = await prisma.progressReceivableAdjustment.create({
      data: {
        sourceType: "ORDER_REVISION",
        sourceId: revision.id,
        profileId: anchoredSource2.id,
        periodKey: `${PREFIX}-P`,
        amount: 100,
        category: "SERVICE",
        createdById: admin.id,
      },
    });

    const merge2 = await executeMerge(
      anchoredSource2.id,
      profileOnlyTarget2.id,
      "KEEP_TARGET",
      "KEEP_TARGET_ORG",
      admin.id,
    );

    const adjAfter = await prisma.progressReceivableAdjustment.findUnique({ where: { id: adj.id } });
    assert(adjAfter?.profileId === profileOnlyTarget2.id, "S2 adjustment migrated to Profile-only target");
    await reverseMerge(merge2.mergeLogId, admin.id, "s2 reverse");
    const adjRev = await prisma.progressReceivableAdjustment.findUnique({ where: { id: adj.id } });
    assert(adjRev?.profileId === anchoredSource2.id, "S2 reverse restores adjustment profileId");

    // ── Scenario 3: Duplicate relation conflict + reverse recreate ──
    console.log("\n--- Scenario 3: Relation P2002 conflict + reverse recreate ---");
    const partner = await prisma.crmCustomerProfile.create({
      data: {
        customerCode: `${PREFIX}-P3`,
        name: `${PREFIX} 伙伴`,
        organizationId: org.id,
        organization: org.canonicalName,
        ownerUserId: admin.id,
        stage: "LEAD",
      },
    });
    const src3 = await prisma.crmCustomerProfile.create({
      data: {
        customerCode: `${PREFIX}-S3`,
        name: `${PREFIX} 冲突源`,
        organizationId: org.id,
        organization: org.canonicalName,
        ownerUserId: admin.id,
        stage: "LEAD",
      },
    });
    const tgt3 = await prisma.crmCustomerProfile.create({
      data: {
        customerCode: `${PREFIX}-T3`,
        name: `${PREFIX} 冲突目标`,
        organizationId: org.id,
        organization: org.canonicalName,
        ownerUserId: admin.id,
        stage: "LEAD",
      },
    });

    // Both src→partner and tgt→partner same type → migrating src→tgt causes unique conflict
    const edgeSrc = await prisma.customerRelation.create({
      data: {
        fromProfileId: src3.id,
        toProfileId: partner.id,
        type: "COLLABORATION",
        notes: `${PREFIX} src-edge`,
        createdByUserId: admin.id,
      },
    });
    await prisma.customerRelation.create({
      data: {
        fromProfileId: tgt3.id,
        toProfileId: partner.id,
        type: "COLLABORATION",
        notes: `${PREFIX} tgt-edge`,
        createdByUserId: admin.id,
      },
    });

    const merge3 = await executeMerge(src3.id, tgt3.id, "KEEP_TARGET", "KEEP_TARGET_ORG", admin.id);
    const stored = JSON.parse(
      (await prisma.customerMergeLog.findUnique({ where: { id: merge3.mergeLogId } }))!.migratedIdsJson,
    ) as { customerRelations?: { deleted?: Array<{ id: string; notes?: string | null }> } };
    assert(
      Array.isArray(stored.customerRelations?.deleted) && stored.customerRelations!.deleted!.length >= 1,
      "S3 conflict edge stored in customerRelations.deleted snapshot",
    );
    const edgeAfterDelete = await prisma.customerRelation.findUnique({ where: { id: edgeSrc.id } });
    assert(edgeAfterDelete === null, "S3 conflicting source edge deleted (not left dangling)");

    await reverseMerge(merge3.mergeLogId, admin.id, "s3 reverse");
    const recreated = await prisma.customerRelation.findFirst({
      where: {
        fromProfileId: src3.id,
        toProfileId: partner.id,
        type: "COLLABORATION",
      },
    });
    assert(!!recreated, "S3 reverse recreates deleted conflicting relation on source");

    // ── Scenario 4: source→target direct relation P2002，撤销不得改成 source→source ──
    console.log("\n--- Scenario 4: source→target relation conflict restore ---");
    const src4 = await prisma.crmCustomerProfile.create({
      data: {
        customerCode: `${PREFIX}-S4`,
        name: `${PREFIX} 直连源`,
        organizationId: org.id,
        organization: org.canonicalName,
        ownerUserId: admin.id,
        stage: "LEAD",
      },
    });
    const tgt4 = await prisma.crmCustomerProfile.create({
      data: {
        customerCode: `${PREFIX}-T4`,
        name: `${PREFIX} 直连目标`,
        organizationId: org.id,
        organization: org.canonicalName,
        ownerUserId: admin.id,
        stage: "LEAD",
      },
    });
    // 评审用例：原关系 source→target，合并迁入变成 target→target 自环撞 unique 被删，
    // 快照须保留合并前 from=source,to=target 端点，撤销后应仍是 source→target。
    const edgeSrcTgt = await prisma.customerRelation.create({
      data: {
        fromProfileId: src4.id,
        toProfileId: tgt4.id,
        type: "INTRODUCTION",
        notes: `${PREFIX} src→tgt`,
        createdByUserId: admin.id,
      },
    });
    // 人为造 P2002：目标预先有 from=tgt,to=tgt 同 type（SQLite 允许自环）。
    await prisma.customerRelation.create({
      data: {
        fromProfileId: tgt4.id,
        toProfileId: tgt4.id,
        type: "INTRODUCTION",
        notes: `${PREFIX} tgt self`,
        createdByUserId: admin.id,
      },
    });

    const merge4 = await executeMerge(src4.id, tgt4.id, "KEEP_TARGET", "KEEP_TARGET_ORG", admin.id);
    const stored4 = JSON.parse(
      (await prisma.customerMergeLog.findUnique({ where: { id: merge4.mergeLogId } }))!.migratedIdsJson,
    ) as { customerRelations?: { deleted?: Array<{ fromProfileId: string; toProfileId: string }> } };
    const deleted4 = stored4.customerRelations?.deleted ?? [];
    assert(
      deleted4.some((d) => d.fromProfileId === src4.id && d.toProfileId === tgt4.id),
      "S4 source→target edge captured in deleted snapshot with original endpoints",
    );
    assert((await prisma.customerRelation.findUnique({ where: { id: edgeSrcTgt.id } })) === null, "S4 conflicting edge deleted");

    await reverseMerge(merge4.mergeLogId, admin.id, "s4 reverse");
    const restoredDirect = await prisma.customerRelation.findFirst({
      where: { fromProfileId: src4.id, toProfileId: tgt4.id, type: "INTRODUCTION" },
    });
    assert(!!restoredDirect, "S4 reverse restores source→target (not source→source)");
    assert(
      restoredDirect?.fromProfileId === src4.id && restoredDirect?.toProfileId === tgt4.id,
      "S4 restored endpoints exact: source→target",
    );

    // ── Scenario 5: preflight 冻结目标拒绝（不覆盖事务内竞态；见 S6）──
    console.log("\n--- Scenario 5: preflight frozen target rejects merge ---");
    const frozenSrc = await prisma.crmCustomerProfile.create({
      data: {
        customerCode: `${PREFIX}-S5`,
        name: `${PREFIX} 冻结源`,
        organizationId: org.id,
        organization: org.canonicalName,
        ownerUserId: ownerSourceId,
        stage: "CONTACTED",
        assignmentStatus: "ASSIGNED",
      },
    });
    const orderOnFrozenSrc = await prisma.order.create({
      data: {
        orderNo: `${PREFIX}-ORD5`,
        title: `${PREFIX} frozen-src order`,
        totalAmount: 500,
        profileId: frozenSrc.id,
        status: "CONFIRMED",
        source: "MANUAL",
        category: "SERVICE",
        createdById: admin.id,
        customerMatchStatus: "UNMATCHED",
        representativeId: null,
      },
    });

    for (const [label, status, archived] of [
      ["archived", "ASSIGNED", true],
      ["RECALLED", "RECALLED", false],
      ["RECALL_CANDIDATE", "RECALL_CANDIDATE", false],
    ] as const) {
      const frozenTgt = await prisma.crmCustomerProfile.create({
        data: {
          customerCode: `${PREFIX}-T5-${status}-${archived ? "A" : "N"}`,
          name: `${PREFIX} 冻结目标 ${label}`,
          organizationId: org.id,
          organization: org.canonicalName,
          ownerUserId: ownerTargetId,
          stage: "FOLLOWING",
          assignmentStatus: status,
          archived,
        },
      });
      let threw = false;
      let msg = "";
      try {
        await executeMerge(frozenSrc.id, frozenTgt.id, "KEEP_TARGET", "KEEP_TARGET_ORG", admin.id);
      } catch (e) {
        threw = true;
        msg = e instanceof Error ? e.message : String(e);
      }
      assert(threw, `S5 ${label} preflight rejects merge`);
      assert(
        msg.includes("归档") || msg.includes("收回"),
        `S5 ${label} error mentions freeze reason (got: ${msg})`,
      );
      const orderStill = await prisma.order.findUnique({ where: { id: orderOnFrozenSrc.id } });
      assert(orderStill?.profileId === frozenSrc.id, `S5 ${label}: order stays on source (no partial migrate)`);
    }

    // ── Scenario 6: preflight 通过后冻结 → 事务内复核拒绝（竞态 seam）──
    console.log("\n--- Scenario 6: afterPreflight freeze hits in-tx recheck ---");
    const raceSrc = await prisma.crmCustomerProfile.create({
      data: {
        customerCode: `${PREFIX}-S6`,
        name: `${PREFIX} 竞态源`,
        organizationId: org.id,
        organization: org.canonicalName,
        ownerUserId: ownerSourceId,
        stage: "CONTACTED",
        assignmentStatus: "ASSIGNED",
      },
    });
    const orderOnRaceSrc = await prisma.order.create({
      data: {
        orderNo: `${PREFIX}-ORD6`,
        title: `${PREFIX} race-src order`,
        totalAmount: 700,
        profileId: raceSrc.id,
        status: "CONFIRMED",
        source: "MANUAL",
        category: "SERVICE",
        createdById: admin.id,
        customerMatchStatus: "UNMATCHED",
        representativeId: null,
      },
    });

    for (const [label, patch] of [
      ["archived", { archived: true }],
      ["RECALLED", { assignmentStatus: "RECALLED" }],
      ["RECALL_CANDIDATE", { assignmentStatus: "RECALL_CANDIDATE" }],
    ] as const) {
      const raceTgt = await prisma.crmCustomerProfile.create({
        data: {
          customerCode: `${PREFIX}-T6-${label}`,
          name: `${PREFIX} 竞态目标 ${label}`,
          organizationId: org.id,
          organization: org.canonicalName,
          ownerUserId: ownerTargetId,
          stage: "FOLLOWING",
          assignmentStatus: "ASSIGNED",
          archived: false,
        },
      });
      let threw = false;
      let msg = "";
      try {
        await executeMerge(raceSrc.id, raceTgt.id, "KEEP_TARGET", "KEEP_TARGET_ORG", admin.id, {
          afterPreflight: async () => {
            await prisma.crmCustomerProfile.update({
              where: { id: raceTgt.id },
              data: patch,
            });
          },
        });
      } catch (e) {
        threw = true;
        msg = e instanceof Error ? e.message : String(e);
      }
      assert(threw, `S6 ${label} in-tx recheck rejects merge`);
      assert(
        msg.includes("归档") || msg.includes("收回"),
        `S6 ${label} error from in-tx freeze (got: ${msg})`,
      );
      const orderStill = await prisma.order.findUnique({ where: { id: orderOnRaceSrc.id } });
      assert(orderStill?.profileId === raceSrc.id, `S6 ${label}: order stays on source after in-tx abort`);
      const mergeLog = await prisma.customerMergeLog.findFirst({
        where: { sourceProfileId: raceSrc.id, targetProfileId: raceTgt.id },
      });
      assert(mergeLog === null, `S6 ${label}: no merge log (transaction rolled back)`);
    }
  });

  console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

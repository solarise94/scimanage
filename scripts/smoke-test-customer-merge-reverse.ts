/**
 * Smoke test for E6: merge/reverse repeatability with dual Profile sub-resource migration.
 *
 * Verifies that:
 *  1. executeMerge with dual Profile migrates CrmInteraction, CrmFollowUpTask,
 *     CrmVisitCheckin, CrmCustomerAddress from source to target Profile.
 *  2. reverseMerge restores sub-resources back to source Profile.
 *  3. The merge -> reverse -> merge -> reverse cycle is repeatable.
 *  4. No orphaned sub-resources remain on the archived source Profile after merge.
 *  5. Project.client and CrmRepresentativeReportLine.customerName snapshots are
 *     re-stamped on merge and restored on reverse (high-risk undo paths).
 *
 * 运行在 withTempSmokeDb 临时库（严禁写 prisma/dev.db）。
 * Phase E contract：Customer 锚点模型已删，anchored 夹具与锚点 lifecycle 断言已移除，
 * 全部夹具 Profile-only（预期通过数 30 → 26）。
 *
 * Usage: npx tsx scripts/smoke-test-customer-merge-reverse.ts
 */

import { withTempSmokeDb } from "./lib/temp-smoke-db";

const PREFIX = `SMOKE-MR-${Date.now().toString(36)}`;
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
        name: "Merge Reverse Admin",
        password: "x",
        role: "ADMIN",
      },
    });

    const org = await prisma.organization.create({
      data: {
        orgCode: `${PREFIX}-ORG`,
        canonicalName: `${PREFIX} 测试机构`,
        normalizedName: `${PREFIX}-test-org`,
        isInvoiceSubject: true,
        taxId: `${PREFIX}TAX`,
      },
    });

    // Create CRM profiles for both（Phase E contract：Profile-only，无 Customer 锚点）
    const [profileA, profileB] = await Promise.all([
      prisma.crmCustomerProfile.create({
        data: {
          name: `${PREFIX} 张三`,
          organization: org.canonicalName,
          organizationId: org.id,
          ownerUserId: admin.id,
          stage: "CONTACTED",
          assignmentStatus: "ASSIGNED",
          assignedAt: new Date(),
        },
      }),
      prisma.crmCustomerProfile.create({
        data: {
          name: `${PREFIX} 李四`,
          organization: org.canonicalName,
          organizationId: org.id,
          ownerUserId: admin.id,
          stage: "FOLLOWING",
          assignmentStatus: "ASSIGNED",
          assignedAt: new Date(),
        },
      }),
    ]);

    // Create sub-resources on source profile A
    const interaction = await prisma.crmInteraction.create({
      data: {
        profileId: profileA.id,
        type: "CALL",
        summary: `${PREFIX} 测试沟通`,
        happenedAt: new Date(),
        createdByUserId: admin.id,
      },
    });

    const task = await prisma.crmFollowUpTask.create({
      data: {
        profileId: profileA.id,
        ownerUserId: admin.id,
        title: `${PREFIX} 测试跟进`,
        dueAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        status: "OPEN",
        taskType: "CONTACT",
        createdByUserId: admin.id,
      },
    });

    const checkin = await prisma.crmVisitCheckin.create({
      data: {
        profileId: profileA.id,
        userId: admin.id,
        status: "COMPLETED",
        completedAt: new Date(),
        addressSnapshot: `${PREFIX} 测试地址`,
      },
    });

    const address = await prisma.crmCustomerAddress.create({
      data: {
        profileId: profileA.id,
        addressText: `${PREFIX} 测试地址`,
        sourceType: "MANUAL",
      },
    });

    // Create a Project linked to source profile A with a client snapshot
    const projectOnA = await prisma.project.create({
      data: {
        name: `${PREFIX} 测试项目`,
        profileId: profileA.id,
        client: `${PREFIX} 张三`,
        organization: org.canonicalName,
      },
    });

    // Create a CrmRepresentativeReportLine linked to source profile A
    const rep = await prisma.representative.create({
      data: {
        name: `${PREFIX} 代表`,
        email: `${PREFIX}-rep@test.local`,
      },
    });
    const reportDraft = await prisma.crmRepresentativeReportDraft.create({
      data: {
        representativeId: rep.id,
        periodType: "WEEK",
        periodKey: PREFIX,
        createdByUserId: admin.id,
      },
    });
    const reportLine = await prisma.crmRepresentativeReportLine.create({
      data: {
        reportDraftId: reportDraft.id,
        profileId: profileA.id,
        customerName: `${PREFIX} 张三`,
      },
    });

    // ── Round 1: Merge A -> B ──────────────────────────────────
    console.log("\n--- Round 1: Merge A -> B ---");
    const mergeLog1 = await executeMerge(
      profileA.id,
      profileB.id,
      "KEEP_TARGET",
      "KEEP_TARGET_ORG",
      admin.id,
    );

    // Verify source profile is archived / merge-aliased
    const archivedProfileA = await prisma.crmCustomerProfile.findUnique({ where: { id: profileA.id } });
    assert(archivedProfileA?.archived === true, "Source profile A archived after merge");
    assert(archivedProfileA?.deleted === true, "Source profile A deleted after merge");
    assert(archivedProfileA?.mergedIntoProfileId === profileB.id, "Source profile A mergedIntoProfileId → B");

    // Verify sub-resources migrated to target profile B
    const migratedInteraction = await prisma.crmInteraction.findUnique({ where: { id: interaction.id } });
    assert(migratedInteraction?.profileId === profileB.id, "Interaction migrated to target profile B");

    const migratedTask = await prisma.crmFollowUpTask.findUnique({ where: { id: task.id } });
    assert(migratedTask?.profileId === profileB.id, "Follow-up task migrated to target profile B");

    const migratedCheckin = await prisma.crmVisitCheckin.findUnique({ where: { id: checkin.id } });
    assert(migratedCheckin?.profileId === profileB.id, "Checkin migrated to target profile B");

    const migratedAddress = await prisma.crmCustomerAddress.findUnique({ where: { id: address.id } });
    assert(migratedAddress?.profileId === profileB.id, "Address migrated to target profile B");

    // Verify Project.profileId + client re-stamped
    const mergedProject = await prisma.project.findUnique({ where: { id: projectOnA.id } });
    assert(mergedProject?.profileId === profileB.id, "Project profileId migrated to B");
    assert(mergedProject?.client === `${PREFIX} 李四`, "Project.client re-stamped to target effective name");

    // Verify ReportLine.customerName re-stamped
    const mergedReportLine = await prisma.crmRepresentativeReportLine.findUnique({ where: { id: reportLine.id } });
    assert(mergedReportLine?.profileId === profileB.id, "ReportLine profileId migrated to B");
    assert(mergedReportLine?.customerName === `${PREFIX} 李四`, "ReportLine.customerName re-stamped to target effective name");

    // ── Round 1: Reverse ───────────────────────────────────────
    console.log("\n--- Round 1: Reverse ---");
    await reverseMerge(mergeLog1.mergeLogId, admin.id, "smoke test reverse round 1");

    // Verify source profile is un-archived / un-merged
    const restoredProfileA = await prisma.crmCustomerProfile.findUnique({ where: { id: profileA.id } });
    assert(restoredProfileA?.archived === false, "Source profile A un-archived after reverse");
    assert(restoredProfileA?.deleted === false, "Source profile A undeleted after reverse");
    assert(restoredProfileA?.mergedIntoProfileId === null, "Source profile A mergedIntoProfileId cleared");

    // Verify sub-resources restored to source profile A
    const restoredInteraction = await prisma.crmInteraction.findUnique({ where: { id: interaction.id } });
    assert(restoredInteraction?.profileId === profileA.id, "Interaction restored to source profile A");

    const restoredTask = await prisma.crmFollowUpTask.findUnique({ where: { id: task.id } });
    assert(restoredTask?.profileId === profileA.id, "Follow-up task restored to source profile A");

    const restoredCheckin = await prisma.crmVisitCheckin.findUnique({ where: { id: checkin.id } });
    assert(restoredCheckin?.profileId === profileA.id, "Checkin restored to source profile A");

    const restoredAddress = await prisma.crmCustomerAddress.findUnique({ where: { id: address.id } });
    assert(restoredAddress?.profileId === profileA.id, "Address restored to source profile A");

    // Verify Project restored to source profile (+ optional customer anchor)
    const restoredProject = await prisma.project.findUnique({ where: { id: projectOnA.id } });
    assert(restoredProject?.profileId === profileA.id, "Project profileId restored to A");
    assert(restoredProject?.client === `${PREFIX} 张三`, "Project.client restored to original snapshot");

    // Verify ReportLine.customerName restored
    const restoredReportLine = await prisma.crmRepresentativeReportLine.findUnique({ where: { id: reportLine.id } });
    assert(restoredReportLine?.profileId === profileA.id, "ReportLine profileId restored to A");
    assert(restoredReportLine?.customerName === `${PREFIX} 张三`, "ReportLine.customerName restored to original snapshot");

    // ── Round 2: Merge A -> B again (repeatability) ────────────
    console.log("\n--- Round 2: Merge A -> B (repeatable) ---");
    const mergeLog2 = await executeMerge(
      profileA.id,
      profileB.id,
      "KEEP_TARGET",
      "KEEP_TARGET_ORG",
      admin.id,
    );

    const reMigratedInteraction = await prisma.crmInteraction.findUnique({ where: { id: interaction.id } });
    assert(reMigratedInteraction?.profileId === profileB.id, "Interaction re-migrated in round 2");

    // ── Round 2: Reverse again ─────────────────────────────────
    console.log("\n--- Round 2: Reverse (repeatable) ---");
    await reverseMerge(mergeLog2.mergeLogId, admin.id, "smoke test reverse round 2");

    const reRestoredInteraction = await prisma.crmInteraction.findUnique({ where: { id: interaction.id } });
    assert(reRestoredInteraction?.profileId === profileA.id, "Interaction re-restored in round 2");

    const reRestoredProject = await prisma.project.findUnique({ where: { id: projectOnA.id } });
    assert(reRestoredProject?.profileId === profileA.id, "Project profileId re-restored in round 2");
    assert(reRestoredProject?.client === `${PREFIX} 张三`, "Project.client re-restored to original snapshot in round 2");
  });

  console.log(`\n=== Results: ${pass} passed, ${fail} failed ===`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

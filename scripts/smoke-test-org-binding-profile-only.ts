/**
 * W6.7c：机构补绑 Profile-only 链路 smoke（临时库）
 *
 * 覆盖：
 *  1. Profile-only 扫描可创建任务
 *  2. 列表 where 以 profile 为主体，任务可见
 *  3. 单条绑定成功，写 Profile 机构字段
 *  4. 重复扫描幂等（不重复创建）
 *
 * Usage: npx tsx scripts/smoke-test-org-binding-profile-only.ts
 */

import { withTempSmokeDb } from "./lib/temp-smoke-db";

const PREFIX = `SMOKE-ORG-${Date.now().toString(36)}`;
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
  console.log("=== Org binding Profile-only smoke ===");

  await withTempSmokeDb(async (handle) => {
    handle.assertSafePath();
    const { prisma } = await import("../src/lib/prisma");
    const { scanUnboundCustomers } = await import("../src/lib/customers/customer-org-binding-scan");
    const { executeCustomerOrgBinding } = await import("../src/lib/crm/customer-org-binding");

    const admin = await prisma.user.create({
      data: {
        email: `${PREFIX}@test.local`,
        name: "Org Bind Admin",
        password: "x",
        role: "ADMIN",
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

    const profileOnly = await prisma.crmCustomerProfile.create({
      data: {
        customerCode: `${PREFIX}-P`,
        name: `${PREFIX} 仅档案`,
        organization: `${PREFIX} 测试大学`,
        organizationId: null,
        ownerUserId: admin.id,
        stage: "LEAD",
        assignmentStatus: "ASSIGNED",
        deleted: false,
        archived: false,
      },
    });

    console.log("\n--- Scan creates Profile-only task ---");
    const scan1 = await scanUnboundCustomers(admin.id, false);
    assert(scan1.created >= 1, `scan created>=1 (got ${scan1.created})`);

    const task = await prisma.customerOrgBindingTask.findUnique({
      where: { profileId: profileOnly.id },
    });
    assert(!!task, "task exists for profileOnly");
    assert(task?.status === "PENDING", "task PENDING");

    console.log("\n--- List visibility (profile where) ---");
    const listed = await prisma.customerOrgBindingTask.findMany({
      where: {
        status: "PENDING",
        profile: {
          deleted: false,
          archived: false,
          mergedIntoProfileId: null,
        },
      },
      select: { id: true, profileId: true },
    });
    assert(
      listed.some((t) => t.profileId === profileOnly.id),
      "list query includes Profile-only task",
    );

    console.log("\n--- Bind single ---");
    if (!task) throw new Error("no task");
    const outcome = await executeCustomerOrgBinding(
      task.id,
      profileOnly.id,
      org.id,
      null,
      admin.id,
      "smoke bind",
    );
    assert(outcome.success, `bind success (got ${JSON.stringify(outcome)})`);

    const afterProfile = await prisma.crmCustomerProfile.findUnique({
      where: { id: profileOnly.id },
      select: { organizationId: true, organization: true },
    });
    assertEq(afterProfile?.organizationId, org.id, "profile.organizationId set");
    assert(!!afterProfile?.organization, "profile.organization text set");

    const afterTask = await prisma.customerOrgBindingTask.findUnique({
      where: { id: task.id },
      select: { status: true, profileId: true },
    });
    assertEq(afterTask?.status, "RESOLVED", "task RESOLVED");

    console.log("\n--- Rescan idempotent ---");
    const taskCountBefore = await prisma.customerOrgBindingTask.count({
      where: { profileId: profileOnly.id },
    });
    const scan2 = await scanUnboundCustomers(admin.id, false);
    // profile 已有 org，不应再作为 unbound 创建
    const still = await prisma.customerOrgBindingTask.count({
      where: { profileId: profileOnly.id, status: "PENDING" },
    });
    const taskCountAfter = await prisma.customerOrgBindingTask.count({
      where: { profileId: profileOnly.id },
    });
    assertEq(still, 0, "no PENDING recreated for bound profile");
    assertEq(scan2.created, 0, "rescan created=0 for already-bound profile set");
    assertEq(taskCountAfter, taskCountBefore, "task count for profile unchanged after rescan");

    // bind 后可能有 fire-and-forget 代表同步；稍等再让 withTempSmokeDb 统一 disconnect
    await new Promise((r) => setTimeout(r, 100));
  });

  console.log(`\n结果: ${pass} pass / ${fail} fail`);
  if (fail > 0) process.exit(1);
}

function assertEq<T>(actual: T, expected: T, msg: string) {
  assert(actual === expected, `${msg} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

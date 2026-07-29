/**
 * W6.8：representative-sync 冻结门禁与 Profile-only 写入回归。
 *
 * Phase E contract：Customer 锚点模型已删，"Customer-only 历史行"夹具已移除，
 * 游离行场景改为 profileId=null（预期通过数不变 = 40）。
 *
 * Usage: npx tsx scripts/smoke-test-rep-sync-recalled-no-write.ts
 */

import { withTempSmokeDb } from "./lib/temp-smoke-db";

const PREFIX = `SMOKE-RSYNC-${Date.now().toString(36)}`;
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
  console.log("=== Rep-sync freeze / Profile-only smoke ===");

  await withTempSmokeDb(async (handle) => {
    handle.assertSafePath();
    const { prisma } = await import("../src/lib/prisma");
    const { REPRESENTATIVE_KIND } = await import("../src/lib/crm/system-representative");
    const {
      syncProfileRepresentativeLinks,
      syncProfileRepresentativeLinksFromOwner,
      syncEffectiveRepresentativeLinksForOrganization,
    } = await import("../src/lib/crm/customer-representative-sync");

    const admin = await prisma.user.create({
      data: { email: `${PREFIX}-admin@test.local`, name: "RSync Admin", password: "x", role: "ADMIN" },
    });
    const owner = await prisma.user.create({
      data: { email: `${PREFIX}-owner@test.local`, name: "RSync Owner", password: "x", role: "REPRESENTATIVE" },
    });
    const otherOwner = await prisma.user.create({
      data: { email: `${PREFIX}-other@test.local`, name: "RSync Other", password: "x", role: "REPRESENTATIVE" },
    });
    const rep = await prisma.representative.create({
      data: { name: "RSync Owner Rep", email: owner.email, kind: REPRESENTATIVE_KIND.HUMAN },
    });
    const otherRep = await prisma.representative.create({
      data: { name: "RSync Other Rep", email: otherOwner.email, kind: REPRESENTATIVE_KIND.HUMAN },
    });
    const org = await prisma.organization.create({
      data: { orgCode: `${PREFIX}-ORG`, canonicalName: `${PREFIX} Org`, normalizedName: `${PREFIX}-org` },
    });
    await prisma.representativeOrganization.create({
      data: {
        representativeId: rep.id,
        organizationId: org.id,
        organizationSiteId: null,
        status: "ACTIVE",
        isPrimary: true,
        reviewedAt: new Date(),
      },
    });

    async function makeProfile(opts: {
      code: string;
      status: string;
      ownerUserId?: string;
      organizationId?: string | null;
      deleted?: boolean;
      archived?: boolean;
      mergedIntoProfileId?: string | null;
    }) {
      return prisma.crmCustomerProfile.create({
        data: {
          customerCode: `${PREFIX}-${opts.code}`,
          name: `${PREFIX} ${opts.code}`,
          organizationId: opts.organizationId ?? null,
          organization: opts.organizationId ? org.canonicalName : null,
          ownerUserId: opts.ownerUserId ?? admin.id,
          stage: "LEAD",
          assignmentStatus: opts.status,
          deleted: opts.deleted ?? false,
          archived: opts.archived ?? false,
          mergedIntoProfileId: opts.mergedIntoProfileId ?? null,
        },
      });
    }

    async function makeOrder(
      profileId: string | null,
      orderNo: string,
      extra?: { deleted?: boolean; archived?: boolean; representativeId?: string | null },
    ) {
      return prisma.order.create({
        data: {
          orderNo: `${PREFIX}-${orderNo}`,
          title: orderNo,
          source: "MANUAL",
          category: "SERVICE",
          status: "CONFIRMED",
          financeTreatment: "STANDALONE",
          totalAmount: 1000,
          profileId,
          representativeId: extra?.representativeId ?? null,
          deleted: extra?.deleted ?? false,
          archived: extra?.archived ?? false,
          createdById: admin.id,
        },
      });
    }

    async function makeProject(
      profileId: string | null,
      name: string,
      extra?: { deleted?: boolean; archived?: boolean; representativeId?: string | null },
    ) {
      return prisma.project.create({
        data: {
          name: `${PREFIX}-${name}`,
          profileId,
          representativeId: extra?.representativeId ?? null,
          deleted: extra?.deleted ?? false,
          archived: extra?.archived ?? false,
        },
      });
    }

    console.log("\n--- RECALLED freeze ---");
    const recalled = await makeProfile({
      code: "RC",
      status: "RECALLED",
      ownerUserId: owner.id,
      organizationId: org.id,
    });
    const rcOrder = await makeOrder(recalled.id, "RC-O");
    const rcProject = await makeProject(recalled.id, "RC-P");
    const rcSync = await syncProfileRepresentativeLinks(recalled.id);
    assertEq(rcSync.skipped, true, "RECALLED sync skipped");
    assertEq(rcSync.reason, "PROFILE_NOT_ASSIGNABLE", "RECALLED reason");
    assertEq(rcSync.representativeId, null, "RECALLED returns null rep");
    assertEq((await prisma.order.findUnique({ where: { id: rcOrder.id } }))?.representativeId ?? null, null, "RECALLED order untouched");
    assertEq((await prisma.project.findUnique({ where: { id: rcProject.id } }))?.representativeId ?? null, null, "RECALLED project untouched");
    assertEq((await prisma.crmCustomerProfile.findUnique({ where: { id: recalled.id } }))?.assignmentStatus, "RECALLED", "RECALLED status unchanged");
    assertEq((await prisma.crmCustomerProfile.findUnique({ where: { id: recalled.id } }))?.ownerUserId, owner.id, "RECALLED owner unchanged");
    const orgBatchHit = await syncEffectiveRepresentativeLinksForOrganization({ organizationId: org.id });
    assert(
      (await prisma.order.findUnique({ where: { id: rcOrder.id } }))?.representativeId == null,
      `org batch does not write RECALLED (batchCount=${orgBatchHit})`,
    );

    console.log("\n--- RECALL_CANDIDATE freeze ---");
    const candidate = await makeProfile({
      code: "RCC",
      status: "RECALL_CANDIDATE",
      ownerUserId: owner.id,
      organizationId: org.id,
    });
    const rccOrder = await makeOrder(candidate.id, "RCC-O");
    const rccFromOwner = await syncProfileRepresentativeLinksFromOwner(candidate.id, otherOwner.id);
    assertEq(rccFromOwner.skipped, true, "RECALL_CANDIDATE FromOwner skipped");
    assertEq(rccFromOwner.representativeId, null, "RECALL_CANDIDATE FromOwner null");
    assertEq((await prisma.order.findUnique({ where: { id: rccOrder.id } }))?.representativeId ?? null, null, "RECALL_CANDIDATE order untouched");
    assertEq((await prisma.crmCustomerProfile.findUnique({ where: { id: candidate.id } }))?.ownerUserId, owner.id, "RECALL_CANDIDATE owner unchanged");

    console.log("\n--- deleted / archived / merged freeze ---");
    const survivor = await makeProfile({ code: "SV", status: "ASSIGNED", ownerUserId: owner.id, organizationId: org.id });
    const deletedP = await makeProfile({ code: "DEL", status: "ASSIGNED", ownerUserId: owner.id, organizationId: org.id, deleted: true });
    const archivedP = await makeProfile({ code: "ARC", status: "ASSIGNED", ownerUserId: owner.id, organizationId: org.id, archived: true });
    const mergedP = await makeProfile({
      code: "MRG",
      status: "ASSIGNED",
      ownerUserId: owner.id,
      organizationId: org.id,
      mergedIntoProfileId: survivor.id,
      deleted: true,
      archived: true,
    });
    for (const [label, p] of [
      ["deleted", deletedP],
      ["archived", archivedP],
      ["merged", mergedP],
    ] as const) {
      const o = await makeOrder(p.id, `${label}-O`);
      const r = await syncProfileRepresentativeLinks(p.id);
      assertEq(r.skipped, true, `${label} skipped`);
      assertEq((await prisma.order.findUnique({ where: { id: o.id } }))?.representativeId ?? null, null, `${label} order untouched`);
    }

    console.log("\n--- profileId-less rows untouched ---");
    // 验证 sync 只按 profileId，绝不触碰无 profileId 的游离行
    const legacyOrder = await makeOrder(null, "LEG-O", { representativeId: null });
    const legacyProject = await makeProject(null, "LEG-P", { representativeId: null });
    // Sync an unrelated active profile — must not touch profileId-less rows
    const activeForLegacy = await makeProfile({
      code: "ACT-LEG",
      status: "UNASSIGNED",
      ownerUserId: admin.id,
      organizationId: org.id,
    });
    await makeOrder(activeForLegacy.id, "ACT-LEG-O");
    await syncProfileRepresentativeLinks(activeForLegacy.id);
    assertEq((await prisma.order.findUnique({ where: { id: legacyOrder.id } }))?.representativeId ?? null, null, "legacy order untouched");
    assertEq((await prisma.project.findUnique({ where: { id: legacyProject.id } }))?.representativeId ?? null, null, "legacy project untouched");

    console.log("\n--- active profile only updates live profileId rows ---");
    const live = await makeProfile({
      code: "LIVE",
      status: "UNASSIGNED",
      ownerUserId: admin.id,
      organizationId: org.id,
    });
    const liveOrder = await makeOrder(live.id, "LIVE-O");
    const deletedOrder = await makeOrder(live.id, "LIVE-DEL", { deleted: true });
    const archivedOrder = await makeOrder(live.id, "LIVE-ARC", { archived: true });
    const liveProject = await makeProject(live.id, "LIVE-P");
    const deletedProject = await makeProject(live.id, "LIVE-P-DEL", { deleted: true });
    const archivedProject = await makeProject(live.id, "LIVE-P-ARC", { archived: true });
    const liveSync = await syncProfileRepresentativeLinks(live.id);
    assertEq(liveSync.skipped, false, "live sync not skipped");
    assertEq(liveSync.representativeId, rep.id, "live sync writes org human rep");
    assertEq((await prisma.order.findUnique({ where: { id: liveOrder.id } }))?.representativeId, rep.id, "live order updated");
    assertEq((await prisma.order.findUnique({ where: { id: deletedOrder.id } }))?.representativeId ?? null, null, "deleted order not updated");
    assertEq((await prisma.order.findUnique({ where: { id: archivedOrder.id } }))?.representativeId ?? null, null, "archived order not updated");
    assertEq((await prisma.project.findUnique({ where: { id: liveProject.id } }))?.representativeId, rep.id, "live project updated");
    assertEq((await prisma.project.findUnique({ where: { id: deletedProject.id } }))?.representativeId ?? null, null, "deleted project not updated");
    assertEq((await prisma.project.findUnique({ where: { id: archivedProject.id } }))?.representativeId ?? null, null, "archived project not updated");
    assertEq(
      (await prisma.crmCustomerProfile.findUnique({ where: { id: live.id } }))?.assignmentStatus,
      "ASSIGNED",
      "UNASSIGNED + HUMAN binding promotes to ASSIGNED",
    );

    console.log("\n--- ASSIGNED explicit owner: effective sync (owner 优先，不跟机构分裂) ---");
    const assigned = await makeProfile({
      code: "ASG",
      status: "ASSIGNED",
      ownerUserId: otherOwner.id,
      organizationId: org.id,
    });
    const asgOrder = await makeOrder(assigned.id, "ASG-O");
    const asgProject = await makeProject(assigned.id, "ASG-P");
    const asgSync = await syncProfileRepresentativeLinks(assigned.id);
    assertEq(asgSync.skipped, false, "ASSIGNED sync runs for Order/Project");
    assertEq(asgSync.representativeId, otherRep.id, "ASSIGNED sync uses explicit owner rep");
    assertEq(
      (await prisma.crmCustomerProfile.findUnique({ where: { id: assigned.id } }))?.ownerUserId,
      otherOwner.id,
      "ASSIGNED owner preserved on sync",
    );
    assertEq((await prisma.order.findUnique({ where: { id: asgOrder.id } }))?.representativeId, otherRep.id, "ASSIGNED order follows owner rep");
    assertEq((await prisma.project.findUnique({ where: { id: asgProject.id } }))?.representativeId, otherRep.id, "ASSIGNED project follows owner rep");

    // Org batch must not include ASSIGNED
    const beforeOwner = otherOwner.id;
    await syncEffectiveRepresentativeLinksForOrganization({ organizationId: org.id });
    assertEq(
      (await prisma.crmCustomerProfile.findUnique({ where: { id: assigned.id } }))?.ownerUserId,
      beforeOwner,
      "org batch leaves ASSIGNED owner alone",
    );
    assertEq(
      (await prisma.order.findUnique({ where: { id: asgOrder.id } }))?.representativeId,
      otherRep.id,
      "org batch does not overwrite ASSIGNED order with org rep",
    );

    console.log("\n--- UNASSIGNED + HUMAN via org batch ---");
    const unassigned = await makeProfile({
      code: "UNA",
      status: "UNASSIGNED",
      ownerUserId: admin.id,
      organizationId: org.id,
    });
    const unaOrder = await makeOrder(unassigned.id, "UNA-O");
    const batchN = await syncEffectiveRepresentativeLinksForOrganization({ organizationId: org.id });
    assert(batchN >= 1, `org batch processed >=1 (got ${batchN})`);
    assertEq(
      (await prisma.crmCustomerProfile.findUnique({ where: { id: unassigned.id } }))?.assignmentStatus,
      "ASSIGNED",
      "org batch promotes UNASSIGNED",
    );
    assertEq((await prisma.order.findUnique({ where: { id: unaOrder.id } }))?.representativeId, rep.id, "org batch writes order rep");
    assertEq(
      (await prisma.crmCustomerProfile.findUnique({ where: { id: unassigned.id } }))?.ownerUserId,
      owner.id,
      "org batch sets owner from human binding",
    );
  });

  console.log(`\n=== done: ${pass} passed, ${fail} failed ===`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error("\n冒烟测试失败:", err);
  process.exit(1);
});

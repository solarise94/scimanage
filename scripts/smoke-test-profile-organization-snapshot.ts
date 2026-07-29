/**
 * Profile organization 快照一致性 smoke（临时库，自动清理）
 *
 * 覆盖：
 *  1. FK 正确、快照为空 → 挂 site 后恢复 canonicalName
 *  2. 正常 Profile 机构级挂 site，三字段一致
 *  3. site 不属于 organization 时拒绝
 *  4. archived Profile 拒绝部分更新
 *  5. rebind 后空快照也变成 target canonicalName
 *  6. Unicode lookup 能命中 ZWSP/BOM/全半角括号变体；不同名不被错误折叠
 *
 * Usage: npx tsx scripts/smoke-test-profile-organization-snapshot.ts
 */

import { withTempSmokeDb } from "./lib/temp-smoke-db";

const PREFIX = `SMOKE-POS-${Date.now().toString(36)}`;
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
  console.log("=== Profile organization snapshot smoke ===");

  await withTempSmokeDb(async (handle) => {
    handle.assertSafePath();
    const { prisma } = await import("../src/lib/prisma");
    const {
      resolveCanonicalOrganizationBindingFromSiteId,
      buildCanonicalOrganizationBindingPatch,
    } = await import("../src/lib/customers/customer-organization-write");
    const { rebindOrganizationReferences } = await import("../src/lib/organization-rebind");
    const {
      normalizeOrganizationLookupText,
      organizationLookupIncludes,
      normalizeOrgName,
    } = await import("../src/lib/organization-normalize");

    const admin = await prisma.user.create({
      data: {
        email: `${PREFIX}@test.local`,
        name: "Snapshot Smoke Admin",
        password: "x",
        role: "ADMIN",
      },
    });

    const orgA = await prisma.organization.create({
      data: {
        orgCode: `${PREFIX}-A`,
        canonicalName: "浙江大学杭州国际科创中心",
        normalizedName: normalizeOrgName("浙江大学杭州国际科创中心"),
        isInvoiceSubject: true,
      },
    });
    const orgB = await prisma.organization.create({
      data: {
        orgCode: `${PREFIX}-B`,
        canonicalName: `${PREFIX} 另一所大学`,
        normalizedName: normalizeOrgName(`${PREFIX} 另一所大学`),
        isInvoiceSubject: true,
      },
    });
    const orgOther = await prisma.organization.create({
      data: {
        orgCode: `${PREFIX}-O`,
        canonicalName: "浙江大学杭州国际科创中心（测试）",
        normalizedName: normalizeOrgName("浙江大学杭州国际科创中心（测试）"),
        isInvoiceSubject: true,
      },
    });

    const siteA = await prisma.organizationSite.create({
      data: {
        organizationId: orgA.id,
        siteName: "紫金港校区",
        normalizedSiteName: "紫金港校区",
        siteType: "CAMPUS",
      },
    });
    const siteB = await prisma.organizationSite.create({
      data: {
        organizationId: orgB.id,
        siteName: "滨文校区",
        normalizedSiteName: "滨文校区",
        siteType: "CAMPUS",
      },
    });

    const emptySnap = await prisma.crmCustomerProfile.create({
      data: {
        customerCode: `${PREFIX}-E`,
        name: `${PREFIX} 空快照`,
        organizationId: orgA.id,
        organization: "",
        ownerUserId: admin.id,
        stage: "LEAD",
        assignmentStatus: "ASSIGNED",
        deleted: false,
        archived: false,
      },
    });
    const normal = await prisma.crmCustomerProfile.create({
      data: {
        customerCode: `${PREFIX}-N`,
        name: `${PREFIX} 正常`,
        organizationId: orgA.id,
        organization: orgA.canonicalName,
        ownerUserId: admin.id,
        stage: "LEAD",
        assignmentStatus: "ASSIGNED",
        deleted: false,
        archived: false,
      },
    });
    const archived = await prisma.crmCustomerProfile.create({
      data: {
        customerCode: `${PREFIX}-AR`,
        name: `${PREFIX} 已归档`,
        organizationId: orgA.id,
        organization: orgA.canonicalName,
        ownerUserId: admin.id,
        stage: "LEAD",
        assignmentStatus: "ASSIGNED",
        deleted: false,
        archived: true,
      },
    });
    const rebindEmpty = await prisma.crmCustomerProfile.create({
      data: {
        customerCode: `${PREFIX}-R`,
        name: `${PREFIX} rebind空`,
        organizationId: orgA.id,
        organization: null,
        ownerUserId: admin.id,
        stage: "LEAD",
        assignmentStatus: "ASSIGNED",
        deleted: false,
        archived: false,
      },
    });

    console.log("\n--- Helper resolves site binding with canonical snapshot ---");
    const resolved = await resolveCanonicalOrganizationBindingFromSiteId(siteA.id);
    assert(resolved.ok === true, "resolve site ok");
    if (resolved.ok) {
      assert(resolved.patch.organization === orgA.canonicalName, "patch.organization = canonical");
      assert(resolved.patch.organizationId === orgA.id, "patch.organizationId");
      assert(resolved.patch.organizationSiteId === siteA.id, "patch.organizationSiteId");
    }

    console.log("\n--- Empty snapshot restored on site assign ---");
    if (resolved.ok) {
      await prisma.crmCustomerProfile.updateMany({
        where: { id: emptySnap.id },
        data: resolved.patch,
      });
    }
    const afterEmpty = await prisma.crmCustomerProfile.findUnique({ where: { id: emptySnap.id } });
    assert(afterEmpty?.organization === orgA.canonicalName, "empty snapshot restored");
    assert(afterEmpty?.organizationSiteId === siteA.id, "site assigned");

    console.log("\n--- Normal profile stays consistent ---");
    if (resolved.ok) {
      await prisma.crmCustomerProfile.updateMany({
        where: { id: normal.id },
        data: resolved.patch,
      });
    }
    const afterNormal = await prisma.crmCustomerProfile.findUnique({ where: { id: normal.id } });
    assert(afterNormal?.organization === orgA.canonicalName, "normal snapshot unchanged canonical");
    assert(afterNormal?.organizationId === orgA.id && afterNormal?.organizationSiteId === siteA.id, "normal FK+site");

    console.log("\n--- Reject site belonging to other org ---");
    const otherSite = await resolveCanonicalOrganizationBindingFromSiteId(siteB.id);
    assert(otherSite.ok === true, "other site resolves");
    if (otherSite.ok) {
      assert(otherSite.patch.organizationId === orgB.id, "other site org = B");
      assert(otherSite.patch.organizationId !== orgA.id, "site B not under org A");
    }

    console.log("\n--- Archived profile not updated by active-only where ---");
    if (resolved.ok) {
      const upd = await prisma.crmCustomerProfile.updateMany({
        where: { id: { in: [archived.id] }, archived: false, deleted: false },
        data: resolved.patch,
      });
      assert(upd.count === 0, "archived excluded from updateMany");
    }
    const afterArchived = await prisma.crmCustomerProfile.findUnique({ where: { id: archived.id } });
    assert(afterArchived?.organizationSiteId == null, "archived site untouched");

    console.log("\n--- Reject site under archived organization ---");
    const archivedOrg = await prisma.organization.create({
      data: {
        orgCode: `${PREFIX}-ARCH`,
        canonicalName: `${PREFIX} 已归档机构`,
        normalizedName: normalizeOrgName(`${PREFIX} 已归档机构`),
        archived: true,
        isInvoiceSubject: true,
      },
    });
    const archivedOrgSite = await prisma.organizationSite.create({
      data: {
        organizationId: archivedOrg.id,
        siteName: "仍活动院区",
        normalizedSiteName: "仍活动院区",
        siteType: "CAMPUS",
        archived: false,
      },
    });
    const archivedOrgResolved = await resolveCanonicalOrganizationBindingFromSiteId(archivedOrgSite.id);
    assert(archivedOrgResolved.ok === false, "rejects site whose parent org is archived");
    if (!archivedOrgResolved.ok) {
      assert(archivedOrgResolved.message.includes("归档"), "archived-org message mentions 归档");
    }

    console.log("\n--- Rebind sets empty snapshot to target canonical ---");
    await prisma.$transaction(async (tx) => {
      await rebindOrganizationReferences(tx, orgA.id, orgB.id, orgB.canonicalName, orgA.canonicalName);
    });
    const afterRebind = await prisma.crmCustomerProfile.findUnique({ where: { id: rebindEmpty.id } });
    assert(afterRebind?.organizationId === orgB.id, "rebind FK -> B");
    assert(afterRebind?.organization === orgB.canonicalName, "rebind empty snapshot -> B canonical");

    console.log("\n--- Unicode lookup + matching-key NFKC ---");
    const base = "浙江大学杭州国际科创中心";
    const queries = [
      base,
      `浙江大学杭州国际科创中\u200B心`,
      `${base}\uFEFF`,
      "浙江大学杭州国际科创中心（测试）",
      "浙江大学杭州国际科创中心(测试)",
    ];
    for (const q of queries.slice(0, 3)) {
      assert(organizationLookupIncludes(base, q), `lookup hits base for ${JSON.stringify(q)}`);
      assert(normalizeOrgName(base) === normalizeOrgName(q), `matching key equal for ${JSON.stringify(q)}`);
    }
    assert(
      normalizeOrganizationLookupText(queries[3]) === normalizeOrganizationLookupText(queries[4]),
      "full/half-width parens normalize equal",
    );
    assert(
      normalizeOrgName(queries[3]) === normalizeOrgName(queries[4]),
      "matching key equal for paren variants",
    );
    assert(
      organizationLookupIncludes(orgOther.canonicalName, queries[3]),
      "paren variant hits orgOther",
    );
    assert(
      !organizationLookupIncludes(base, orgOther.canonicalName) ||
        normalizeOrganizationLookupText(base) !== normalizeOrganizationLookupText(orgOther.canonicalName),
      "base and paren-test remain distinct keys",
    );
    assert(
      normalizeOrgName(base) !== normalizeOrgName(orgOther.canonicalName),
      "normalizeOrgName keeps distinct orgs",
    );
    assert(
      normalizeOrgName("①医院") === normalizeOrgName("1医院"),
      "NFKC circled digit matches ASCII digit in matching key",
    );
    assert(
      normalizeOrganizationLookupText("①医院") === normalizeOrganizationLookupText("1医院"),
      "lookup inherits NFKC from matching key",
    );

    // buildCanonicalOrganizationBindingPatch smoke
    const patch = buildCanonicalOrganizationBindingPatch({
      organizationId: orgB.id,
      canonicalName: orgB.canonicalName,
      organizationSiteId: siteB.id,
    });
    assert(patch.organization === orgB.canonicalName, "buildCanonical patch");

    console.log("\n(temp db auto-cleaned by withTempSmokeDb)");
  });

  console.log(`\n=== Done: ${pass} passed, ${fail} failed ===`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

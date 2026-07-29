/**
 * 验证 site 合成名匹配修复（临时库）。
 *
 * 构造场景：
 *   - Organization "测试大学" + OrganizationSite "医学院"
 *   - Profile 绑定到该 org + site，name="测试客户A"
 *   - 模拟导入 buyerOrgName="测试大学医学院" + buyerName="测试客户A"
 *
 * Usage: npx tsx scripts/test-site-composite-match.ts
 */
import { withTempSmokeDb } from "./lib/temp-smoke-db";
import type { MatchCandidate } from "../src/lib/orders/source-order-match";

async function main() {
  await withTempSmokeDb(async () => {
    const { prisma } = await import("../src/lib/prisma");
    const { matchImportRow } = await import("../src/lib/orders/source-order-match");

    const stamp = Date.now();
    const admin = await prisma.user.create({
      data: { email: `site-match-${stamp}@test.local`, name: "site-match", password: "x", role: "ADMIN" },
      select: { id: true },
    });

    const org = await prisma.organization.create({
      data: {
        orgCode: `TEST-SITE-${stamp}`,
        canonicalName: "测试大学",
        normalizedName: "ceshidaxue",
      },
    });
    const site = await prisma.organizationSite.create({
      data: {
        organizationId: org.id,
        siteName: "医学院",
        normalizedSiteName: "yixueyuan",
        siteType: "COLLEGE",
      },
    });
    const profile = await prisma.crmCustomerProfile.create({
      data: {
        customerCode: `T-SITE-${stamp}`,
        name: "测试客户A",
        organization: org.canonicalName,
        organizationId: org.id,
        organizationSiteId: site.id,
        ownerUserId: admin.id,
        stage: "ACTIVE",
      },
    });

    console.log("测试数据已创建:");
    console.log(`  org: ${org.id} ("测试大学")`);
    console.log(`  site: ${site.id} ("医学院")`);
    console.log(`  profile: ${profile.id} ("测试客户A")`);

    const candidate: MatchCandidate = {
      profileId: profile.id,
      name: profile.name,
      wechat: null,
      principal: null,
      organization: profile.organization,
      address: null,
      orgCanonicalName: org.canonicalName,
      orgNormalizedName: org.normalizedName,
      orgAliases: [],
      orgSiteNames: [site.siteName],
      customerSiteName: site.siteName,
    };

    const result1 = matchImportRow(
      { buyerName: "测试客户A", buyerOrgName: "测试大学医学院" },
      [candidate],
    );
    console.log("\n测试1: buyerOrgName='测试大学医学院', name='测试客户A'");
    console.log("  结果:", result1);
    console.log(result1?.score === 80 ? "  ✅ exact 命中 (score 80)" : "  ❌ 未达 exact 80");

    const result2 = matchImportRow(
      { buyerName: "测试客户A", buyerOrgName: "医学院" },
      [candidate],
    );
    console.log("\n测试2: buyerOrgName='医学院', name='测试客户A'");
    console.log("  结果:", result2);
    console.log(result2 && result2.score >= 70 ? "  ✅ 命中 (≥70)" : "  ❌ 未命中");

    const result3 = matchImportRow(
      { buyerName: "测试客户A", buyerOrgName: "测试大学" },
      [candidate],
    );
    console.log("\n测试3: buyerOrgName='测试大学', name='测试客户A'");
    console.log("  结果:", result3);
    console.log(result3?.score === 80 ? "  ✅ exact 命中 (score 80)" : "  ❌ 未达 exact 80");

    const result4 = matchImportRow(
      { buyerName: "别人", buyerOrgName: "测试大学医学院" },
      [candidate],
    );
    console.log("\n测试4: buyerOrgName='测试大学医学院', name='别人' (姓名不符)");
    console.log("  结果:", result4);
    console.log(!result4 ? "  ✅ 不误匹配 (姓名 gate 正确拦截)" : "  ⚠️ 命中了（可能 Layer 4 地址）");

    console.log("\n测试数据在 temp DB（自动销毁）。");
  });
}

main()
  .catch((e) => { console.error(e); process.exit(1); });

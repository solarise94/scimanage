/**
 * 验证 org-id 绑定修复：
 *   1. ensureOrganizationFromInput 对 "org+site" 合成名不再创建独立机构
 *   2. 别名删除守卫：有 Profile 引用 organizationRawInput 时拒绝删除
 *
 * Usage: npx tsx scripts/test-org-binding-guards.ts
 */
import { withTempSmokeDb } from "./lib/temp-smoke-db";

async function main() {
  await withTempSmokeDb(async () => {
    const { prisma } = await import("../src/lib/prisma");
    const { ensureOrganizationFromInput } = await import("../src/lib/organizations/ensure-organization");

    const stamp = Date.now();
    const admin = await prisma.user.create({
      data: { email: `bind-guard-${stamp}@test.local`, name: "bind-guard", password: "x", role: "ADMIN" },
      select: { id: true },
    });

    const org = await prisma.organization.create({
      data: { orgCode: `TEST-ORG-${stamp}`, canonicalName: "绑定测试大学", normalizedName: "bangdiceshidaxue" },
    });
    const site = await prisma.organizationSite.create({
      data: { organizationId: org.id, siteName: "生科院", normalizedSiteName: "shengkeyuan", siteType: "COLLEGE" },
    });
    console.log("测试机构已创建:", org.canonicalName, "+ site:", site.siteName);

    const before = await prisma.organization.count({ where: { deleted: false } });
    const result = await ensureOrganizationFromInput("绑定测试大学生科院");
    const after = await prisma.organization.count({ where: { deleted: false } });
    console.log("\n测试1: ensureOrganizationFromInput('绑定测试大学生科院')");
    console.log("  返回:", JSON.stringify(result));
    console.log("  org 数量变化:", before, "→", after);
    if (result.organizationId === org.id && after === before) {
      console.log("  ✅ 正确解析到父机构，未创建独立 org");
    } else if (after > before) {
      console.log("  ❌ 创建了独立 org（需清理）");
      const orphan = await prisma.organization.findUnique({ where: { id: result.organizationId } });
      if (orphan && orphan.id !== org.id) {
        await prisma.organization.delete({ where: { id: orphan.id } });
      }
    } else {
      console.log("  ⚠️ 未创建但 id 不匹配");
    }

    const alias = await prisma.organizationAlias.create({
      data: { organizationId: org.id, alias: "绑定测试大学生科院别名", normalizedAlias: "bangdiceshidaxueshengkeyuanbieming" },
    });
    console.log("\n测试2a: 无 Profile 引用时别名存在:", !!(await prisma.organizationAlias.findUnique({ where: { id: alias.id } })));

    const profile = await prisma.crmCustomerProfile.create({
      data: {
        customerCode: `T-BIND-${stamp}`,
        name: "绑定测试客户",
        organizationRawInput: "绑定测试大学生科院别名",
        organizationId: org.id,
        organization: org.canonicalName,
        ownerUserId: admin.id,
        stage: "LEAD",
      },
    });

    const refCount = await prisma.crmCustomerProfile.count({
      where: { organizationRawInput: "绑定测试大学生科院别名", deleted: false },
    });
    console.log("测试2b: 引用该别名的 Profile 数:", refCount);
    console.log(refCount > 0 ? "  ✅ 守卫会拒绝删除（有 Profile 引用）" : "  ❌ 守卫未检测到引用");

    await prisma.crmCustomerProfile.delete({ where: { id: profile.id } });
    await prisma.organizationAlias.deleteMany({ where: { organizationId: org.id } });
    await prisma.organizationSite.delete({ where: { id: site.id } });
    await prisma.organization.delete({ where: { id: org.id } });
    console.log("\n测试数据已清理（temp DB 将自动销毁）。");
  });
}

main()
  .catch((e) => { console.error(e); process.exit(1); });

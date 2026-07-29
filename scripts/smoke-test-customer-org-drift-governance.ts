/**
 * 客户机构文本漂移治理 — 端到端冒烟测试（临时库 + 本地 standalone）。
 *
 * Usage: npx tsx scripts/smoke-test-customer-org-drift-governance.ts
 * 前提: npm run build（需要 .next/standalone/server.js）
 */
import { randomBytes, randomUUID } from "crypto";
import bcrypt from "bcryptjs";
import { withTempSmokeHttpServer } from "./lib/temp-smoke-http";

const TEST_ADMIN_EMAIL = `smoke-orgdrift-${Date.now()}-${randomUUID().slice(0, 8)}@test.local`;
const TEST_ADMIN_PW = randomBytes(24).toString("base64url");
const TEST_USER_EMAIL = `smoke-orgdrift-user-${Date.now()}-${randomUUID().slice(0, 8)}@test.local`;
const TEST_USER_PW = randomBytes(24).toString("base64url");

async function main() {
  await withTempSmokeHttpServer(async (handle) => {
    const baseUrl = handle.baseUrl;
    const { prisma } = await import("../src/lib/prisma");

    let adminUserId = "";
    let normalUserId = "";
    let adminCookie = "";
    let userCookie = "";
    const cleanupOrgIds: string[] = [];
    const cleanupProfileIds: string[] = [];
    const cleanupTaskIds: string[] = [];

    async function createUser(email: string, password: string, role: string) {
      const hash = await bcrypt.hash(password, 12);
      return prisma.user.create({ data: { email, password: hash, role, name: email } });
    }

    async function login(email: string, password: string): Promise<string> {
      const csrfRes = await fetch(`${baseUrl}/api/auth/csrf`);
      const csrfData = await csrfRes.json();
      const csrfToken = csrfData.csrfToken;
      const cookiesBefore = csrfRes.headers.get("set-cookie") || "";
      const loginRes = await fetch(`${baseUrl}/api/auth/callback/credentials`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookiesBefore },
        body: new URLSearchParams({ csrfToken, email, password, json: "true" }),
        redirect: "manual",
      });
      const newCookies = loginRes.headers.get("set-cookie");
      if (!newCookies) throw new Error(`Login failed (${loginRes.status})`);
      return newCookies.split(",").map((c) => c.trim().split(";")[0]).filter(Boolean).join("; ");
    }

    async function getJson(path: string, cookie: string) {
      const res = await fetch(`${baseUrl}${path}`, { headers: { Cookie: cookie } });
      return { status: res.status, data: await res.json().catch(() => ({})) };
    }

    async function postJson(path: string, cookie: string, body: unknown) {
      const res = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify(body),
      });
      return { status: res.status, data: await res.json().catch(() => ({})) };
    }

    async function patchJson(path: string, cookie: string, body: unknown) {
      const res = await fetch(`${baseUrl}${path}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify(body),
      });
      return { status: res.status, data: await res.json().catch(() => ({})) };
    }

    function assert<T>(value: T | null | undefined | false | "", message: string): asserts value is T {
      if (!value) throw new Error(`ASSERT FAIL: ${message}`);
    }

    function assertEq<T>(actual: T, expected: T, message: string) {
      if (actual !== expected) throw new Error(`ASSERT FAIL: ${message} (expected ${expected}, got ${actual})`);
    }

    async function cleanup() {
      if (cleanupTaskIds.length > 0) {
        await prisma.customerOrgTextDriftTask.deleteMany({ where: { id: { in: cleanupTaskIds } } });
      }
      if (cleanupProfileIds.length > 0) {
        await prisma.crmCustomerProfile.deleteMany({ where: { id: { in: cleanupProfileIds } } });
      }
      if (cleanupOrgIds.length > 0) {
        await prisma.organization.deleteMany({ where: { id: { in: cleanupOrgIds } } });
      }
      await prisma.user.deleteMany({
        where: { id: { in: [adminUserId, normalUserId].filter(Boolean) } },
      });
    }

    try {
      console.log(`BASE_URL: ${baseUrl}\n`);
      const admin = await createUser(TEST_ADMIN_EMAIL, TEST_ADMIN_PW, "ADMIN");
      adminUserId = admin.id;
      const user = await createUser(TEST_USER_EMAIL, TEST_USER_PW, "USER");
      normalUserId = user.id;
      adminCookie = await login(TEST_ADMIN_EMAIL, TEST_ADMIN_PW);
      userCookie = await login(TEST_USER_EMAIL, TEST_USER_PW);

      const nonInvoiceOrg = await prisma.organization.create({
        data: { canonicalName: "冒烟非开票单位", normalizedName: "冒烟非开票单位", orgCode: `NI-${Date.now()}`, isInvoiceSubject: false },
      });
      cleanupOrgIds.push(nonInvoiceOrg.id);

      const invoiceOrg = await prisma.organization.create({
        data: { canonicalName: "浙江大学医学院", normalizedName: "浙江大学医学院", orgCode: `ZJU-${Date.now()}`, isInvoiceSubject: true },
      });
      cleanupOrgIds.push(invoiceOrg.id);

      const driftOrg = await prisma.organization.create({
        data: { canonicalName: "中山大学附属第一医院", normalizedName: "中山大学附属第一医院", orgCode: `SYSU-${Date.now()}`, isInvoiceSubject: true },
      });
      cleanupOrgIds.push(driftOrg.id);

      const t1 = await postJson("/api/customers", adminCookie, { name: "冒烟客户 T1", organizationId: nonInvoiceOrg.id });
      assertEq(t1.status, 400, "T1: 非开票机构应返回 400");
      assert(t1.data.error?.includes("税务验真") || t1.data.error?.includes("开票"), "T1: 错误提示应提及税务验真/开票");
      console.log("✓ T1: 非开票机构绑定被拦截");

      const t2 = await postJson("/api/customers", adminCookie, {
        name: "冒烟客户 T2",
        organizationId: invoiceOrg.id,
        organizationRawInput: "浙大医学院 507",
      });
      assertEq(t2.status, 201, "T2: 创建客户应成功");
      const profileIdT2 = t2.data.customer?.id as string;
      assert(profileIdT2, "T2: 应返回 profile id");
      cleanupProfileIds.push(profileIdT2);
      assertEq(t2.data.customer?.organization, invoiceOrg.canonicalName, "T2: 返回 organization 应为 canonical");

      const profileT2 = await prisma.crmCustomerProfile.findUnique({ where: { id: profileIdT2 } });
      assert(profileT2, "T2: Profile 应存在");
      assertEq(profileT2.organization, invoiceOrg.canonicalName, "T2: Profile organization 应为 canonical");
      assertEq(profileT2.organizationRawInput, "浙大医学院 507", "T2: rawInput 应保留");
      console.log("✓ T2: 创建客户时机构被 canonical 化且 rawInput 保留");

      const t3 = await patchJson(`/api/crm/profiles/${profileIdT2}`, adminCookie, {
        organization: "浙江大学医学院507室",
      });
      assertEq(t3.status, 200, "T3: PATCH 应成功");
      const profileT2AfterPatch = await prisma.crmCustomerProfile.findUnique({ where: { id: profileIdT2 } });
      assertEq(profileT2AfterPatch?.organization, invoiceOrg.canonicalName, "T3: Profile 仍应为 canonical");
      assertEq(profileT2AfterPatch?.organizationRawInput, "浙江大学医学院507室", "T3: rawInput 应更新为最新输入");
      console.log("✓ T3: PATCH 漂移文本被收敛为 canonical");

      // Phase E contract：drift 任务已 Profile-only，可直接新建（W7.3 过渡门禁已移除）。
      const profileT4 = await prisma.crmCustomerProfile.create({
        data: {
          ownerUserId: adminUserId,
          name: "冒烟客户 T4",
          customerCode: `T4-${Date.now()}`,
          organizationId: driftOrg.id,
          organization: driftOrg.canonicalName,
          organizationRawInput: "中山一院 5 号楼 302",
        },
      });
      cleanupProfileIds.push(profileT4.id);
      await prisma.crmCustomerProfile.update({
        where: { id: profileT4.id },
        data: { organization: "中山一院 5 号楼 302" },
      });

      const scanRes = await postJson("/api/admin/governance/org-text-drift/scan", adminCookie, {});
      assertEq(scanRes.status, 200, "T4: 扫描应成功");
      assert(scanRes.data.totalPending >= 1, "T4: 扫描后应至少有一个 PENDING 任务");

      const listRes = await getJson(
        `/api/admin/governance/org-text-drift?status=PENDING&search=${encodeURIComponent("中山一院")}`,
        adminCookie,
      );
      assertEq(listRes.status, 200, "T4: 列表接口应成功");
      const task = (listRes.data.tasks || []).find((t: { profileId: string }) => t.profileId === profileT4.id);
      assert(task, "T4: 应找到对应 PENDING 任务");
      cleanupTaskIds.push(task.id);

      const canonRes = await patchJson(`/api/admin/governance/org-text-drift/${task.id}`, adminCookie, { action: "canonicalize" });
      assertEq(canonRes.status, 200, "T4: canonicalize 应成功");
      const taskAfter = await prisma.customerOrgTextDriftTask.findUnique({ where: { id: task.id } });
      assertEq(taskAfter?.status, "RESOLVED", "T4: 任务应变为 RESOLVED");
      assertEq(taskAfter?.resolvedAction, "CANONICALIZED", "T4: resolvedAction 应为 CANONICALIZED");
      const profileT4After = await prisma.crmCustomerProfile.findUnique({ where: { id: profileT4.id } });
      assertEq(profileT4After?.organization, driftOrg.canonicalName, "T4: canonicalize 后 Profile organization 应为 canonical");
      console.log("✓ T4: M1b 扫描 + canonicalize 收敛成功");

      await prisma.crmCustomerProfile.update({
        where: { id: profileIdT2 },
        data: { organizationId: null, organizationSiteId: null, organization: null },
      });
      const t5 = await patchJson(`/api/crm/profiles/${profileIdT2}`, adminCookie, {
        organization: "一个不存在的测试单位 XYZ",
      });
      assert(t5.status === 400 || t5.status === 409, "T5: 未匹配文本应返回 400/409");
      console.log("✓ T5: 未精确匹配的机构文本被拦截");

      assertEq((await postJson("/api/admin/governance/org-text-drift/scan", "", {})).status, 401, "T6: 未认证扫描应 401");
      assertEq((await postJson("/api/admin/governance/org-text-drift/scan", userCookie, {})).status, 403, "T6: 非 ADMIN 扫描应 403");
      console.log("✓ T6: 治理接口权限正确");

      // W6.7d：counts 已 410；改用 org-text-drift 列表 total 校验 PENDING 计数
      assertEq((await getJson("/api/admin/data-governance/counts", adminCookie)).status, 410, "T7: counts 应 410 Gone");
      const driftList = await getJson("/api/admin/governance/org-text-drift?status=PENDING&pageSize=1", adminCookie);
      assertEq(driftList.status, 200, "T7: org-text-drift 列表应成功");
      assert(typeof driftList.data.total === "number", "T7: 应返回 PENDING 任务 total");
      console.log("✓ T7: counts 退役 + org-text-drift total 可用");

      console.log("\n所有冒烟测试通过 ✓");
    } finally {
      await cleanup();
    }
  });
}

main().catch((err) => {
  console.error("\n冒烟测试失败:", err);
  process.exit(1);
});

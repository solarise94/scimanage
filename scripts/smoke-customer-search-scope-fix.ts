/**
 * CRM 客户搜索 scope 分歧修复 — Profile-only 端到端冒烟（W6.5）
 *
 * 覆盖：SYSTEM_FALLBACK 一致性 / 池分配 assign-recall / REGIONAL_MANAGER 下辖覆盖
 * Fixture 直接创建 Profile（sourceCustomerId=null）；列表/搜索只认 profileId。
 *
 * 运行: npx tsx scripts/smoke-customer-search-scope-fix.ts
 * 前提: npm run build（需要 .next/standalone/server.js）
 * 隔离: withTempSmokeHttpServer 临时库 + 本地 standalone。
 */

import { randomBytes, randomUUID } from "crypto";
import bcrypt from "bcryptjs";
import { withTempSmokeHttpServer } from "./lib/temp-smoke-http";

const RUN_ID = `${Date.now()}-${randomUUID().slice(0, 8)}`;

const RESULTS: { step: string; status: "PASS" | "FAIL"; detail?: string }[] = [];

const ADMIN_EMAIL = `smoke-admin-${RUN_ID}@test.local`;
const ADMIN_PW = randomBytes(24).toString("base64url");
const REP_EMAIL = `smoke-rep-${RUN_ID}@test.local`;
const REP_PW = randomBytes(24).toString("base64url");
const RM_EMAIL = `smoke-rm-${RUN_ID}@test.local`;
const RM_PW = randomBytes(24).toString("base64url");
const SUB_EMAIL = `smoke-sub-${RUN_ID}@test.local`;
const SUB_PW = randomBytes(24).toString("base64url");

async function login(baseUrl: string, email: string, password: string): Promise<string> {
  const csrfRes = await fetch(`${baseUrl}/api/auth/csrf`);
  const csrfData = (await csrfRes.json()) as { csrfToken: string };
  const cookiesBefore = csrfRes.headers.get("set-cookie") || "";

  const loginRes = await fetch(`${baseUrl}/api/auth/callback/credentials`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: cookiesBefore,
    },
    body: new URLSearchParams({
      csrfToken: csrfData.csrfToken,
      email,
      password,
      json: "true",
    }),
    redirect: "manual",
  });

  const newCookies = loginRes.headers.get("set-cookie");
  if (!newCookies) {
    const text = await loginRes.text();
    throw new Error(`Login failed (${loginRes.status}): ${text.slice(0, 200)}`);
  }
  return newCookies
    .split(",")
    .map((c) => c.trim().split(";")[0])
    .filter(Boolean)
    .join("; ");
}

async function getJson(baseUrl: string, path: string, cookie: string) {
  const res = await fetch(`${baseUrl}${path}`, { headers: { Cookie: cookie } });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function postJson(baseUrl: string, path: string, cookie: string, body: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

function assertPass(condition: boolean, step: string, msg: string) {
  if (condition) {
    RESULTS.push({ step, status: "PASS", detail: msg });
    console.log(`  ✓ ${step}: ${msg}`);
  } else {
    RESULTS.push({ step, status: "FAIL", detail: msg });
    console.error(`  ❌ ${step}: ${msg}`);
    throw new Error(`FAIL: ${step} — ${msg}`);
  }
}

/** 列表/档案搜索响应中是否包含指定 profileId（兼容 customers[] / profiles[] / id|profileId）。 */
function hasProfile(data: unknown, profileId: string): boolean {
  if (!data || typeof data !== "object") return false;
  const obj = data as {
    customers?: Array<{ id?: string; profileId?: string }>;
    profiles?: Array<{ id?: string; profileId?: string }>;
  };
  const rows = [
    ...(Array.isArray(obj.customers) ? obj.customers : []),
    ...(Array.isArray(obj.profiles) ? obj.profiles : []),
  ];
  return rows.some((r) => r.id === profileId || r.profileId === profileId);
}

async function main() {
  await withTempSmokeHttpServer(async (handle) => {
    handle.assertSafePath();
    const baseUrl = handle.baseUrl;
    const { prisma } = await import("../src/lib/prisma");
    const { ensureHqRepresentative } = await import("../src/lib/crm/system-representative");

    console.log("=== CRM 客户搜索 scope 分歧修复 Smoke Test (Profile-only / W6.5) ===\n");
    console.log(`BASE_URL: ${baseUrl}`);
    console.log(`Admin:    ${ADMIN_EMAIL}`);
    console.log(`Rep:      ${REP_EMAIL}`);
    console.log(`RM:       ${RM_EMAIL}`);
    console.log(`Sub:      ${SUB_EMAIL}\n`);

    console.log("── Step 0: 创建测试账号 ──");

    const adminUser = await prisma.user.create({
      data: {
        email: ADMIN_EMAIL,
        name: "smoke-admin",
        password: await bcrypt.hash(ADMIN_PW, 12),
        role: "ADMIN",
      },
    });

    const repUser = await prisma.user.create({
      data: {
        email: REP_EMAIL,
        name: "smoke-rep",
        password: await bcrypt.hash(REP_PW, 12),
        role: "REPRESENTATIVE",
      },
    });

    const rep = await prisma.representative.create({
      data: { email: REP_EMAIL, name: "smoke-rep", kind: "HUMAN", archived: false },
    });

    const rmUser = await prisma.user.create({
      data: {
        email: RM_EMAIL,
        name: "smoke-rm",
        password: await bcrypt.hash(RM_PW, 12),
        role: "REGIONAL_MANAGER",
      },
    });

    await prisma.representative.create({
      data: { email: RM_EMAIL, name: "smoke-rm", kind: "HUMAN", archived: false },
    });

    await prisma.user.create({
      data: {
        email: SUB_EMAIL,
        name: "smoke-sub",
        password: await bcrypt.hash(SUB_PW, 12),
        role: "REPRESENTATIVE",
      },
    });

    const subRep = await prisma.representative.create({
      data: { email: SUB_EMAIL, name: "smoke-sub", kind: "HUMAN", archived: false },
    });

    const rmRecord = await prisma.crmRegionManager.create({
      data: { userId: rmUser.id },
    });
    await prisma.crmRegionManagerRepresentative.create({
      data: { managerId: rmRecord.id, representativeId: subRep.id },
    });

    const hq = await ensureHqRepresentative();
    const hqUserId = hq.ownerUserId;
    const hqPw = randomBytes(24).toString("base64url");
    await prisma.user.update({ where: { id: hqUserId }, data: { password: await bcrypt.hash(hqPw, 12) } });
    const hqUser = await prisma.user.findUniqueOrThrow({ where: { id: hqUserId }, select: { email: true } });

    console.log(`  Admin user: ${adminUser.id}`);
    console.log(`  Rep user:   ${repUser.id}`);
    console.log(`  RM user:    ${rmUser.id}`);
    console.log(`  HQ user:    ${hqUserId}\n`);

    console.log("── Step 1: SYSTEM_FALLBACK Profile-only 客户 ──");

    const fallbackName = `烟测本部兜底 ${RUN_ID.slice(0, 12)}`;
    const fallbackProfile = await prisma.crmCustomerProfile.create({
      data: {
        customerCode: `FB-${RUN_ID.slice(0, 8)}`,
        ownerUserId: hqUserId,
        name: fallbackName,
        archived: false,
        deleted: false,
        stage: "LEAD",
        assignmentStatus: "ASSIGNED",
      },
    });
    console.log(`  Fallback profile: ${fallbackProfile.id} (no Customer anchor)`);

    console.log("── Step 2: SYSTEM_FALLBACK 一致性验证 ──");

    const hqCookie = await login(baseUrl, hqUser.email, hqPw);
    const fbSearchProfiles = await getJson(
      baseUrl,
      `/api/crm/profiles?search=${encodeURIComponent(fallbackName)}&pageSize=20`,
      hqCookie,
    );
    const fbSearchList = await getJson(
      baseUrl,
      `/api/customers/list?search=${encodeURIComponent(fallbackName)}&limit=20`,
      hqCookie,
    );

    assertPass(fbSearchProfiles.status === 200, "SYSTEM_FALLBACK profiles 200", `status=${fbSearchProfiles.status}`);
    assertPass(fbSearchList.status === 200, "SYSTEM_FALLBACK list 200", `status=${fbSearchList.status}`);
    assertPass(
      hasProfile(fbSearchProfiles.data, fallbackProfile.id),
      "SYSTEM_FALLBACK profiles 可见",
      JSON.stringify({ total: (fbSearchProfiles.data as { total?: number }).total }),
    );
    assertPass(
      hasProfile(fbSearchList.data, fallbackProfile.id),
      "SYSTEM_FALLBACK list 可见",
      JSON.stringify({ count: ((fbSearchList.data as { customers?: unknown[] }).customers || []).length }),
    );

    const rejectSource = await getJson(
      baseUrl,
      `/api/crm/profiles?sourceCustomerId=${encodeURIComponent(fallbackProfile.id)}&pageSize=5`,
      hqCookie,
    );
    assertPass(rejectSource.status === 400, "profiles 拒 sourceCustomerId", `status=${rejectSource.status}`);

    console.log("\n── Step 3: 池分配客户 assign/recall ──");

    const poolName = `烟测池分配 ${RUN_ID.slice(0, 12)}`;
    const poolProfile = await prisma.crmCustomerProfile.create({
      data: {
        customerCode: `POOL-${RUN_ID.slice(0, 8)}`,
        ownerUserId: hqUserId,
        name: poolName,
        archived: false,
        deleted: false,
        stage: "LEAD",
        assignmentStatus: "ASSIGNED",
      },
    });
    console.log(`  Pool profile: ${poolProfile.id}`);

    const adminCookie = await login(baseUrl, ADMIN_EMAIL, ADMIN_PW);
    const assignRes = await postJson(baseUrl, `/api/crm/customer-pool/${poolProfile.id}/assign`, adminCookie, {
      representativeId: rep.id,
      reason: "smoke assign",
    });
    assertPass(assignRes.status === 200, "池分配 assign", `status=${assignRes.status}`);

    const repCookie = await login(baseUrl, REP_EMAIL, REP_PW);
    const poolProfilesAssigned = await getJson(
      baseUrl,
      `/api/crm/profiles?search=${encodeURIComponent(poolName)}&pageSize=20`,
      repCookie,
    );
    const poolListAssigned = await getJson(
      baseUrl,
      `/api/customers/list?search=${encodeURIComponent(poolName)}&limit=20`,
      repCookie,
    );
    const poolDetailAssigned = await getJson(baseUrl, `/api/crm/profiles/${poolProfile.id}`, repCookie);

    assertPass(
      hasProfile(poolProfilesAssigned.data, poolProfile.id),
      "assign 后 profiles 可见",
      JSON.stringify({ total: (poolProfilesAssigned.data as { total?: number }).total }),
    );
    assertPass(
      hasProfile(poolListAssigned.data, poolProfile.id),
      "assign 后 list 可见",
      JSON.stringify({ count: ((poolListAssigned.data as { customers?: unknown[] }).customers || []).length }),
    );
    assertPass(poolDetailAssigned.status === 200, "assign 后 profile detail 200", `status=${poolDetailAssigned.status}`);

    const recallRes = await postJson(baseUrl, `/api/crm/customer-pool/${poolProfile.id}/recall`, adminCookie, {
      reason: "smoke recall",
    });
    assertPass(recallRes.status === 200, "池分配 recall", `status=${recallRes.status}`);

    const activeTagsAfterRecall = await prisma.customerRepTag.findMany({
      where: { profileId: poolProfile.id, tagType: "MANAGING", isActive: true },
    });
    assertPass(
      activeTagsAfterRecall.length === 0,
      "recall 后 active MANAGING tag 归零",
      `count=${activeTagsAfterRecall.length}`,
    );

    const recallLogs = await prisma.crmCustomerAssignmentLog.findMany({
      where: { profileId: poolProfile.id, action: "RECALL" },
      orderBy: { createdAt: "asc" },
    });
    assertPass(recallLogs.length === 1, "recall 审计 log 唯一", `count=${recallLogs.length}`);
    assertPass(
      recallLogs[0]?.reason?.includes("active MANAGING tag") ?? false,
      "recall reason 含 MANAGING tag 退休信息",
      `reason=${recallLogs[0]?.reason}`,
    );

    const repCookieAfterRecall = await login(baseUrl, REP_EMAIL, REP_PW);
    const poolProfilesRecalled = await getJson(
      baseUrl,
      `/api/crm/profiles?search=${encodeURIComponent(poolName)}&pageSize=20`,
      repCookieAfterRecall,
    );
    const poolListRecalled = await getJson(
      baseUrl,
      `/api/customers/list?search=${encodeURIComponent(poolName)}&limit=20`,
      repCookieAfterRecall,
    );
    const poolDetailRecalled = await getJson(baseUrl, `/api/crm/profiles/${poolProfile.id}`, repCookieAfterRecall);

    assertPass(
      !hasProfile(poolProfilesRecalled.data, poolProfile.id),
      "recall 后 profiles 不可见",
      JSON.stringify({ total: (poolProfilesRecalled.data as { total?: number }).total }),
    );
    assertPass(
      !hasProfile(poolListRecalled.data, poolProfile.id),
      "recall 后 list 不可见",
      JSON.stringify({ count: ((poolListRecalled.data as { customers?: unknown[] }).customers || []).length }),
    );
    assertPass(poolDetailRecalled.status === 403, "recall 后 profile detail 403", `status=${poolDetailRecalled.status}`);

    console.log("\n── Step 4: REGIONAL_MANAGER 下辖覆盖 ──");

    const rmPoolName = `烟测RM下辖 ${RUN_ID.slice(0, 12)}`;
    const rmPoolProfile = await prisma.crmCustomerProfile.create({
      data: {
        customerCode: `RMPOOL-${RUN_ID.slice(0, 8)}`,
        ownerUserId: hqUserId,
        name: rmPoolName,
        archived: false,
        deleted: false,
        stage: "LEAD",
        assignmentStatus: "ASSIGNED",
      },
    });
    console.log(`  RM pool profile: ${rmPoolProfile.id}`);

    const assignRmRes = await postJson(baseUrl, `/api/crm/customer-pool/${rmPoolProfile.id}/assign`, adminCookie, {
      representativeId: subRep.id,
      reason: "smoke rm subordinate assign",
    });
    assertPass(assignRmRes.status === 200, "RM 下辖 assign", `status=${assignRmRes.status}`);

    const rmCookie = await login(baseUrl, RM_EMAIL, RM_PW);
    const rmProfiles = await getJson(
      baseUrl,
      `/api/crm/profiles?search=${encodeURIComponent(rmPoolName)}&pageSize=20`,
      rmCookie,
    );
    const rmList = await getJson(
      baseUrl,
      `/api/customers/list?search=${encodeURIComponent(rmPoolName)}&limit=20&crmScope=true`,
      rmCookie,
    );
    const rmDetail = await getJson(baseUrl, `/api/crm/profiles/${rmPoolProfile.id}`, rmCookie);

    assertPass(
      hasProfile(rmProfiles.data, rmPoolProfile.id),
      "RM profiles 可见下辖客户",
      JSON.stringify({ total: (rmProfiles.data as { total?: number }).total }),
    );
    assertPass(
      hasProfile(rmList.data, rmPoolProfile.id),
      "RM list (crmScope=true) 可见下辖客户",
      JSON.stringify({ count: ((rmList.data as { customers?: unknown[] }).customers || []).length }),
    );
    assertPass(rmDetail.status === 200, "RM profile detail 200", `status=${rmDetail.status}`);

    console.log("\n=== 全部冒烟步骤通过 ===");
  });
}

main()
  .then(() => {
    console.log("\n结果汇总:");
    for (const r of RESULTS) {
      console.log(`[${r.status}] ${r.step}: ${r.detail}`);
    }
    process.exit(0);
  })
  .catch((err) => {
    console.error("\n冒烟测试失败:", err instanceof Error ? err.message : err);
    console.log("\n结果汇总:");
    for (const r of RESULTS) {
      console.log(`[${r.status}] ${r.step}: ${r.detail}`);
    }
    process.exit(1);
  });

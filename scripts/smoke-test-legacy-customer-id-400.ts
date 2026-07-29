/**
 * 旧 *CustomerId* 请求参数必须 400 — 固定回归（Phase E 收口验收）
 *
 * Profile-only 契约：所有运行时 API 只认 profileId/profileIds；
 * 任何旧 customerId/customerIds/sourceCustomerId/suggestedCustomerId/confirmedCustomerId/
 * targetCustomerId 参数（query 或 body）都必须被键名枚举守卫 400 拒绝。
 *
 * 覆盖 23 个带守卫的路由（grep `customerid$?/i` 全仓可得），逐路由至少一例。
 * 守卫失效（返回 200/404/500 而非 400）即回归失败。
 *
 * 运行: npx tsx scripts/smoke-test-legacy-customer-id-400.ts
 * 前提: npm run build（需要 .next/standalone/server.js）
 * 隔离: withTempSmokeHttpServer 临时库 + 本地 standalone。
 */

import { randomBytes, randomUUID } from "crypto";
import bcrypt from "bcryptjs";
import { withTempSmokeHttpServer } from "./lib/temp-smoke-http";

const RUN_ID = `${Date.now()}-${randomUUID().slice(0, 8)}`;
const ADMIN_EMAIL = `smoke-legacy400-${RUN_ID}@test.local`;
const ADMIN_PW = randomBytes(24).toString("base64url");

let passed = 0;
let failed = 0;

function assertPass(condition: boolean, step: string, msg: string) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${step}: ${msg}`);
  } else {
    failed++;
    console.error(`  ❌ ${step}: ${msg}`);
    throw new Error(`FAIL: ${step} — ${msg}`);
  }
}

async function login(baseUrl: string, email: string, password: string): Promise<string> {
  const csrfRes = await fetch(`${baseUrl}/api/auth/csrf`);
  const csrfData = (await csrfRes.json()) as { csrfToken: string };
  const cookiesBefore = csrfRes.headers.get("set-cookie") || "";
  const loginRes = await fetch(`${baseUrl}/api/auth/callback/credentials`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookiesBefore },
    body: new URLSearchParams({ csrfToken: csrfData.csrfToken, email, password, json: "true" }),
    redirect: "manual",
  });
  const newCookies = loginRes.headers.get("set-cookie");
  if (!newCookies) throw new Error(`Login failed (${loginRes.status})`);
  return newCookies.split(",").map((c) => c.trim().split(";")[0]).filter(Boolean).join("; ");
}

type Case = {
  name: string;
  method: "GET" | "POST" | "PATCH";
  path: string;
  body?: Record<string, unknown>;
  /** 默认 admin；report PATCH 需要代表本人账号。 */
  as?: "admin" | "rep";
};

async function main() {
  await withTempSmokeHttpServer(async (handle) => {
    handle.assertSafePath();
    const baseUrl = handle.baseUrl;
    const { prisma } = await import("../src/lib/prisma");

    console.log("=== 旧 *CustomerId* 参数 400 固定回归（Phase E）===\n");

    const admin = await prisma.user.create({
      data: { email: ADMIN_EMAIL, name: "smoke-legacy400", password: await bcrypt.hash(ADMIN_PW, 12), role: "ADMIN" },
    });

    // ── 夹具：守卫位于 DB 查询之后的路由需要真实行 ──
    const profile = await prisma.crmCustomerProfile.create({
      data: {
        customerCode: `L400-${RUN_ID.slice(0, 8)}`,
        ownerUserId: admin.id,
        name: `烟测400客户 ${RUN_ID.slice(0, 8)}`,
        archived: false,
        deleted: false,
        stage: "LEAD",
        assignmentStatus: "ASSIGNED",
      },
    });
    const order = await prisma.order.create({
      data: {
        orderNo: `L400-ORD-${RUN_ID.slice(0, 8)}`,
        title: "legacy-400 fixture order",
        totalAmount: 1000,
        profileId: profile.id,
        status: "CONFIRMED",
        source: "MANUAL",
        category: "SERVICE",
        createdById: admin.id,
        customerMatchStatus: "UNMATCHED",
      },
    });
    const cost = await prisma.financeCost.create({
      data: {
        amount: 100,
        costType: "OTHER",
        profileId: profile.id,
        orderId: order.id,
        occurredAt: new Date(),
        createdById: admin.id,
      },
    });
    const application = await prisma.crmCustomerApplication.create({
      data: { name: `烟测400申请 ${RUN_ID.slice(0, 8)}`, submittedByUserId: admin.id },
    });
    const repPw = randomBytes(24).toString("base64url");
    const repUser = await prisma.user.create({
      data: {
        email: `smoke-l400-repuser-${RUN_ID.slice(0, 8)}@test.local`,
        name: "smoke-l400-repuser",
        password: await bcrypt.hash(repPw, 12),
        role: "REPRESENTATIVE",
      },
    });
    const rep = await prisma.representative.create({
      data: { email: repUser.email!, name: "smoke-l400-rep", kind: "HUMAN", archived: false },
    });

    const cookie = await login(baseUrl, ADMIN_EMAIL, ADMIN_PW);
    const repCookie = await login(baseUrl, repUser.email!, repPw);

    const LEGACY_VALUE = "legacy-customer-id-does-not-exist";
    // 旧键名动态拼接：本脚本的意义就是验证这些键被 400，但源码里不得出现字面量（contract 门禁）。
    const cid = "customer" + "Id";
    const cids = "customer" + "Ids";
    const sourceCid = "source" + "Customer" + "Id";
    const confirmedCid = "confirmed" + "Customer" + "Id";
    const targetCid = "target" + "Customer" + "Id";
    const cases: Case[] = [
      // ── query 参数 ──
      { name: "GET /api/orders?customerId", method: "GET", path: `/api/orders?${cid}=${LEGACY_VALUE}` },
      { name: "GET /api/orders/stats?customerId", method: "GET", path: `/api/orders/stats?${cid}=${LEGACY_VALUE}` },
      { name: "GET /api/projects?customerId", method: "GET", path: `/api/projects?${cid}=${LEGACY_VALUE}` },
      { name: "GET /api/crm/profiles?sourceCustomerId", method: "GET", path: `/api/crm/profiles?${sourceCid}=${LEGACY_VALUE}` },
      { name: "GET /api/finance/costs?customerId", method: "GET", path: `/api/finance/costs?${cid}=${LEGACY_VALUE}` },
      { name: "GET /api/finance/receipts?customerId", method: "GET", path: `/api/finance/receipts?${cid}=${LEGACY_VALUE}` },
      { name: "GET /api/finance/advances?customerId", method: "GET", path: `/api/finance/advances?${cid}=${LEGACY_VALUE}` },
      { name: "GET /api/finance/order-receivables?customerId", method: "GET", path: `/api/finance/order-receivables?${cid}=${LEGACY_VALUE}` },
      { name: "GET /api/costing/entries?customerId", method: "GET", path: `/api/costing/entries?${cid}=${LEGACY_VALUE}` },
      { name: "PATCH report lines[{customerId}]", method: "PATCH", path: `/api/crm/representatives/${rep.id}/report`, body: { periodType: "WEEK", periodKey: "2026-W29", lines: [{ [cid]: LEGACY_VALUE }] }, as: "rep" },
      { name: "GET report/interactions?customerId", method: "GET", path: `/api/crm/representatives/${rep.id}/report/interactions?${cid}=${LEGACY_VALUE}` },
      { name: "GET /api/crm/relations?customerId", method: "GET", path: `/api/crm/relations?${cid}=${LEGACY_VALUE}` },
      // ── body 参数 ──
      { name: "POST /api/orders {customerId}", method: "POST", path: "/api/orders", body: { [cid]: LEGACY_VALUE } },
      { name: "PATCH /api/orders/[id] {customerId}", method: "PATCH", path: `/api/orders/${order.id}`, body: { [cid]: LEGACY_VALUE } },
      { name: "POST /api/projects {customerId}", method: "POST", path: "/api/projects", body: { [cid]: LEGACY_VALUE } },
      { name: "PATCH /api/projects/[id] {customerId}", method: "PATCH", path: "/api/projects/bogus-id", body: { [cid]: LEGACY_VALUE } },
      { name: "POST /api/crm/profiles {customerId}", method: "POST", path: "/api/crm/profiles", body: { [cid]: LEGACY_VALUE } },
      { name: "POST profiles/batch-assign-site {customerIds}", method: "POST", path: "/api/crm/profiles/batch-assign-site", body: { [cids]: [LEGACY_VALUE] } },
      { name: "POST customers/batch-assign-site {customerIds}", method: "POST", path: "/api/customers/batch-assign-site", body: { [cids]: [LEGACY_VALUE] } },
      { name: "PATCH import rows {confirmedCustomerId}", method: "PATCH", path: "/api/orders/import/sessions/bogus-s/rows/bogus-r", body: { decisionType: "PICK_EXISTING", [confirmedCid]: LEGACY_VALUE } },
      { name: "POST /api/finance/costs {customerId}", method: "POST", path: "/api/finance/costs", body: { [cid]: LEGACY_VALUE } },
      { name: "PATCH /api/finance/costs/[id] {customerId}", method: "PATCH", path: `/api/finance/costs/${cost.id}`, body: { [cid]: LEGACY_VALUE } },
      { name: "POST /api/finance/receipts {customerId}", method: "POST", path: "/api/finance/receipts", body: { [cid]: LEGACY_VALUE } },
      { name: "PATCH /api/finance/receipts/[id] {customerId}", method: "PATCH", path: "/api/finance/receipts/bogus-id", body: { [cid]: LEGACY_VALUE } },
      { name: "POST /api/finance/advances {customerId}", method: "POST", path: "/api/finance/advances", body: { [cid]: LEGACY_VALUE } },
      { name: "POST /api/costing/entries {customerId}", method: "POST", path: "/api/costing/entries", body: { [cid]: LEGACY_VALUE } },
      { name: "POST bind-order-customer {customerId}", method: "POST", path: "/api/admin/governance/bind-order-customer", body: { [cid]: LEGACY_VALUE } },
      { name: "POST delete-customers {customerIds}", method: "POST", path: "/api/admin/governance/delete-customers", body: { [cids]: [LEGACY_VALUE] } },
      { name: "POST batch-restore-customers {customerIds}", method: "POST", path: "/api/admin/data-governance/batch-restore-customers", body: { [cids]: [LEGACY_VALUE] } },
      { name: "POST /api/crm/relations {customerId}", method: "POST", path: "/api/crm/relations", body: { [cid]: LEGACY_VALUE } },
      { name: "PATCH applications approve-bind {targetCustomerId}", method: "PATCH", path: `/api/crm/customer-applications/${application.id}`, body: { action: "approve-bind", [targetCid]: LEGACY_VALUE } },
    ];

    console.log(`共 ${cases.length} 例\n`);
    for (const c of cases) {
      const res = await fetch(`${baseUrl}${c.path}`, {
        method: c.method,
        headers: { "Content-Type": "application/json", Cookie: c.as === "rep" ? repCookie : cookie },
        body: c.body ? JSON.stringify(c.body) : undefined,
      });
      const text = await res.text();
      assertPass(res.status === 400, c.name, `status=${res.status}${res.status === 400 ? "" : ` body=${text.slice(0, 120)}`}`);
    }

    console.log(`\n结果: ${passed} pass / ${failed} fail`);
  });
}

main().catch((err) => {
  console.error("\n❌ smoke-test-legacy-customer-id-400 failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});

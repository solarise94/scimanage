/**
 * 一次性冒烟测试：验证 Order.buyerOrganizationId profile 主权修复（临时库 + 本地 standalone）。
 *
 * Usage: npx tsx scripts/smoke-test-buyer-org-profile.ts
 * 前提: npm run build（需要 .next/standalone/server.js）
 */
import bcrypt from "bcryptjs";
import { withTempSmokeHttpServer } from "./lib/temp-smoke-http";

const rnd = (p: string) => `${p}_${Math.random().toString(36).slice(2, 10)}`;
const log = (label: string, ok: boolean, detail = "") =>
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);

function getAllCookies(res: Response): string {
  const raw = typeof res.headers.getSetCookie === "function"
    ? res.headers.getSetCookie()
    : [res.headers.get("set-cookie") || ""];
  return raw.map((c) => c.split(";")[0]).filter(Boolean).join("; ");
}

async function getCsrfAndCookies(baseUrl: string): Promise<{ csrfToken: string; cookie: string }> {
  const res = await fetch(`${baseUrl}/api/auth/csrf`, { credentials: "include" });
  if (!res.ok) throw new Error(`csrf fetch failed: ${res.status}`);
  const { csrfToken } = await res.json() as { csrfToken: string };
  return { csrfToken, cookie: getAllCookies(res) };
}

async function login(baseUrl: string, email: string, password: string): Promise<string> {
  const { csrfToken, cookie } = await getCsrfAndCookies(baseUrl);
  const res = await fetch(`${baseUrl}/api/auth/callback/credentials`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", cookie },
    body: new URLSearchParams({ csrfToken, email, password, json: "true" }),
    redirect: "manual",
  });
  const allCookies = getAllCookies(res);
  if (!allCookies.includes("next-auth.session-token") && !allCookies.includes("__Secure-")) {
    throw new Error(`login failed: status=${res.status}`);
  }
  return allCookies;
}

async function main() {
  await withTempSmokeHttpServer(async (handle) => {
    const baseUrl = handle.baseUrl;
    const { prisma } = await import("../src/lib/prisma");

    const email = `${rnd("smoke")}@example.test`;
    const password = rnd("pw");
    const user = await prisma.user.create({
      data: { email, name: "smoke-tester", password: await bcrypt.hash(password, 12), role: "ADMIN" },
    });
    console.log(`\n[setup] created temp admin ${email} (${user.id})`);
    console.log(`BASE_URL: ${baseUrl}`);

    let sessionCookie = "";
    let orderId: string | undefined;
    let profileWithOrgId: string | undefined;
    let profileNoOrgId: string | undefined;

    try {
      sessionCookie = await login(baseUrl, email, password);
      log("login (NextAuth credentials)", true, "got session cookie");

      const authed = (body: string, method = "POST", ctype = "application/json") => ({
        method,
        headers: { "Content-Type": ctype, cookie: sessionCookie },
        body,
      });

      console.log("\n[4] backfill dry-run:");
      const bfRes = await fetch(`${baseUrl}/api/admin/governance/backfill-order-buyer-org`, authed("{}"));
      const bfData = await bfRes.json() as Record<string, unknown>;
      const bfOk = bfRes.status === 200 &&
        typeof bfData.scanned === "number" &&
        Array.isArray(bfData.invalidProfileOrg) &&
        Array.isArray(bfData.hasFinance) &&
        "skippedNoProfileOrg" in bfData &&
        bfData.dryRun === true;
      log("backfill dryRun returns graded result", bfOk,
        `status=${bfRes.status} scanned=${bfData.scanned} plans=${bfData.plans}`);

      const org = await prisma.organization.create({
        data: {
          canonicalName: `开票机构-${rnd("org")}`,
          normalizedName: `invoice-org-${rnd("n")}`,
          orgCode: rnd("ORG").toUpperCase(),
          isInvoiceSubject: true,
        },
      });

      const profileWithOrg = await prisma.crmCustomerProfile.create({
        data: {
          customerCode: rnd("C").toUpperCase(),
          name: rnd("profile-org"),
          organizationId: org.id,
          organization: org.canonicalName,
          stage: "ACTIVE",
          assignmentStatus: "ASSIGNED",
          assignedAt: new Date(),
          importance: "NORMAL",
          personCategory: "PI",
          ownerUserId: user.id,
        },
      });
      profileWithOrgId = profileWithOrg.id;

      const profileNoOrg = await prisma.crmCustomerProfile.create({
        data: {
          customerCode: rnd("C").toUpperCase(),
          name: rnd("profile-noorg"),
          organizationId: null,
          stage: "ACTIVE",
          assignmentStatus: "ASSIGNED",
          assignedAt: new Date(),
          importance: "NORMAL",
          personCategory: "PI",
          ownerUserId: user.id,
        },
      });
      profileNoOrgId = profileNoOrg.id;

      console.log("\n[5] 手工建单 → buyerOrganizationId 来自 profile:");
      const createRes = await fetch(`${baseUrl}/api/orders`, authed(JSON.stringify({
        title: rnd("smoke-order"),
        profileId: profileWithOrg.id,
        totalAmount: 100,
        status: "DRAFT",
      })));
      const createData = await createRes.json() as Record<string, unknown>;
      orderId = (createData.order as Record<string, unknown> | undefined)?.id as string | undefined;
      let createOk = false;
      let createDetail = `status=${createRes.status}`;
      if (orderId) {
        const created = await prisma.order.findUnique({
          where: { id: orderId },
          select: { buyerOrganizationId: true, profileId: true, orderNo: true },
        });
        createOk = created?.buyerOrganizationId === org.id && created?.profileId === profileWithOrg.id;
        createDetail += ` orderNo=${created?.orderNo} buyerOrgId=${created?.buyerOrganizationId?.slice(-6)} profileId=${created?.profileId?.slice(-6)}`;
      } else {
        createDetail += ` error=${JSON.stringify(createData).slice(0, 200)}`;
      }
      log("手工建单 buyerOrganizationId 来自 profile", createOk, createDetail);

      console.log("\n[6] 换绑到无 org profile → buyer org 清空:");
      let rebindOk = false;
      let rebindDetail = "";
      if (orderId) {
        const before = await prisma.order.findUnique({
          where: { id: orderId },
          select: { buyerOrganizationId: true },
        });
        const rebindRes = await fetch(
          `${baseUrl}/api/admin/governance/bind-order-customer`,
          authed(JSON.stringify({
            orderIds: [orderId],
            profileId: profileNoOrg.id,
            mode: "REBIND",
            reason: "smoke-test-rebind",
            confirm: true,
          })),
        );
        const rebindData = await rebindRes.json() as Record<string, unknown>;
        if (rebindRes.status === 200 && (rebindData.bound as number) > 0) {
          const after = await prisma.order.findUnique({
            where: { id: orderId },
            select: { buyerOrganizationId: true, profileId: true },
          });
          rebindOk = after?.buyerOrganizationId === null && after?.profileId === profileNoOrg.id;
          rebindDetail = `before=${before?.buyerOrganizationId?.slice(-6) ?? "null"} after=${after?.buyerOrganizationId ?? "null"} profile=${after?.profileId?.slice(-6)}`;
        } else {
          rebindDetail = `status=${rebindRes.status} body=${JSON.stringify(rebindData).slice(0, 120)}`;
        }
      } else {
        rebindDetail = "skipped: 建单失败无法测换绑";
      }
      log("换绑到无 org profile buyer org 清空不继承", rebindOk, rebindDetail);

      const allOk = bfOk && createOk && rebindOk;
      console.log(`\n=== 结果: ${allOk ? "ALL PASS" : "有失败项，见上"} ===`);
      if (!allOk) process.exitCode = 1;
    } finally {
      if (orderId) {
        await prisma.orderLine.deleteMany({ where: { orderId } }).catch(() => {});
        await prisma.order.delete({ where: { id: orderId } }).catch(() => {});
      }
      const profileIds = [profileWithOrgId, profileNoOrgId].filter(Boolean) as string[];
      if (profileIds.length) {
        await prisma.crmCustomerProfile.deleteMany({ where: { id: { in: profileIds } } }).catch(() => {});
      }
      await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
      console.log("[cleanup] deleted temp admin + profiles");
    }
  });
}

main().catch((e) => {
  console.error("[smoke] 异常:", e);
  process.exit(1);
});

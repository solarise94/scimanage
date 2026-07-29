#!/usr/bin/env tsx
/**
 * Smoke test: multiple invoices matched into one allocation receipt can be
 * created and then retrieved through the public API.
 *
 * Usage: npx tsx scripts/smoke-payment-voucher-retrieval.ts
 * 前提: npm run build（需要 .next/standalone/server.js）
 */
import bcrypt from "bcryptjs";
import { withTempSmokeHttpServer } from "./lib/temp-smoke-http";

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function extractCookie(setCookie: string | string[] | null, name: string): string | null {
  if (!setCookie) return null;
  const raw = Array.isArray(setCookie) ? setCookie : [setCookie];
  const parts: string[] = [];
  for (const r of raw) {
    parts.push(...r.split(", "));
  }
  for (const c of parts) {
    const match = c.match(new RegExp(`(^|;)\\s*${name}=([^;]+)`));
    if (match) return match[2];
  }
  return null;
}

async function login(baseUrl: string, email: string, password: string): Promise<string> {
  const csrfRes = await fetch(`${baseUrl}/api/auth/csrf`, { credentials: "include" });
  const csrfData = await csrfRes.json();
  const csrfToken = csrfData.csrfToken;
  const csrfCookie = csrfRes.headers.get("set-cookie") || "";

  const params = new URLSearchParams();
  params.set("csrfToken", csrfToken);
  params.set("email", email);
  params.set("password", password);
  params.set("callbackUrl", baseUrl);
  params.set("json", "true");

  const loginRes = await fetch(`${baseUrl}/api/auth/callback/credentials`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: csrfCookie,
    },
    body: params.toString(),
    redirect: "manual",
  });

  const sessionToken = extractCookie(loginRes.headers.get("set-cookie"), "next-auth.session-token");
  if (!sessionToken) {
    const body = await loginRes.text();
    throw new Error(`Login failed: ${loginRes.status} ${body}`);
  }
  return `next-auth.session-token=${sessionToken}`;
}

async function apiFetch(baseUrl: string, path: string, cookie: string, init?: RequestInit) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { Cookie: cookie, ...(init?.headers || {}) },
  });
}

async function main() {
  await withTempSmokeHttpServer(async (handle) => {
    const baseUrl = handle.baseUrl;
    const { prisma } = await import("../src/lib/prisma");

    console.log("=== Smoke Test: Payment Voucher Allocation Receipt Retrieval ===\n");
    console.log(`BASE_URL: ${baseUrl}\n`);

    const email = `smoke-${Date.now()}@scimanage.local`;
    const password = "SmokePass123!";
    const user = await prisma.user.create({
      data: { email, name: "Smoke Admin", role: "ADMIN", password: await bcrypt.hash(password, 12) },
    });

    const cookie = await login(baseUrl, email, password);

    const org = await prisma.organization.create({
      data: { canonicalName: `Smoke Org ${Date.now()}`, normalizedName: `smoke org ${Date.now()}`, orgCode: `SMOKE-${Date.now()}` },
    });
    const profile = await prisma.crmCustomerProfile.create({
      data: {
        name: `Smoke Profile ${Date.now()}`,
        customerCode: `SMOKE-CUST-${Date.now()}`,
        ownerUserId: user.id,
        stage: "ACTIVE",
      },
    });
    const now = new Date();
    const order1 = await prisma.order.create({
      data: {
        orderNo: `SO-${Date.now()}-1`,
        source: "MANUAL",
        title: "Smoke Order 1",
        status: "NOT_STARTED",
        orderedAt: now,
        profileId: profile.id,
        totalAmount: 30_000, // 分 = ¥300
        createdById: user.id,
      },
    });
    const order2 = await prisma.order.create({
      data: {
        orderNo: `SO-${Date.now()}-2`,
        source: "MANUAL",
        title: "Smoke Order 2",
        status: "NOT_STARTED",
        orderedAt: now,
        profileId: profile.id,
        totalAmount: 50_000, // 分 = ¥500
        createdById: user.id,
      },
    });

    const inv1 = await prisma.externalOrderInvoiceRequest.create({
      data: {
        orderId: order1.id,
        buyerOrganizationId: org.id,
        buyerOrganizationName: org.canonicalName,
        actualInvoiceNo: `INV-${Date.now()}-1`,
        totalAmount: 30_000, // 分 = ¥300
        status: "ISSUED",
        invoiceType: "NORMAL",
        createdById: user.id,
      },
    });
    const inv2 = await prisma.externalOrderInvoiceRequest.create({
      data: {
        orderId: order2.id,
        buyerOrganizationId: org.id,
        buyerOrganizationName: org.canonicalName,
        actualInvoiceNo: `INV-${Date.now()}-2`,
        totalAmount: 50_000, // 分 = ¥500
        status: "ISSUED",
        invoiceType: "NORMAL",
        createdById: user.id,
      },
    });

    const matchRes = await apiFetch(baseUrl, "/api/finance/payment-vouchers/match", cookie, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ organizationId: org.id, amount: 800, receivedAt: todayStr() }),
    });
    if (!matchRes.ok) throw new Error(`Match API failed: ${matchRes.status} ${await matchRes.text()}`);
    const matchData = await matchRes.json();
    if (matchData.status !== "MATCHED" || !matchData.combinations?.length) {
      throw new Error(`Expected MATCHED with combinations, got ${JSON.stringify(matchData)}`);
    }
    const combo = matchData.combinations[0];
    // match 响应金额单位：分
    if (combo.count !== 2 || combo.sum !== 80_000) {
      throw new Error(`Expected 2-invoice combo sum 80000(分), got ${combo.count} / ${combo.sum}`);
    }
    const comboIds = new Set(combo.invoiceIds);
    if (!comboIds.has(inv1.id) || !comboIds.has(inv2.id)) {
      throw new Error(`Expected combo to include both smoke invoices`);
    }
    console.log("✓ Match API returned 2-invoice combination for ¥800.00 (80000 cents)");

    // match→write 端到端：响应为分，receipts 请求体为元
    const allocations = combo.invoiceIds.map((invoiceId: string, i: number) => ({
      invoiceId,
      amount: combo.amounts[i] / 100,
    }));
    const receiptRes = await apiFetch(baseUrl, "/api/finance/receipts", cookie, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        amount: 800,
        receivedAt: todayStr(),
        source: "BANK",
        organizationId: org.id,
        allocations,
      }),
    });
    if (!receiptRes.ok) throw new Error(`Receipt creation failed: ${receiptRes.status}`);
    const receiptData = await receiptRes.json();
    const receiptId = receiptData.receipt.id;
    console.log(`✓ Created allocation receipt ${receiptId} from match combo`);

    const listRes = await apiFetch(baseUrl, `/api/finance/receipts?dateFrom=${todayStr()}&dateTo=${todayStr()}`, cookie);
    const listData = await listRes.json();
    const foundByDate = listData.receipts.find((r: { id: string }) => r.id === receiptId);
    if (!foundByDate || foundByDate.allocationCount !== 2) {
      throw new Error(`Receipt not found by date range or allocationCount != 2`);
    }
    console.log("✓ Receipt retrieved by date range with allocationCount=2");

    for (const oid of [order1.id, order2.id]) {
      const orderRes = await apiFetch(baseUrl, `/api/finance/receipts?orderId=${oid}`, cookie);
      const orderData = await orderRes.json();
      if (!orderData.receipts.find((r: { id: string }) => r.id === receiptId)) {
        throw new Error(`Receipt not found by orderId=${oid}`);
      }
      console.log(`✓ Receipt retrieved by orderId=${oid}`);
    }

    const detailRes = await apiFetch(baseUrl, `/api/finance/receipts/${receiptId}`, cookie);
    const detail = await detailRes.json();
    if (!detail.allocations || detail.allocations.length !== 2) {
      throw new Error(`Expected 2 allocations in detail, got ${detail.allocations?.length}`);
    }
    console.log("✓ Receipt detail contains 2 allocations");

    const orRes = await apiFetch(baseUrl, "/api/finance/order-receivables", cookie);
    const orData = await orRes.json();
    const or1 = orData.orders.find((i: { id: string }) => i.id === order1.id);
    const or2 = orData.orders.find((i: { id: string }) => i.id === order2.id);
    if (!or1 || or1.receivedAmount < 300 - 0.001) throw new Error(`Order1 receivedAmount too low`);
    if (!or2 || or2.receivedAmount < 500 - 0.001) throw new Error(`Order2 receivedAmount too low`);
    console.log("✓ Order receivables reflected cross-order allocation");

    console.log("\n=== RESULTS: all retrieval checks passed ===");
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

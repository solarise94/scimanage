/**
 * Payment Voucher Fixes HTTP smoke — 临时库 + 本地 standalone。
 *
 * Usage: npx tsx scripts/smoke-test-payment-voucher-fixes.ts
 * 前提: npm run build（需要 .next/standalone/server.js）
 */
import { randomBytes, randomUUID } from "crypto";
import bcrypt from "bcryptjs";
import { withTempSmokeHttpServer } from "./lib/temp-smoke-http";

const TEST_EMAIL = `smoke-${Date.now()}-${randomUUID().slice(0, 8)}@test.local`;
const TEST_PASSWORD = randomBytes(24).toString("base64url");

async function login(baseUrl: string, email: string, password: string): Promise<string> {
  const csrfRes = await fetch(`${baseUrl}/api/auth/csrf`);
  const csrfData = await csrfRes.json();
  const csrfToken = csrfData.csrfToken;
  const cookies = csrfRes.headers.get("set-cookie") || "";

  const loginRes = await fetch(`${baseUrl}/api/auth/callback/credentials`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: cookies,
    },
    body: new URLSearchParams({
      csrfToken,
      email,
      password,
      json: "true",
    } as Record<string, string>),
    redirect: "manual",
  });

  const newCookies = loginRes.headers.get("set-cookie");
  if (!newCookies) {
    const text = await loginRes.text();
    throw new Error(`Login failed: ${loginRes.status} ${text.slice(0, 200)}`);
  }
  return newCookies
    .split(",")
    .map((c) => c.trim().split(";")[0])
    .filter(Boolean)
    .join("; ");
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

async function main() {
  await withTempSmokeHttpServer(async (handle) => {
    const baseUrl = handle.baseUrl;
    const { prisma } = await import("../src/lib/prisma");

    console.log("=== Payment Voucher Fixes Smoke Test ===");
    console.log(`BASE_URL: ${baseUrl}`);
    console.log(`Test account: ${TEST_EMAIL}（一次性，跑完即删）`);

    const admin = await prisma.user.create({
      data: {
        email: TEST_EMAIL,
        name: "smoke-test",
        password: await bcrypt.hash(TEST_PASSWORD, 12),
        role: "ADMIN",
      },
      select: { id: true },
    });

    const cookie = await login(baseUrl, TEST_EMAIL, TEST_PASSWORD);
    console.log("Login OK");

    const createdReceiptIds: string[] = [];
    const createdInvoiceIds: string[] = [];
    const createdOrderIds: string[] = [];
    const createdProfileIds: string[] = [];
    let orgId: string | null = null;

    async function createProfile(name: string, codeSuffix: string) {
      const profile = await prisma.crmCustomerProfile.create({
        data: {
          customerCode: `CUST-${codeSuffix}-${Date.now()}`,
          name,
          ownerUserId: admin.id,
          stage: "ACTIVE",
        },
        select: { id: true },
      });
      createdProfileIds.push(profile.id);
      return profile;
    }

    try {
      const org = await prisma.organization.create({
        data: {
          canonicalName: "烟测机构-凭证匹配",
          normalizedName: "yan-ce-ji-gou",
          orgCode: `SMOKE-${Date.now()}`,
        },
      });
      orgId = org.id;

      const profileA = await createProfile("客户A", "A");
      const profileB = await createProfile("客户B", "B");

      const orderA = await prisma.order.create({
        data: {
          orderNo: `TEST-A-${Date.now()}`,
          source: "MANUAL",
          profileId: profileA.id,
          title: "测试订单A",
          createdById: admin.id,
        },
      });
      const orderB = await prisma.order.create({
        data: {
          orderNo: `TEST-B-${Date.now() + 1}`,
          source: "MANUAL",
          profileId: profileB.id,
          title: "测试订单B",
          createdById: admin.id,
        },
      });
      createdOrderIds.push(orderA.id, orderB.id);

      const invoiceA = await prisma.externalOrderInvoiceRequest.create({
        data: {
          orderId: orderA.id,
          buyerOrganizationId: org.id,
          buyerOrganizationName: org.canonicalName,
          totalAmount: 100_000, // 分 = ¥1000
          status: "ISSUED",
          actualIssuedAt: new Date(),
          createdById: admin.id,
        },
      });
      const invoiceB = await prisma.externalOrderInvoiceRequest.create({
        data: {
          orderId: orderB.id,
          buyerOrganizationId: org.id,
          buyerOrganizationName: org.canonicalName,
          totalAmount: 100_000, // 分 = ¥1000
          status: "ISSUED",
          actualIssuedAt: new Date(),
          createdById: admin.id,
        },
      });
      createdInvoiceIds.push(invoiceA.id, invoiceB.id);

      console.log("\n#3 Cross-profile match (amount=¥1000)");
      const match3 = await postJson(baseUrl, "/api/finance/payment-vouchers/match", cookie, {
        organizationId: org.id,
        amount: 1000, // 元
      });
      console.log("status", match3.status);
      console.log("combinations count", match3.data.combinations?.length);
      const comboProfileIds = await Promise.all(
        (match3.data.combinations || []).map(async (c: { invoiceIds: string[] }) => {
          const inv = await prisma.externalOrderInvoiceRequest.findUnique({
            where: { id: c.invoiceIds[0] },
            select: { order: { select: { profileId: true } } },
          });
          return inv?.order?.profileId ?? null;
        }),
      );
      console.log("profileIds", comboProfileIds);
      if (match3.status !== 200 || match3.data.combinations?.length !== 2) {
        throw new Error("#3 failed: expected 2 single-invoice combinations");
      }
      const distinctProfiles = new Set(comboProfileIds.filter(Boolean));
      if (distinctProfiles.size !== 2) {
        throw new Error(`#3 failed: expected combos from 2 profiles, got ${distinctProfiles.size}`);
      }
      for (const c of match3.data.combinations || []) {
        if (c.sum !== 100_000 || c.amounts?.[0] !== 100_000) {
          throw new Error(`#3 failed: expected combo amounts in cents (100000), got ${JSON.stringify(c)}`);
        }
      }

      console.log("\n#3b nearest grouping (amount=¥700, no exact match)");
      const profileC = await createProfile("客户C", "C");
      const profileD = await createProfile("客户D", "D");

      const orderC = await prisma.order.create({
        data: {
          orderNo: `TEST-C-${Date.now()}`,
          source: "MANUAL",
          profileId: profileC.id,
          title: "测试订单C",
          createdById: admin.id,
        },
      });
      const orderD = await prisma.order.create({
        data: {
          orderNo: `TEST-D-${Date.now() + 1}`,
          source: "MANUAL",
          profileId: profileD.id,
          title: "测试订单D",
          createdById: admin.id,
        },
      });
      createdOrderIds.push(orderC.id, orderD.id);

      const invoiceNearestC = await prisma.externalOrderInvoiceRequest.create({
        data: {
          orderId: orderC.id,
          buyerOrganizationId: org.id,
          buyerOrganizationName: org.canonicalName,
          totalAmount: 60_000, // 分 = ¥600
          status: "ISSUED",
          actualIssuedAt: new Date(),
          createdById: admin.id,
        },
      });
      const invoiceNearestD = await prisma.externalOrderInvoiceRequest.create({
        data: {
          orderId: orderD.id,
          buyerOrganizationId: org.id,
          buyerOrganizationName: org.canonicalName,
          totalAmount: 40_000, // 分 = ¥400
          status: "ISSUED",
          actualIssuedAt: new Date(),
          createdById: admin.id,
        },
      });
      createdInvoiceIds.push(invoiceNearestC.id, invoiceNearestD.id);

      const match3b = await postJson(baseUrl, "/api/finance/payment-vouchers/match", cookie, {
        organizationId: org.id,
        amount: 700, // 元 → 70000 分；候选有 60000/40000，无精确组合
      });
      if (match3b.status !== 200 || match3b.data.status !== "NO_EXACT_MATCH") {
        throw new Error("#3b failed: expected NO_EXACT_MATCH");
      }
      if (!match3b.data.nearestBelow || match3b.data.nearestBelow.sum !== 60_000) {
        throw new Error(`#3b failed: expected nearestBelow.sum=60000(分), got ${JSON.stringify(match3b.data.nearestBelow)}`);
      }

      console.log("\n#1 Degraded path (50 invoices)");
      const manyOrder = await prisma.order.create({
        data: {
          orderNo: `TEST-MANY-${Date.now()}`,
          source: "MANUAL",
          profileId: profileA.id,
          title: "测试批量订单",
          createdById: admin.id,
        },
      });
      createdOrderIds.push(manyOrder.id);

      for (let i = 0; i < 50; i++) {
        const inv = await prisma.externalOrderInvoiceRequest.create({
          data: {
            orderId: manyOrder.id,
            buyerOrganizationId: org.id,
            buyerOrganizationName: org.canonicalName,
            totalAmount: 10_000 + i * 300, // 分
            status: "ISSUED",
            actualIssuedAt: new Date(),
            createdById: admin.id,
          },
        });
        createdInvoiceIds.push(inv.id);
      }
      const start = Date.now();
      const match1 = await postJson(baseUrl, "/api/finance/payment-vouchers/match", cookie, {
        organizationId: org.id,
        amount: 500, // 元 = 50000 分；n>40 → degraded，贪心可选到发票
      });
      const elapsed = Date.now() - start;
      if (elapsed > 1000) throw new Error(`#1 failed: request took ${elapsed}ms`);
      if (!match1.data.degraded) throw new Error("#1 failed: expected degraded=true");
      if (!match1.data.heuristicReference?.sum || match1.data.heuristicReference.method !== "GREEDY_LARGEST_FIRST") {
        throw new Error(`#1 failed: expected greedy heuristicReference, got ${JSON.stringify(match1.data.heuristicReference)}`);
      }

      console.log("\n#4/#6 Receipt allocation create");
      // match 与 receipts 已统一：DB/match 响应为分，receipts 请求体为元。
      const settleInvoice = await prisma.externalOrderInvoiceRequest.create({
        data: {
          orderId: orderA.id,
          buyerOrganizationId: org.id,
          buyerOrganizationName: org.canonicalName,
          totalAmount: 100_000, // 分 = ¥1000
          status: "ISSUED",
          actualIssuedAt: new Date(),
          createdById: admin.id,
        },
      });
      createdInvoiceIds.push(settleInvoice.id);

      const receiptRes = await postJson(baseUrl, "/api/finance/receipts", cookie, {
        amount: 1000,
        source: "BANK",
        organizationId: org.id,
        allocations: [{ invoiceId: settleInvoice.id, amount: 1000 }],
      });
      if (receiptRes.status !== 201) throw new Error(`#4/#6 failed: ${JSON.stringify(receiptRes.data)}`);
      if (receiptRes.data.receipt?.id) createdReceiptIds.push(receiptRes.data.receipt.id);

      console.log("\n#4 TOCTOU: concurrent over-allocation");
      // 分口径 fixture（¥2000 = 200000 分），receipts 分摊 API 请求体仍按元传。
      const invoiceC = await prisma.externalOrderInvoiceRequest.create({
        data: {
          orderId: orderA.id,
          buyerOrganizationId: org.id,
          buyerOrganizationName: org.canonicalName,
          totalAmount: 200_000, // 分 = ¥2000
          status: "ISSUED",
          actualIssuedAt: new Date(),
          createdById: admin.id,
        },
      });
      createdInvoiceIds.push(invoiceC.id);

      const payload = {
        amount: 2000,
        source: "BANK",
        organizationId: org.id,
        allocations: [{ invoiceId: invoiceC.id, amount: 2000 }],
      };
      const [res1, res2] = await Promise.all([
        postJson(baseUrl, "/api/finance/receipts", cookie, payload),
        postJson(baseUrl, "/api/finance/receipts", cookie, payload),
      ]);
      for (const res of [res1, res2]) {
        if (res.status === 201 && res.data.receipt?.id) createdReceiptIds.push(res.data.receipt.id);
      }
      const statuses = [res1.status, res2.status].sort();
      if (statuses[0] === 201 && statuses[1] === 201) {
        throw new Error("TOCTOU 失败：两次并发核销都成功");
      }

      const invoiceCOccupied = await prisma.financeReceiptAllocation.aggregate({
        _sum: { amount: true },
        where: { invoiceId: invoiceC.id, receipt: { deleted: false } },
      });
      const invoiceCAfter = await prisma.externalOrderInvoiceRequest.findUnique({
        where: { id: invoiceC.id },
        select: { totalAmount: true },
      });
      const occupied = invoiceCOccupied._sum.amount ?? 0;
      if (occupied > (invoiceCAfter?.totalAmount ?? 0) + 0.001) {
        throw new Error(`数据一致性失败：invoiceC 被超额核销`);
      }

      console.log("\n=== All smoke tests passed ===");
    } finally {
      if (createdReceiptIds.length > 0) {
        await prisma.financeReceiptAllocation.deleteMany({ where: { receiptId: { in: createdReceiptIds } } });
        await prisma.financeReceipt.deleteMany({ where: { id: { in: createdReceiptIds } } });
      }
      if (createdInvoiceIds.length > 0) {
        await prisma.externalOrderInvoiceRequest.deleteMany({ where: { id: { in: createdInvoiceIds } } });
      }
      if (createdOrderIds.length > 0) {
        await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
      }
      if (createdProfileIds.length > 0) {
        await prisma.crmCustomerProfile.deleteMany({ where: { id: { in: createdProfileIds } } });
      }
      if (orgId) await prisma.organization.delete({ where: { id: orgId } });
      await prisma.user.deleteMany({ where: { id: admin.id } });
    }
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import PizZip from "pizzip";
import { withTempSmokeDb } from "../scripts/lib/temp-smoke-db";

/**
 * P2 route-level Web 通道 smoke：真实导入 App Router route handler（POST），
 * mock next-auth session，验证 Web HTTP 层本身的契约——状态码、错误 JSON
 * 映射、canonical service 接线——而不是只测 service 层。与
 * tests/web-agent-parity.test.ts（service 级双渠道等价）互补。
 *
 * 覆盖 7 个正式写 route：
 *  - POST /api/orders（201 / 401 / 403 / 400 旧 customerIds 键）
 *  - POST /api/projects（201 / 401 / 400 旧键）
 *  - POST /api/tickets/[id]/replies（201 / 401 / 403 非成员）
 *  - POST /api/crm/follow-ups（201 / 401 / 403；session 走 "next-auth" 而非 "/next"）
 *  - POST /api/finance/order-invoices（201 DRAFT / 401 / 403 角色门 / 400 缺 orderId）
 *  - POST /api/finance/receipts（201 核销 / 401 / 403 角色门 / 400 缺 organizationId）
 *  - POST /api/contracts/generate（200 二进制 docx / 401 / 403 销售角色 / 400 空订单）
 *
 * ⚠️ 顶层只允许 type-only import + vi.mock/vi.hoisted：任何运行时 import 传递
 * 依赖 @/lib/prisma 的模块都会把全局单例钉死到真实 dev.db。route 模块一律在
 * withTempSmokeDb 回调内动态导入。
 */

type SessionUser = { id: string; role: string; name: string; email: string; department: string };
type MockSession = { user: SessionUser };

const sessionState = vi.hoisted(() => ({ current: null as MockSession | null }));

// route 中 6 个从 "next-auth/next"、crm/follow-ups 从 "next-auth" 导入
// getServerSession；两个说明符都要 mock。importOriginal 保留其余导出，
// 避免破坏 @/lib/auth（authOptions）对 next-auth 其他导出的依赖。
vi.mock("next-auth/next", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getServerSession: async () => sessionState.current,
}));
vi.mock("next-auth", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getServerSession: async () => sessionState.current,
}));

const TEMPLATES_DIR = path.join(process.cwd(), "public", "uploads", "contract-templates", "route-test");
// 合同文件根经 env 注入为进程专属临时目录（contractsUploadRoot() 运行时读取）：
// 测试永不触碰真实 public/uploads/contracts，afterEach 整体删除只影响自己。
const TEST_CONTRACTS_DIR = path.join(os.tmpdir(), `scimanage-contracts-routes-${process.pid}`);
const CONTRACT_UPLOADS_DIR_BEFORE = process.env.SCIMANAGE_CONTRACT_UPLOADS_DIR;

function buildTestDocx(placeholders: string[]): Buffer {
  const zip = new PizZip();
  const docXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body><w:p><w:r><w:t xml:space="preserve">${placeholders.join(" ")}</w:t></w:r></w:p></w:body>
</w:document>`;
  zip.file("word/document.xml", docXml);
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
  );
  return Buffer.from(zip.generate({ type: "nodebuffer" }));
}

beforeEach(() => {
  process.env.SCIMANAGE_CONTRACT_UPLOADS_DIR = TEST_CONTRACTS_DIR;
});

afterEach(async () => {
  sessionState.current = null;
  await fs.rm(TEMPLATES_DIR, { recursive: true, force: true }).catch(() => {});
  await fs.rm(TEST_CONTRACTS_DIR, { recursive: true, force: true }).catch(() => {});
  // 恢复原值：全局 env 不能泄漏给同 worker 进程后续加载的其他测试文件
  if (CONTRACT_UPLOADS_DIR_BEFORE === undefined) {
    delete process.env.SCIMANAGE_CONTRACT_UPLOADS_DIR;
  } else {
    process.env.SCIMANAGE_CONTRACT_UPLOADS_DIR = CONTRACT_UPLOADS_DIR_BEFORE;
  }
});

describe("P2 Web route-level HTTP 映射 smoke", () => {
  it("7 个正式写 route 的状态码/错误映射/canonical 接线", async () => {
    await withTempSmokeDb(async () => {
      const { prisma } = await import("@/lib/prisma");
      const { POST: ordersPost } = await import("@/app/api/orders/route");
      const { POST: projectsPost } = await import("@/app/api/projects/route");
      const { POST: ticketReplyPost } = await import("@/app/api/tickets/[id]/replies/route");
      const { POST: followUpsPost } = await import("@/app/api/crm/follow-ups/route");
      const { POST: orderInvoicesPost } = await import("@/app/api/finance/order-invoices/route");
      const { POST: receiptsPost } = await import("@/app/api/finance/receipts/route");
      const { POST: contractsGeneratePost } = await import("@/app/api/contracts/generate/route");

      const jsonRequest = (url: string, body: unknown) =>
        new Request(url, {
          method: "POST",
          body: JSON.stringify(body),
          headers: { "Content-Type": "application/json" },
        });
      // route 签名标注 NextRequest，但 POST 实现只消费 req.json()；标准
      // Request 在运行时足够。handler 经 unknown 转接豁免 NextRequest/params
      // 精确类型；无 ctx 时不传第二参（避免单位置参数 handler 解构 undefined）。
      const call = (handler: unknown, req: Request, ctx?: unknown) =>
        ctx === undefined
          ? (handler as (r: Request) => Promise<Response>)(req)
          : (handler as (r: Request, c: unknown) => Promise<Response>)(req, ctx);

      const login = (u: { id: string; role: string; name: string; email: string; department: string }) => {
        sessionState.current = { user: { id: u.id, role: u.role, name: u.name, email: u.email, department: u.department } };
      };
      const logout = () => {
        sessionState.current = null;
      };

      // 非 ADMIN 用户必须有合法 department（FIELD_SALES）才能通过门户准入（设计 §2.4）；
      // 旧行为靠 actor 解析静默兜底 FIELD_SALES 掩盖了缺失，fail-closed 后必须显式提供。
      const admin = await prisma.user.create({ data: { email: "routes-admin@example.com", name: "Admin", password: "x", role: "ADMIN", department: "FIELD_SALES" } });
      const user = await prisma.user.create({ data: { email: "routes-user@example.com", name: "员工", password: "x", role: "USER", department: "FIELD_SALES" } });
      const rep = await prisma.user.create({ data: { email: "routes-rep@example.com", name: "Rep", password: "x", role: "REPRESENTATIVE", department: "FIELD_SALES" } });

      // ── 1. POST /api/orders：201 / 401 / 403 / 400 旧键 ────────────────────
      {
        const profile = await prisma.crmCustomerProfile.create({ data: { name: "route 订单客户", ownerUserId: admin.id } });
        // Phase 1 review #2：新业务订单必须绑定 SKU。seed Product + SKU 供行使用。
        const routeProduct = await prisma.product.create({
          data: {
            productCode: "PRD-000001", name: "测序", kind: "SERVICE", status: "ACTIVE", createdById: admin.id,
            skus: { create: [{ skuCode: "SKU-000001", name: "测序", standardUnit: "样本", sellable: true, purchasable: true, status: "ACTIVE", createdById: admin.id }] },
          },
          include: { skus: true },
        });
        const routeSkuId = routeProduct.skus[0].id;
        const body = { title: "route 订单", profileId: profile.id, lines: [{ itemName: "测序", amount: 100, productSkuId: routeSkuId }] };

        logout();
        expect((await call(ordersPost, jsonRequest("http://t/api/orders", body))).status).toBe(401);

        login(rep);
        const forbidden = await call(ordersPost, jsonRequest("http://t/api/orders", body));
        expect(forbidden.status).toBe(403);

        login(rep);
        const legacy = await call(ordersPost, jsonRequest("http://t/api/orders", { ...body, customerId: "x" }));
        expect(legacy.status).toBe(400);

        login(admin);
        const res = await call(ordersPost, jsonRequest("http://t/api/orders", body));
        expect(res.status).toBe(201);
        const created = (await res.json()) as { order: { id: string; totalAmount: number } };
        expect(created.order.id).toBeTruthy();
        const row = await prisma.order.findUniqueOrThrow({ where: { id: created.order.id } });
        expect(row.profileId).toBe(profile.id);
        expect(row.createdById).toBe(admin.id);
        logout();
      }

      // ── 2. POST /api/projects：201 / 401 / 400 旧键 ───────────────────────
      {
        const body = { name: "route 项目", budgetAmount: 10 };

        logout();
        expect((await call(projectsPost, jsonRequest("http://t/api/projects", body))).status).toBe(401);

        login(user);
        const legacy = await call(projectsPost, jsonRequest("http://t/api/projects", { ...body, customerIds: ["x"] }));
        expect(legacy.status).toBe(400);

        const res = await call(projectsPost, jsonRequest("http://t/api/projects", body));
        expect(res.status).toBe(201);
        const created = (await res.json()) as { project: { id: string } };
        const row = await prisma.project.findUniqueOrThrow({ where: { id: created.project.id } });
        expect(row.name).toBe("route 项目");
        expect(await prisma.projectMember.count({ where: { projectId: row.id, userId: user.id, role: "OWNER" } })).toBe(1);
        logout();
      }

      // ── 3. POST /api/tickets/[id]/replies：201 / 401 / 403 非成员 ─────────
      {
        const project = await prisma.project.create({ data: { name: "route 工单项目" } });
        await prisma.projectMember.create({ data: { projectId: project.id, userId: user.id, role: "MEMBER" } });
        const ticket = await prisma.ticket.create({
          data: { projectId: project.id, title: "route 工单", status: "OPEN", priority: "MEDIUM", createdBy: admin.id },
        });
        const ctx = { params: Promise.resolve({ id: ticket.id }) };
        const body = { content: "route 回复" };

        logout();
        expect((await call(ticketReplyPost, jsonRequest("http://t/api/tickets/x/replies", body), ctx)).status).toBe(401);

        // rep 不是项目成员 → canonical service Forbidden → 403
        login(rep);
        expect((await call(ticketReplyPost, jsonRequest("http://t/api/tickets/x/replies", body), ctx)).status).toBe(403);

        login(user);
        const res = await call(ticketReplyPost, jsonRequest("http://t/api/tickets/x/replies", body), ctx);
        expect(res.status).toBe(201);
        const created = (await res.json()) as { reply: { id: string; content: string } };
        expect(created.reply.content).toBe("route 回复");
        expect((await prisma.ticketReply.findUniqueOrThrow({ where: { id: created.reply.id } })).authorId).toBe(user.id);
        logout();
      }

      // ── 4. POST /api/crm/follow-ups：201 / 401 / 403（session 走 "next-auth"）─
      {
        const profile = await prisma.crmCustomerProfile.create({ data: { name: "route 跟进客户", ownerUserId: admin.id } });
        const body = { profileId: profile.id, title: "route 跟进", dueAt: new Date(Date.now() + 86_400_000).toISOString() };

        logout();
        expect((await call(followUpsPost, jsonRequest("http://t/api/crm/follow-ups", body))).status).toBe(401);

        // REP 对他人（admin）客户无 scope → 403
        login(rep);
        expect((await call(followUpsPost, jsonRequest("http://t/api/crm/follow-ups", body))).status).toBe(403);

        login(admin);
        const res = await call(followUpsPost, jsonRequest("http://t/api/crm/follow-ups", body));
        expect(res.status).toBe(201);
        const created = (await res.json()) as { task: { id: string } };
        const row = await prisma.crmFollowUpTask.findUniqueOrThrow({ where: { id: created.task.id } });
        expect(row.profileId).toBe(profile.id);
        logout();
      }

      // ── 5. POST /api/finance/order-invoices：201 DRAFT / 401 / 403 / 400 ──
      {
        const org = await prisma.organization.create({
          data: { orgCode: "ROUTES-INV-ORG", canonicalName: "route 开票单位", normalizedName: "route 开票单位", isInvoiceSubject: true },
        });
        const seller = await prisma.billingProfile.create({ data: { name: "route 销方" } });
        const order = await prisma.order.create({
          data: {
            orderNo: "ROUTES-INV-ORDER", title: "route 开票订单", status: "CONFIRMED",
            totalAmount: 100_000, buyerOrganizationId: org.id, createdById: admin.id,
          },
        });
        const body = {
          orderId: order.id,
          coverageAllocations: [{ orderId: order.id, amountCents: 50_000 }],
          items: [{ itemName: "测序服务", amount: 500 }],
          buyerOrganizationName: "route 开票单位",
          sellerProfileId: seller.id,
        };

        logout();
        expect((await call(orderInvoicesPost, jsonRequest("http://t/api/finance/order-invoices", body))).status).toBe(401);

        login(rep);
        expect((await call(orderInvoicesPost, jsonRequest("http://t/api/finance/order-invoices", body))).status).toBe(403);

        login(admin);
        expect((await call(orderInvoicesPost, jsonRequest("http://t/api/finance/order-invoices", { ...body, orderId: undefined }))).status).toBe(400);

        const res = await call(orderInvoicesPost, jsonRequest("http://t/api/finance/order-invoices", body));
        expect(res.status).toBe(201);
        const created = (await res.json()) as { invoice: { id: string; status: string; totalAmount: number } };
        expect(created.invoice.id).toBeTruthy();
        expect(created.invoice.status).toBe("DRAFT");
        expect(created.invoice.totalAmount).toBe(500); // route 输出元
        logout();
      }

      // ── 6. POST /api/finance/receipts：201 核销 / 401 / 403 / 400 ─────────
      {
        const org = await prisma.organization.create({
          data: { orgCode: "ROUTES-RCPT-ORG", canonicalName: "route 回款单位", normalizedName: "route 回款单位" },
        });
        const profile = await prisma.crmCustomerProfile.create({ data: { name: "route 回款客户", ownerUserId: admin.id } });
        const order = await prisma.order.create({
          data: {
            orderNo: "ROUTES-RCPT-ORDER", title: "route 回款订单", status: "CONFIRMED",
            totalAmount: 80_000, profileId: profile.id, buyerOrganizationId: org.id, createdById: admin.id,
          },
        });
        const invoice = await prisma.externalOrderInvoiceRequest.create({
          data: {
            orderId: order.id, status: "ISSUED", totalAmount: 80_000,
            buyerOrganizationId: org.id, buyerOrganizationName: "route 回款单位", createdById: admin.id,
          },
        });
        await prisma.orderInvoiceCoverage.create({ data: { invoiceRequestId: invoice.id, orderId: order.id, amount: 80_000 } });
        const body = {
          amount: 800,
          receivedAt: new Date().toISOString(),
          organizationId: org.id,
          allocations: [{ invoiceId: invoice.id, amount: 800 }],
        };

        logout();
        expect((await call(receiptsPost, jsonRequest("http://t/api/finance/receipts", body))).status).toBe(401);

        login(rep);
        expect((await call(receiptsPost, jsonRequest("http://t/api/finance/receipts", body))).status).toBe(403);

        login(admin);
        const noOrg = { ...body, organizationId: undefined };
        expect((await call(receiptsPost, jsonRequest("http://t/api/finance/receipts", noOrg))).status).toBe(400);

        const res = await call(receiptsPost, jsonRequest("http://t/api/finance/receipts", body));
        expect(res.status).toBe(201);
        const created = (await res.json()) as { receipt: { id: string }; allocations: unknown[] };
        expect(created.receipt.id).toBeTruthy();
        expect(created.allocations.length).toBe(1);
        const rcpt = await prisma.financeReceipt.findUniqueOrThrow({ where: { id: created.receipt.id } });
        expect(rcpt.amount).toBe(80_000); // DB 存分
        const alloc = await prisma.financeReceiptAllocation.findFirstOrThrow({ where: { receiptId: rcpt.id } });
        expect(alloc.invoiceId).toBe(invoice.id);
        expect(alloc.amount).toBe(80_000);
        logout();
      }

      // ── 7. POST /api/contracts/generate：200 二进制 / 401 / 403 / 400 ─────
      {
        const seller = await prisma.billingProfile.create({ data: { name: "route 合同销方" } });
        const profile = await prisma.crmCustomerProfile.create({ data: { name: "route 合同客户", ownerUserId: user.id } });
        const order = await prisma.order.create({
          data: {
            orderNo: "ROUTES-CT-ORDER", title: "route 合同订单", status: "CONFIRMED",
            totalAmount: 100_000, profileId: profile.id, buyerNameSnapshot: "张三", createdById: user.id,
          },
        });
        await prisma.orderLine.create({
          data: { orderId: order.id, itemName: "测序服务", quantity: 1, unitPrice: 100_000, amount: 100_000, sortOrder: 0 },
        });
        const fileUrl = "/uploads/contract-templates/route-test/template.docx";
        const template = await prisma.contractTemplate.create({
          data: { name: "route 模板", category: "SEQUENCING", fileName: "route.docx", fileUrl, createdById: user.id },
        });
        const abs = path.join(process.cwd(), "public", fileUrl);
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, buildTestDocx(["{sellerName}", "{buyerName}", "{contractNo}", "{totalAmount}"]));
        const body = { orderIds: [order.id], templateId: template.id, sellerProfileId: seller.id };

        logout();
        expect((await call(contractsGeneratePost, jsonRequest("http://t/api/contracts/generate", body))).status).toBe(401);

        login(rep);
        expect((await call(contractsGeneratePost, jsonRequest("http://t/api/contracts/generate", body))).status).toBe(403);

        login(user);
        expect((await call(contractsGeneratePost, jsonRequest("http://t/api/contracts/generate", { ...body, orderIds: [] }))).status).toBe(400);

        const res = await call(contractsGeneratePost, jsonRequest("http://t/api/contracts/generate", body));
        expect(res.status).toBe(200);
        expect(res.headers.get("Content-Type")).toContain("wordprocessingml");
        expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(0);
        // canonical 接线：正式表落了 GENERATED 合同，文件在注入的临时根
        const doc = await prisma.contractDocument.findFirstOrThrow({ where: { status: "GENERATED" } });
        await expect(fs.access(path.join(TEST_CONTRACTS_DIR, doc.id, `${doc.contractNo}.docx`))).resolves.toBeUndefined();

        // GET download：与 generate 共用注入文件根（storage helper）——
        // 修复前下载 route 固定读 public/，注入 env 后生成成功但下载 500
        const { GET: contractDownloadGet } = await import("@/app/api/contracts/[id]/download/route");
        const dlCtx = { params: Promise.resolve({ id: doc.id }) };
        const dlUrl = `http://t/api/contracts/${doc.id}/download`;
        logout();
        expect((await call(contractDownloadGet, new Request(dlUrl), dlCtx)).status).toBe(401);
        // REP 全覆盖 scope 外 → fail-closed 404（C2：不以 403 泄露存在性）
        login(rep);
        expect((await call(contractDownloadGet, new Request(dlUrl), dlCtx)).status).toBe(404);
        login(user);
        const dl = await call(contractDownloadGet, new Request(dlUrl), dlCtx);
        expect(dl.status).toBe(200);
        expect(dl.headers.get("Content-Type")).toContain("wordprocessingml");
        expect((await dl.arrayBuffer()).byteLength).toBeGreaterThan(0);
        logout();
      }
    });
  }, 300_000);
});

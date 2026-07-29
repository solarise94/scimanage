/**
 * P1 路由层部门兜底清除回归测试（二次代码审阅缺陷）。
 *
 * 验证 6 个 route handler（HTTP 层）在 actor 部门无法权威解析时 fail-closed，
 * 不再静默降级 FIELD_SALES：
 *   1. GET /api/crm/customer-applications   （读 → 空集）
 *   2. GET /api/crm/follow-ups              （读 → 空集）
 *   3. GET /api/finance/summary             （读 → 等价空集汇总）
 *   4. PATCH /api/supply/inquiries/[id]     （写 → 403）
 *   5. POST /api/supply/inquiries           （写 → 400，不落 FIELD_SALES 快照）
 *   6. POST /api/finance/payables           （写 → 400，不落 FIELD_SALES 快照）
 *
 * 回归保护：正常 FIELD_SALES / ONLINE_OPS / ADMIN 行为不回退。
 *
 * 全部在 withTempSmokeDb 临时 SQLite 中执行（参照 tests/crm-profile-routes.test.ts
 * 的 mock next-auth + 动态导入 route handler 做法），严禁触碰真实库。
 */
import { describe, expect, it, vi } from "vitest";
import { withTempSmokeDb } from "../scripts/lib/temp-smoke-db";

// ── mock next-auth（route 用 getServerSession；requirePortalSession 动态 import "next-auth"）──
type SessionUser = {
  id: string;
  role: string;
  name: string;
  email: string;
  department: string;
};
type MockSession = { user: SessionUser } | null;
const sessionState = vi.hoisted(() => ({ current: null as MockSession }));

vi.mock("next-auth", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getServerSession: async () => sessionState.current,
}));
vi.mock("next-auth/next", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getServerSession: async () => sessionState.current,
}));

function setSession(user: SessionUser | null): void {
  sessionState.current = user ? { user } : null;
}

function mkReq(
  url: string,
  init: { method?: string; body?: unknown } = {},
): import("next/server").NextRequest {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { NextRequest } = require("next/server") as typeof import("next/server");
  return new NextRequest(url, {
    method: init.method ?? "GET",
    headers: { "Content-Type": "application/json" },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
}

async function jsonBody(res: import("next/server").NextResponse): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

const sess = (u: {
  id: string;
  role: string;
  name: string | null;
  email: string;
  department: string;
}): SessionUser => ({
  id: u.id,
  role: u.role,
  name: u.name ?? "",
  email: u.email,
  department: u.department,
});

describe("P1 路由层部门兜底清除（6 route fail-closed）", () => {
  it("非法/缺失部门：读空集、写拒绝；正常部门不回退", async () => {
    await withTempSmokeDb(async () => {
      const { prisma } = await import("@/lib/prisma");

      // ── 种子用户 ──
      const mkUser = (email: string, role: string, department: string, name: string) =>
        prisma.user.create({ data: { email, name, password: "x", role, department } });
      const uFs = await mkUser("fs@t.test", "USER", "FIELD_SALES", "FS");
      const uOps = await mkUser("ops@t.test", "USER", "ONLINE_OPS", "OPS");
      const uAdmin = await mkUser("admin@t.test", "ADMIN", "FIELD_SALES", "ADM");
      // DB 中部门非法（GARBAGE）—— 模拟 auth 层把非法部门表示为空串场景的权威源
      const uBadDept = await mkUser("bad@t.test", "USER", "GARBAGE", "BAD");
      // DB 中部门为空串
      const uEmptyDept = await mkUser("empty@t.test", "USER", "", "EMPTY");

      // ── 共享供应商 ──
      const supplier = await prisma.supplier.create({
        data: { name: "S", normalizedName: "s" },
      });

      // ── CRM profile（follow-ups / customer-applications 关联用）──
      const profile = await prisma.crmCustomerProfile.create({
        data: { name: "P", assignmentStatus: "ASSIGNED", ownerUserId: uFs.id },
      });

      // ── 运营记录：FS / OPS 各一条 follow-up + customer-application ──
      await prisma.crmFollowUpTask.create({
        data: {
          profileId: profile.id,
          ownerUserId: uFs.id,
          title: "FS 任务",
          dueAt: new Date(Date.now() + 86400000),
          status: "OPEN",
          departmentSnapshot: "FIELD_SALES",
          createdByUserId: uFs.id,
        },
      });
      await prisma.crmFollowUpTask.create({
        data: {
          profileId: profile.id,
          ownerUserId: uOps.id,
          title: "OPS 任务",
          dueAt: new Date(Date.now() + 86400000),
          status: "OPEN",
          departmentSnapshot: "ONLINE_OPS",
          createdByUserId: uOps.id,
        },
      });
      await prisma.crmCustomerApplication.create({
        data: {
          name: "FS 申请",
          submittedByUserId: uFs.id,
          departmentSnapshot: "FIELD_SALES",
          status: "PENDING",
        },
      });
      await prisma.crmCustomerApplication.create({
        data: {
          name: "OPS 申请",
          submittedByUserId: uOps.id,
          departmentSnapshot: "ONLINE_OPS",
          status: "PENDING",
        },
      });

      // ── 既有 FIELD_SALES 询价（验证 bad/empty 用户不能 PATCH / 不能读取）──
      const inquiryFs = await prisma.supplierInquiry.create({
        data: {
          supplierId: supplier.id,
          orderId: null,
          departmentSnapshot: "FIELD_SALES",
          requestedItem: "FS 询价",
          status: "OPEN",
          createdById: uFs.id,
        },
      });

      // ── 预加载 route handlers（在 setSession 之前）──
      const customerAppsRoute = await import("@/app/api/crm/customer-applications/route");
      const followUpsRoute = await import("@/app/api/crm/follow-ups/route");
      const summaryRoute = await import("@/app/api/finance/summary/route");
      const inquiryDetailRoute = await import("@/app/api/supply/inquiries/[id]/route");
      const inquiriesRoute = await import("@/app/api/supply/inquiries/route");
      const payablesRoute = await import("@/app/api/finance/payables/route");

      // ═══════════════════════════════════════════════════════════════
      // #1 GET /api/crm/customer-applications
      // ═══════════════════════════════════════════════════════════════

      // bad 部门 → 空集（不降级 FIELD_SALES 看到 FS 申请）
      setSession(sess({ ...uBadDept, name: uBadDept.name, email: uBadDept.email, department: "" }));
      const resBadApps = await customerAppsRoute.GET(mkReq("http://localhost/api/crm/customer-applications"));
      expect(resBadApps.status).toBe(200);
      const badAppsBody = await jsonBody(resBadApps);
      expect((badAppsBody.applications as unknown[]).length).toBe(0);

      // empty 部门 → 空集
      setSession(sess({ ...uEmptyDept, name: uEmptyDept.name, email: uEmptyDept.email, department: "" }));
      const resEmptyApps = await customerAppsRoute.GET(mkReq("http://localhost/api/crm/customer-applications"));
      expect(((await jsonBody(resEmptyApps)).applications as unknown[]).length).toBe(0);

      // FS USER → 只见 FS 申请（不回退）
      setSession(sess({ ...uFs, name: uFs.name, email: uFs.email, department: "FIELD_SALES" }));
      const resFsApps = await customerAppsRoute.GET(mkReq("http://localhost/api/crm/customer-applications"));
      const fsApps = (await jsonBody(resFsApps)).applications as Array<{ departmentSnapshot: string }>;
      expect(fsApps.length).toBe(1);
      expect(fsApps[0]!.departmentSnapshot).toBe("FIELD_SALES");

      // ADMIN → 全量（2 条，跨部门）
      setSession(sess({ ...uAdmin, name: uAdmin.name, email: uAdmin.email, department: "FIELD_SALES" }));
      const resAdminApps = await customerAppsRoute.GET(mkReq("http://localhost/api/crm/customer-applications"));
      const adminApps = (await jsonBody(resAdminApps)).applications as unknown[];
      expect(adminApps.length).toBe(2);

      // ═══════════════════════════════════════════════════════════════
      // #2 GET /api/crm/follow-ups
      // ═══════════════════════════════════════════════════════════════

      // bad 部门 → 空集
      setSession(sess({ ...uBadDept, name: uBadDept.name, email: uBadDept.email, department: "" }));
      const resBadFu = await followUpsRoute.GET(mkReq("http://localhost/api/crm/follow-ups?status=OPEN"));
      expect(resBadFu.status).toBe(200);
      expect(((await jsonBody(resBadFu)).tasks as unknown[]).length).toBe(0);

      // FS USER → 只见 FS 任务（不回退）
      setSession(sess({ ...uFs, name: uFs.name, email: uFs.email, department: "FIELD_SALES" }));
      const resFsFu = await followUpsRoute.GET(mkReq("http://localhost/api/crm/follow-ups?status=OPEN"));
      const fsTasks = (await jsonBody(resFsFu)).tasks as Array<{ departmentSnapshot: string }>;
      expect(fsTasks.length).toBe(1);
      expect(fsTasks[0]!.departmentSnapshot).toBe("FIELD_SALES");

      // OPS USER → 只见 OPS 任务（不回退）
      setSession(sess({ ...uOps, name: uOps.name, email: uOps.email, department: "ONLINE_OPS" }));
      const resOpsFu = await followUpsRoute.GET(mkReq("http://localhost/api/crm/follow-ups?status=OPEN"));
      const opsTasks = (await jsonBody(resOpsFu)).tasks as Array<{ departmentSnapshot: string }>;
      expect(opsTasks.length).toBe(1);
      expect(opsTasks[0]!.departmentSnapshot).toBe("ONLINE_OPS");

      // ADMIN → 全量
      setSession(sess({ ...uAdmin, name: uAdmin.name, email: uAdmin.email, department: "FIELD_SALES" }));
      const resAdminFu = await followUpsRoute.GET(mkReq("http://localhost/api/crm/follow-ups?status=OPEN"));
      expect(((await jsonBody(resAdminFu)).tasks as unknown[]).length).toBe(2);

      // ═══════════════════════════════════════════════════════════════
      // #3 GET /api/finance/summary
      // ═══════════════════════════════════════════════════════════════
      // 本路由经 requirePortalSession → assertPortalAccess（仅校验 session 部门 = 门户 code）。
      // fail-closed 关键场景：session 部门合法（通过门户门闩），但 DB 部门非法/为空。
      // 模拟 JWT 缓存与 DB 不一致：把 bad 用户的 session.department 设为 FIELD_SALES（通过门闩），
      // 但 DB 中 department=GARBAGE（resolveActorDepartmentOrNull 返回 null）。

      // bad 部门（session=FIELD_SALES 通过门闩，DB=GARBAGE）→ 等价空集汇总（关键 KPI 为 0，不抛错）
      setSession(sess({ ...uBadDept, name: uBadDept.name, email: uBadDept.email, department: "FIELD_SALES" }));
      const resBadSum = await summaryRoute.GET(mkReq("http://localhost/api/finance/summary"));
      expect(resBadSum.status).toBe(200);
      const badSumBody = await jsonBody(resBadSum);
      expect(badSumBody.customerCount).toBe(0);
      expect(badSumBody.projectCount).toBe(0);
      expect(badSumBody.orderCount ?? 0).toBe(0);

      // FS USER → 汇总正常返回（不回退、不抛错）
      setSession(sess({ ...uFs, name: uFs.name, email: uFs.email, department: "FIELD_SALES" }));
      const resFsSum = await summaryRoute.GET(mkReq("http://localhost/api/finance/summary"));
      expect(resFsSum.status).toBe(200);

      // ADMIN → 全量汇总正常
      setSession(sess({ ...uAdmin, name: uAdmin.name, email: uAdmin.email, department: "FIELD_SALES" }));
      const resAdminSum = await summaryRoute.GET(mkReq("http://localhost/api/finance/summary"));
      expect(resAdminSum.status).toBe(200);

      // ═══════════════════════════════════════════════════════════════
      // #4 PATCH /api/supply/inquiries/[id]  （写路径）
      // ═══════════════════════════════════════════════════════════════

      // bad 部门 USER 试图 PATCH FS 询价 → 403（不因降级 FIELD_SALES 而命中 FS 询价）
      setSession(sess({ ...uBadDept, name: uBadDept.name, email: uBadDept.email, department: "" }));
      const resBadPatch = await inquiryDetailRoute.PATCH(
        mkReq(`http://localhost/api/supply/inquiries/${inquiryFs.id}`, {
          method: "PATCH",
          body: { status: "CLOSED" },
        }),
        { params: Promise.resolve({ id: inquiryFs.id }) },
      );
      expect(resBadPatch.status).toBe(403);
      // 确认未被修改
      const inquiryAfterBadPatch = await prisma.supplierInquiry.findUniqueOrThrow({ where: { id: inquiryFs.id } });
      expect(inquiryAfterBadPatch.status).toBe("OPEN");

      // FS USER PATCH FS 询价 → 200（不回退）
      setSession(sess({ ...uFs, name: uFs.name, email: uFs.email, department: "FIELD_SALES" }));
      const resFsPatch = await inquiryDetailRoute.PATCH(
        mkReq(`http://localhost/api/supply/inquiries/${inquiryFs.id}`, {
          method: "PATCH",
          body: { status: "CLOSED" },
        }),
        { params: Promise.resolve({ id: inquiryFs.id }) },
      );
      expect(resFsPatch.status).toBe(200);

      // ADMIN PATCH 任意 → 200
      setSession(sess({ ...uAdmin, name: uAdmin.name, email: uAdmin.email, department: "FIELD_SALES" }));
      const resAdminPatch = await inquiryDetailRoute.PATCH(
        mkReq(`http://localhost/api/supply/inquiries/${inquiryFs.id}`, {
          method: "PATCH",
          body: { note: "admin note" },
        }),
        { params: Promise.resolve({ id: inquiryFs.id }) },
      );
      expect(resAdminPatch.status).toBe(200);

      // ═══════════════════════════════════════════════════════════════
      // #5 POST /api/supply/inquiries  （写路径，无关联订单 → 取 actor 部门）
      // ═══════════════════════════════════════════════════════════════

      const inquiryPostBody = {
        supplierId: supplier.id,
        requestedItem: "新询价",
      };

      // bad 部门 USER → 400，不落 FIELD_SALES 快照
      setSession(sess({ ...uBadDept, name: uBadDept.name, email: uBadDept.email, department: "" }));
      const resBadPost = await inquiriesRoute.POST(
        mkReq("http://localhost/api/supply/inquiries", { method: "POST", body: inquiryPostBody }),
      );
      expect(resBadPost.status).toBe(400);
      // 验证未创建任何 FIELD_SALES 部门的孤儿询价
      const fsInquiriesAfterBad = await prisma.supplierInquiry.findMany({
        where: { departmentSnapshot: "FIELD_SALES", requestedItem: "新询价" },
      });
      expect(fsInquiriesAfterBad.length).toBe(0);

      // bad 部门 ADMIN → 400（ADMIN 也需自身部门可解析）
      setSession(sess({ ...uBadDept, name: uBadDept.name, email: uBadDept.email, department: "" }));
      // 把 bad 用户临时升为 ADMIN 仍应 fail-closed（DB 中 department=GARBAGE）
      await prisma.user.update({ where: { id: uBadDept.id }, data: { role: "ADMIN" } });
      const resBadAdminPost = await inquiriesRoute.POST(
        mkReq("http://localhost/api/supply/inquiries", { method: "POST", body: inquiryPostBody }),
      );
      expect(resBadAdminPost.status).toBe(400);
      await prisma.user.update({ where: { id: uBadDept.id }, data: { role: "USER" } });

      // FS USER → 201，落 FIELD_SALES 快照（不回退）
      setSession(sess({ ...uFs, name: uFs.name, email: uFs.email, department: "FIELD_SALES" }));
      const resFsPost = await inquiriesRoute.POST(
        mkReq("http://localhost/api/supply/inquiries", { method: "POST", body: inquiryPostBody }),
      );
      expect(resFsPost.status).toBe(201);
      const fsPostBody = await jsonBody(resFsPost);
      const fsCreatedInquiry = fsPostBody.inquiry as { departmentSnapshot: string };
      expect(fsCreatedInquiry.departmentSnapshot).toBe("FIELD_SALES");

      // OPS USER → 201，落 ONLINE_OPS 快照（不回退到 FS）
      setSession(sess({ ...uOps, name: uOps.name, email: uOps.email, department: "ONLINE_OPS" }));
      const resOpsPost = await inquiriesRoute.POST(
        mkReq("http://localhost/api/supply/inquiries", { method: "POST", body: inquiryPostBody }),
      );
      expect(resOpsPost.status).toBe(201);
      const opsCreatedInquiry = (await jsonBody(resOpsPost)).inquiry as { departmentSnapshot: string };
      expect(opsCreatedInquiry.departmentSnapshot).toBe("ONLINE_OPS");

      // ═══════════════════════════════════════════════════════════════
      // #6 POST /api/finance/payables  （写路径，ADMIN-only，无关联订单 → 取 actor 部门）
      // ═══════════════════════════════════════════════════════════════

      const payablePostBody = {
        supplierId: supplier.id,
        amount: 100,
      };

      // bad 部门 ADMIN → 400（POST 限 ADMIN，但 actor 部门不可解析时 fail-closed）
      await prisma.user.update({ where: { id: uBadDept.id }, data: { role: "ADMIN" } });
      setSession({
        id: uBadDept.id,
        role: "ADMIN",
        name: uBadDept.name ?? "",
        email: uBadDept.email,
        department: "FIELD_SALES", // session 仅作 UI/门闩上下文；权威部门从 DB 解析
      });
      const resBadPayable = await payablesRoute.POST(
        mkReq("http://localhost/api/finance/payables", { method: "POST", body: payablePostBody }),
      );
      expect(resBadPayable.status).toBe(400);
      // 验证未创建 FIELD_SALES 部门的孤儿应付
      const fsPayablesAfterBad = await prisma.financePayable.findMany({
        where: { departmentSnapshot: "FIELD_SALES" },
      });
      expect(fsPayablesAfterBad.length).toBe(0);

      // 正常 ADMIN（FIELD_SALES） → 201，落 FIELD_SALES 快照（不回退）
      setSession(sess({ ...uAdmin, name: uAdmin.name, email: uAdmin.email, department: "FIELD_SALES" }));
      const resAdminPayable = await payablesRoute.POST(
        mkReq("http://localhost/api/finance/payables", { method: "POST", body: payablePostBody }),
      );
      expect(resAdminPayable.status).toBe(201);
      const adminPayable = (await jsonBody(resAdminPayable)).payable as { departmentSnapshot: string };
      expect(adminPayable.departmentSnapshot).toBe("FIELD_SALES");

      // 正常 ADMIN（ONLINE_OPS） → 201，落 ONLINE_OPS 快照（不回退到 FS）
      const uOpsAdmin = await mkUser("ops-admin@t.test", "ADMIN", "ONLINE_OPS", "OPSADM");
      setSession(sess({ ...uOpsAdmin, name: uOpsAdmin.name, email: uOpsAdmin.email, department: "ONLINE_OPS" }));
      const resOpsAdminPayable = await payablesRoute.POST(
        mkReq("http://localhost/api/finance/payables", { method: "POST", body: payablePostBody }),
      );
      expect(resOpsAdminPayable.status).toBe(201);
      const opsAdminPayable = (await jsonBody(resOpsAdminPayable)).payable as { departmentSnapshot: string };
      expect(opsAdminPayable.departmentSnapshot).toBe("ONLINE_OPS");
    });
  });
});

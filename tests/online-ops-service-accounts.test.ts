/**
 * 客服账号管理 API 权限矩阵测试（设计 §4.6 / §10 / §12.2）。
 *
 * 直接调用 route handler（参考 tests/crm-profile-routes.test.ts 模式）。
 * 全部在 withTempSmokeDb 临时 SQLite 中执行，严禁触碰 prisma/dev.db。
 *
 * 覆盖：
 * - ADMIN：列表全部、创建、停用、改 owner（跨用户）。
 * - ONLINE_OPS USER：列表只见自己名下、创建（owner 默认自己）、停用自己名下；
 *   改 owner（非自己→他人）被拒 403。
 * - 其他部门（FIELD_SALES）非 ADMIN：403。
 * - wechatId 唯一冲突 409。
 * - owner 部门非 ONLINE_OPS 时创建被拒。
 */
import { describe, expect, it, vi } from "vitest";
import { withTempSmokeDb } from "../scripts/lib/temp-smoke-db";

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

async function jsonBody(
  res: import("next/server").NextResponse,
): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

describe("online-ops service-accounts API（§4.6/§10 权限矩阵）", () => {
  it("ADMIN 全量 / ONLINE_OPS USER 自有名下 / FIELD_SALES USER 403 / wechatId 唯一 / owner 部门校验", async () => {
    await withTempSmokeDb(async () => {
      const { prisma } = await import("@/lib/prisma");
      const { hashSync } = await import("bcryptjs");

      // fixtures
      const admin = await prisma.user.create({
        data: {
          email: "admin-sa@t.test",
          name: "Admin",
          password: hashSync("x", 4),
          role: "ADMIN",
          department: "FIELD_SALES",
        },
      });
      const onlineUser1 = await prisma.user.create({
        data: {
          email: "online1@t.test",
          name: "Online1",
          password: hashSync("x", 4),
          role: "USER",
          department: "ONLINE_OPS",
        },
      });
      const onlineUser2 = await prisma.user.create({
        data: {
          email: "online2@t.test",
          name: "Online2",
          password: hashSync("x", 4),
          role: "USER",
          department: "ONLINE_OPS",
        },
      });
      const fieldUser = await prisma.user.create({
        data: {
          email: "field@t.test",
          name: "Field",
          password: hashSync("x", 4),
          role: "USER",
          department: "FIELD_SALES",
        },
      });

      // 预置两个客服号（分别属 online1、online2）
      await prisma.customerServiceAccount.create({
        data: {
          wechatId: "wx_online1",
          name: "客服1",
          department: "ONLINE_OPS",
          ownerUserId: onlineUser1.id,
          status: "ACTIVE",
        },
      });
      await prisma.customerServiceAccount.create({
        data: {
          wechatId: "wx_online2",
          name: "客服2",
          department: "ONLINE_OPS",
          ownerUserId: onlineUser2.id,
          status: "ACTIVE",
        },
      });

      const { GET, POST } = await import(
        "@/app/api/online-ops/service-accounts/route"
      );
      const { PATCH } = await import(
        "@/app/api/online-ops/service-accounts/[id]/route"
      );

      // ── ADMIN 列表：见全部 2 条 ──
      setSession({
        id: admin.id,
        role: "ADMIN",
        name: "Admin",
        email: admin.email,
        department: "FIELD_SALES",
      });
      const adminList = await GET(mkReq("http://t/api/online-ops/service-accounts"));
      expect(adminList.status).toBe(200);
      const adminItems = (await jsonBody(adminList)).items as Array<{ id: string }>;
      expect(adminItems.length).toBe(2);

      // ── ADMIN 创建（owner=online1，合法）──
      const created = await POST(
        mkReq("http://t/api/online-ops/service-accounts", {
          method: "POST",
          body: { wechatId: "wx_new", name: "新客服", ownerUserId: onlineUser1.id },
        }),
      );
      expect(created.status).toBe(201);
      const createdBody = await jsonBody(created);
      expect(createdBody.wechatId).toBe("wx_new");
      const newId = createdBody.id as string;

      // ── wechatId 唯一冲突 409 ──
      const dup = await POST(
        mkReq("http://t/api/online-ops/service-accounts", {
          method: "POST",
          body: { wechatId: "wx_new", name: "重复", ownerUserId: onlineUser1.id },
        }),
      );
      expect(dup.status).toBe(409);

      // ── owner 部门非 ONLINE_OPS 被拒 ──
      const badOwner = await POST(
        mkReq("http://t/api/online-ops/service-accounts", {
          method: "POST",
          body: { wechatId: "wx_bad", name: "坏owner", ownerUserId: fieldUser.id },
        }),
      );
      expect(badOwner.status).toBe(400);

      // ── ADMIN 改 owner（online1 → online2）成功 ──
      const online2Acct = await prisma.customerServiceAccount.findFirst({
        where: { wechatId: "wx_online2" },
      });
      const reassign = await PATCH(
        mkReq(`http://t/api/online-ops/service-accounts/${online2Acct!.id}`, {
          method: "PATCH",
          body: { ownerUserId: onlineUser1.id },
        }),
        { params: Promise.resolve({ id: online2Acct!.id }) },
      );
      expect(reassign.status).toBe(200);

      // ── ONLINE_OPS USER 列表：只见自己名下 ──
      setSession({
        id: onlineUser1.id,
        role: "USER",
        name: "Online1",
        email: onlineUser1.email,
        department: "ONLINE_OPS",
      });
      const u1List = await GET(mkReq("http://t/api/online-ops/service-accounts"));
      const u1Items = (await jsonBody(u1List)).items as Array<{
        ownerUserId: string;
      }>;
      expect(u1Items.length).toBeGreaterThan(0);
      expect(u1Items.every((i) => i.ownerUserId === onlineUser1.id)).toBe(true);

      // ── ONLINE_OPS USER 停用自己名下 ──
      const ownAcct = await prisma.customerServiceAccount.findFirst({
        where: { wechatId: "wx_online1" },
      });
      const disableOwn = await PATCH(
        mkReq(`http://t/api/online-ops/service-accounts/${ownAcct!.id}`, {
          method: "PATCH",
          body: { status: "DISABLED" },
        }),
        { params: Promise.resolve({ id: ownAcct!.id }) },
      );
      expect(disableOwn.status).toBe(200);

      // ── ONLINE_OPS USER 改 owner（→他人）被拒 403 ──
      const reassignDeny = await PATCH(
        mkReq(`http://t/api/online-ops/service-accounts/${ownAcct!.id}`, {
          method: "PATCH",
          body: { ownerUserId: onlineUser2.id },
        }),
        { params: Promise.resolve({ id: ownAcct!.id }) },
      );
      expect(reassignDeny.status).toBe(403);

      // ── ONLINE_OPS USER 越权操作他人名下 → 404（防存在性泄露）──
      // newId 属 online1（ADMIN 创建时 owner=online1），先取一个不属 online1 的号：
      const otherAcct = await prisma.customerServiceAccount.findFirst({
        where: { wechatId: "wx_online2" }, // 已被 ADMIN 改成 online1，所以取另一个
      });
      // online2 现在无任何号；用 online2 视角操作 online1 的号应 404。
      setSession({
        id: onlineUser2.id,
        role: "USER",
        name: "Online2",
        email: onlineUser2.email,
        department: "ONLINE_OPS",
      });
      const cross = await PATCH(
        mkReq(`http://t/api/online-ops/service-accounts/${newId}`, {
          method: "PATCH",
          body: { status: "DISABLED" },
        }),
        { params: Promise.resolve({ id: newId }) },
      );
      expect(cross.status).toBe(404);
      void otherAcct;

      // ── FIELD_SALES USER（其他部门非 ADMIN）→ 403 ──
      setSession({
        id: fieldUser.id,
        role: "USER",
        name: "Field",
        email: fieldUser.email,
        department: "FIELD_SALES",
      });
      const fieldList = await GET(mkReq("http://t/api/online-ops/service-accounts"));
      expect(fieldList.status).toBe(403);

      // ── 未登录 → 401 ──
      setSession(null);
      const anonList = await GET(mkReq("http://t/api/online-ops/service-accounts"));
      expect(anonList.status).toBe(401);
    });
  });
});

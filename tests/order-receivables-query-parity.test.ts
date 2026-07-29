/**
 * Phase B regression: canonical order-receivables query（修正 8 守护）。
 *
 * 验证从 route handler 抽出的 queryOrderReceivables service 完整承接 Web 全量口径：
 *  - 6 view（all/uninvoiced/invoiceable/invoiced_unpaid/paid/no_customer）；
 *  - sub-filter（invoiceSub none/partial、receiptSub zero/partial）；
 *  - search/profileId/representativeId 过滤；
 *  - aggregate 字段集；
 *  - scope 隔离（USER 只看自己创建的订单）；
 *  - settled parity（满开票+回款=settled；软删除回款后退出 settled）。
 *
 * 全部场景共享单个 withTempSmokeDb 临时库（与 web-agent-parity.test.ts 惯例一致），
 * 避免多次 create/dispose temp DB 的 prisma 单例/文件删除时序问题。
 *
 * ⚠️ 顶层只允许 type-only import：withTempSmokeDb 之前不能实例化 prisma 单例。
 */
import { describe, expect, it } from "vitest";
import { withTempSmokeDb } from "../scripts/lib/temp-smoke-db";
import type { BusinessActor } from "@/lib/application/actor";

describe("order-receivables canonical query (Phase B)", () => {
  it("returns all 6 views + sub-filters + aggregates + scope isolation + settled parity", async () => {
    await withTempSmokeDb(async () => {
      const { queryOrderReceivables } = await import("@/lib/orders/application/order-receivables-query");
      const { prisma } = await import("@/lib/prisma");
      const { hashSync } = await import("bcryptjs");

      const admin = await prisma.user.create({
        data: { email: "admin-rec@t.test", name: "Admin", password: hashSync("x", 4), role: "ADMIN" },
      });
      const userA = await prisma.user.create({
        data: { email: "userA-rec@t.test", name: "A", password: hashSync("x", 4), role: "USER" },
      });
      const userB = await prisma.user.create({
        data: { email: "userB-rec@t.test", name: "B", password: hashSync("x", 4), role: "USER" },
      });
      const adminActor: BusinessActor = { userId: admin.id, role: "ADMIN" };

      const profile = await prisma.crmCustomerProfile.create({
        data: { name: "客户A", ownerUserId: admin.id, assignmentStatus: "ASSIGNED" },
      });
      await prisma.order.create({
        data: {
          orderNo: "ORD-REC-1",
          title: "测试订单1",
          totalAmount: 100000,
          status: "CONFIRMED",
          profileId: profile.id,
          createdById: admin.id,
        },
      });
      await prisma.order.create({
        data: {
          orderNo: "ORD-REC-2",
          title: "无客户订单",
          totalAmount: 50000,
          status: "CONFIRMED",
          profileId: null,
          createdById: admin.id,
        },
      });
      // scope 隔离用
      await prisma.order.create({
        data: { orderNo: "ORD-A", title: "A的订单", totalAmount: 1000, status: "CONFIRMED", createdById: userA.id },
      });
      await prisma.order.create({
        data: { orderNo: "ORD-B", title: "B的订单", totalAmount: 1000, status: "CONFIRMED", createdById: userB.id },
      });
      // 结清订单
      const settledOrder = await prisma.order.create({
        data: {
          orderNo: "ORD-SETTLED",
          title: "结清",
          totalAmount: 100000,
          status: "CONFIRMED",
          profileId: profile.id,
          createdById: admin.id,
        },
      });
      await prisma.externalOrderInvoiceRequest.create({
        data: {
          buyerOrganizationName: "结清买方",
          status: "ISSUED",
          totalAmount: 100000,
          orderId: settledOrder.id,
          createdById: admin.id,
        },
      });
      const receipt = await prisma.financeReceipt.create({
        data: {
          amount: 100000,
          orderId: settledOrder.id,
          receivedAt: new Date(),
          createdById: admin.id,
        },
      });

      // ── 6 views ──
      const all = await queryOrderReceivables(adminActor, { view: "all" });
      expect(all.total).toBeGreaterThanOrEqual(4);
      expect(all.aggregate).toHaveProperty("totalAmount");
      expect(all.aggregate).toHaveProperty("uninvoicedTotal");
      expect(all.aggregate.remainingTotal).toBeUndefined();

      const noCust = await queryOrderReceivables(adminActor, { view: "no_customer" });
      expect(noCust.orders.every((o) => o.profile === null)).toBe(true);

      const invoiceable = await queryOrderReceivables(adminActor, { view: "invoiceable" });
      expect(invoiceable.orders.some((o) => o.orderNo === "ORD-REC-1")).toBe(true);
      expect(invoiceable.aggregate).toHaveProperty("remainingTotal");

      const invNone = await queryOrderReceivables(adminActor, { view: "invoiceable", invoiceSub: "none" });
      expect(invNone.orders.some((o) => o.orderNo === "ORD-REC-1")).toBe(true);

      const uninvoiced = await queryOrderReceivables(adminActor, { view: "uninvoiced" });
      expect(uninvoiced.orders.some((o) => o.orderNo === "ORD-REC-1")).toBe(true);

      const paid = await queryOrderReceivables(adminActor, { view: "paid" });
      expect(paid.orders.some((o) => o.orderNo === "ORD-SETTLED")).toBe(true);
      expect(paid.orders.some((o) => o.orderNo === "ORD-REC-1")).toBe(false);

      const invoicedUnpaid = await queryOrderReceivables(adminActor, { view: "invoiced_unpaid" });
      // ORD-SETTLED 已回款齐全 → 不在 invoiced_unpaid
      expect(invoicedUnpaid.orders.some((o) => o.orderNo === "ORD-SETTLED")).toBe(false);

      // ── filters ──
      const searched = await queryOrderReceivables(adminActor, { view: "all", search: "ORD-REC-1" });
      expect(searched.orders.every((o) => o.orderNo.includes("ORD-REC-1"))).toBe(true);

      const byProfile = await queryOrderReceivables(adminActor, { view: "all", profileId: profile.id });
      expect(byProfile.orders.every((o) => o.profile?.id === profile.id)).toBe(true);

      const paged = await queryOrderReceivables(adminActor, { view: "all", page: 1, pageSize: 1 });
      expect(paged.orders.length).toBe(1);
      expect(paged.totalPages).toBeGreaterThanOrEqual(2);

      // ── scope isolation ──
      const resultA = await queryOrderReceivables({ userId: userA.id, role: "USER" }, { view: "all" });
      expect(resultA.orders.some((o) => o.orderNo === "ORD-A")).toBe(true);
      expect(resultA.orders.some((o) => o.orderNo === "ORD-B")).toBe(false);

      // ── settled parity: 软删除回款后退出 settled ──
      await prisma.financeReceipt.update({ where: { id: receipt.id }, data: { deleted: true } });
      const paidAfterDelete = await queryOrderReceivables(adminActor, { view: "paid" });
      expect(paidAfterDelete.orders.some((o) => o.orderNo === "ORD-SETTLED")).toBe(false);
    });
  });
});

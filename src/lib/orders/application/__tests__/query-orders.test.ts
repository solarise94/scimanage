import { describe, expect, it } from "vitest";
import { withTempSmokeDb } from "../../../../../scripts/lib/temp-smoke-db";

import type { AgentExecutionContext, BusinessActor } from "@/lib/application/actor";

const agentExecCtx = (actor: BusinessActor): AgentExecutionContext => ({
  actor,
  invocation: { channel: "agent" },
});

/**
 * T2.1: actor-aware order query services shared by the page routes
 * (GET /api/orders, /api/orders/[id], /api/orders/[id]/summary) and the Agent
 * actions (orders.search / list_pending_receipts / get_finance_snapshot /
 * get_detail).
 *
 * All scenarios run against one temporary SQLite DB (never dev/demo/prod).
 * Covers: capability gate, ADMIN/USER/REPRESENTATIVE scope (in/out/mixed),
 * deleted/accrual口径, pagination boundaries, ref resolution, disclosure
 * (out-of-scope → 404, not leaked), and Web/Agent/direct-service parity.
 */
describe("T2.1 order query services", () => {
  it("enforces capability, scope, deleted/accrual, pagination, detail disclosure and parity", async () => {
    await withTempSmokeDb(async () => {
      const { prisma } = await import("@/lib/prisma");
      const {
        queryOrders,
        listPendingReceiptOrders,
        assertOrderReadAccess,
      } = await import("@/lib/orders/application/query-orders");
      const {
        getOrderDetail,
        getOrderFinanceSnapshot,
        getOrderSummary,
        resolveOrderRefForActor,
      } = await import("@/lib/orders/application/get-order-detail");
      const { ForbiddenError, NotFoundError } = await import("@/lib/application/errors");
      const { executeAgentAction } = await import("@/lib/agent-actions/registry");

      // ── users ──────────────────────────────────────────────────────────
      const admin = await prisma.user.create({
        data: { email: "t21-admin@example.com", name: "Admin", password: "h", role: "ADMIN" },
      });
      const userA = await prisma.user.create({
        data: { email: "t21-usera@example.com", name: "UserA", password: "h", role: "USER" },
      });
      const userB = await prisma.user.create({
        data: { email: "t21-userb@example.com", name: "UserB", password: "h", role: "USER" },
      });
      const repUser = await prisma.user.create({
        data: { email: "t21-rep@example.com", name: "RepUser", password: "h", role: "REPRESENTATIVE" },
      });

      const adminActor = { userId: admin.id, role: "ADMIN" };
      const userAActor = { userId: userA.id, role: "USER" };
      const userBActor = { userId: userB.id, role: "USER" };
      const repActor = { userId: repUser.id, role: "REPRESENTATIVE" };

      // ── CRM profiles (owned by A / B) ───────────────────────────────────
      const profileA = await prisma.crmCustomerProfile.create({
        data: { ownerUserId: userA.id, name: "Customer A" },
      });
      const profileB = await prisma.crmCustomerProfile.create({
        data: { ownerUserId: userB.id, name: "Customer B" },
      });

      // ── representative + project link scope for repUser ─────────────────
      const rep = await prisma.representative.create({
        data: { name: "Rep One", email: repUser.email },
      });
      const repProject = await prisma.project.create({
        data: { name: "Rep Project", representativeId: rep.id },
      });

      const day = (n: number) => new Date(Date.now() - n * 86_400_000);

      const o1 = await prisma.order.create({
        data: {
          orderNo: "CO-1", externalOrderNo: "EXT-1", title: "Alpha order",
          createdById: admin.id, profileId: profileA.id, status: "CONFIRMED",
          source: "MANUAL", totalAmount: 10000, orderedAt: day(1),
        },
      });
      const o2 = await prisma.order.create({
        data: {
          orderNo: "CO-2", title: "Beta order", createdById: admin.id,
          profileId: profileB.id, status: "DRAFT", source: "MANUAL",
          totalAmount: 2000, orderedAt: day(2),
        },
      });
      const o3 = await prisma.order.create({
        data: {
          orderNo: "CO-3", title: "Gamma order", createdById: userA.id,
          status: "CONFIRMED", source: "MANUAL", totalAmount: 5000, orderedAt: day(3),
        },
      });
      const oDel = await prisma.order.create({
        data: {
          orderNo: "CO-DEL", title: "Deleted order", createdById: admin.id,
          profileId: profileA.id, status: "CONFIRMED", source: "MANUAL",
          totalAmount: 4000, deleted: true, orderedAt: day(4),
        },
      });
      await prisma.order.create({
        data: {
          orderNo: "CO-ACCR", title: "Accrual shadow", createdById: admin.id,
          profileId: profileA.id, status: "CLOSED", source: "ACCRUAL_REVERSAL",
          totalAmount: -10000, orderedAt: day(5),
        },
      });
      const oRep = await prisma.order.create({
        data: {
          orderNo: "CO-REP", title: "Rep order", createdById: admin.id,
          status: "CONFIRMED", source: "MANUAL", totalAmount: 3000, orderedAt: day(6),
        },
      });
      await prisma.orderProjectLink.create({
        data: { orderId: oRep.id, projectId: repProject.id },
      });

      const ids = (r: { orders: Array<{ id: string }> }) => r.orders.map((o) => o.id).sort();

      // ── capability gate ─────────────────────────────────────────────────
      expect(() => assertOrderReadAccess({ userId: admin.id, role: "GUEST" })).toThrow(ForbiddenError);
      await expect(queryOrders({ userId: admin.id, role: "GUEST" })).rejects.toBeInstanceOf(ForbiddenError);

      // ── ADMIN default: all non-deleted non-accrual ──────────────────────
      const adminAll = await queryOrders(adminActor);
      expect(ids(adminAll)).toEqual([o1.id, o2.id, o3.id, oRep.id].sort());
      expect(adminAll.total).toBe(4);

      // includeAccrual + includeDeleted (ADMIN only)
      const adminWithAll = await queryOrders(adminActor, {
        filters: { includeAccrual: true, includeDeleted: true },
      });
      expect(adminWithAll.total).toBe(6);

      // ── USER scope: A sees own-created + owned-profile orders ────────────
      const aScope = await queryOrders(userAActor);
      expect(ids(aScope)).toEqual([o1.id, o3.id].sort());
      // includeDeleted is ignored for non-ADMIN
      const aScopeDel = await queryOrders(userAActor, { filters: { includeDeleted: true } });
      expect(ids(aScopeDel)).toEqual([o1.id, o3.id].sort());

      const bScope = await queryOrders(userBActor);
      expect(ids(bScope)).toEqual([o2.id]);

      // ── REPRESENTATIVE scope: project-linked order only ─────────────────
      const repScope = await queryOrders(repActor);
      expect(ids(repScope)).toEqual([oRep.id]);

      // ── search filter (AND-composed with scope) ─────────────────────────
      const adminSearch = await queryOrders(adminActor, { filters: { search: "Alpha" } });
      expect(ids(adminSearch)).toEqual([o1.id]);
      // search out of scope for userB → empty
      const bSearch = await queryOrders(userBActor, { filters: { search: "Alpha" } });
      expect(bSearch.total).toBe(0);

      // status filter
      const confirmed = await queryOrders(adminActor, { filters: { status: "CONFIRMED" } });
      expect(ids(confirmed)).toEqual([o1.id, o3.id, oRep.id].sort());

      // ── pagination boundaries ───────────────────────────────────────────
      const p1 = await queryOrders(adminActor, { pageSize: 2, page: 1 });
      const p2 = await queryOrders(adminActor, { pageSize: 2, page: 2 });
      expect(p1.orders).toHaveLength(2);
      expect(p2.orders).toHaveLength(2);
      expect(p1.total).toBe(4);
      expect(p1.totalPages).toBe(2);
      // default sort orderedAt desc → newest (o1) first
      expect(p1.orders[0].id).toBe(o1.id);
      // no overlap between pages
      expect(p1.orders.map((o) => o.id).some((id) => p2.orders.map((o) => o.id).includes(id))).toBe(false);

      // ── detail: scope + ref resolution + disclosure ─────────────────────
      expect((await getOrderDetail(adminActor, o1.id)).order.id).toBe(o1.id);
      expect((await getOrderDetail(adminActor, "CO-1")).order.id).toBe(o1.id);
      expect((await getOrderDetail(adminActor, "EXT-1")).order.id).toBe(o1.id);
      expect((await getOrderDetail(userAActor, o1.id)).order.id).toBe(o1.id);
      // out-of-scope order → NotFound (existence not leaked as 403)
      await expect(getOrderDetail(userBActor, o1.id)).rejects.toBeInstanceOf(NotFoundError);
      // deleted: non-admin cannot see, admin can
      await expect(getOrderDetail(userAActor, oDel.id)).rejects.toBeInstanceOf(NotFoundError);
      expect((await getOrderDetail(adminActor, oDel.id)).order.id).toBe(oDel.id);

      // ref resolver directly
      expect(await resolveOrderRefForActor(adminActor, "CO-3")).toBe(o3.id);
      await expect(resolveOrderRefForActor(userBActor, o1.id)).rejects.toBeInstanceOf(NotFoundError);

      // ── finance snapshot ────────────────────────────────────────────────
      const snap = await getOrderFinanceSnapshot(adminActor, o1.id);
      expect(snap.order.id).toBe(o1.id);
      expect(snap.order.financeAmount).toBe(10000);
      expect(snap.finance.financeAmount).toBe(10000);
      expect(snap.finance.receiptAmount).toBe(0);
      await expect(getOrderFinanceSnapshot(userBActor, o1.id)).rejects.toBeInstanceOf(NotFoundError);

      // ── summary ─────────────────────────────────────────────────────────
      const summary = await getOrderSummary(adminActor, o1.id);
      expect(summary.orderId).toBe(o1.id);
      expect(summary.orderAmount).toBe(10000);
      expect(summary.effectiveAmount).toBe(10000);

      // ── pending receipts: CONFIRMED/DELIVERED with outstanding > 0 ───────
      const pending = await listPendingReceiptOrders(adminActor, { limit: 10 });
      expect(pending.items.map((i) => i.id).sort()).toEqual([o1.id, o3.id, oRep.id].sort());
      expect(pending.items.find((i) => i.id === o1.id)?.outstandingAmount).toBe(10000);
      // userB pending → none (o2 is DRAFT and not receivable)
      const bPending = await listPendingReceiptOrders(userBActor, { limit: 10 });
      expect(bPending.items).toHaveLength(0);

      // ── parity: Agent adapter calls the SAME exported service ───────────
      const agentSearch = await executeAgentAction<{ items: Array<{ id: string }> }>(
        agentExecCtx(adminActor),
        "orders.search",
        { query: "Alpha" },
      );
      expect(agentSearch.result.items.map((i) => i.id)).toEqual(
        (await queryOrders(adminActor, { filters: { search: "Alpha" } })).orders.map((o) => o.id),
      );

      const agentDetail = await executeAgentAction<{ order: { id: string } }>(
        agentExecCtx(adminActor),
        "orders.get_detail",
        { orderId: o1.id },
      );
      expect(agentDetail.result.order.id).toBe((await getOrderDetail(adminActor, o1.id)).order.id);

      // Agent get_detail out-of-scope also 404-maps (not leaked)
      await expect(
        executeAgentAction(agentExecCtx(userBActor), "orders.get_detail", { orderId: o1.id }),
      ).rejects.toMatchObject({ status: 404 });
    });
  }, 120_000);
});

import { describe, expect, it } from "vitest";
import { withTempSmokeDb } from "../../../../../scripts/lib/temp-smoke-db";

import type { AgentExecutionContext, BusinessActor } from "@/lib/application/actor";

const agentExecCtx = (actor: BusinessActor): AgentExecutionContext => ({
  actor,
  invocation: { channel: "agent" },
});

/**
 * T6.2: actor-aware invoice detail/list query shared by Web routes and Agent
 * `finance.get_invoice_detail`. Covers ADMIN full disclosure, partial order scope
 * → NotFound with no out-of-scope leak, and Web/Agent parity.
 */
describe("T6.2 invoice detail/query disclosure", () => {
  it("enforces full-scope disclosure and Agent/Web parity", async () => {
    await withTempSmokeDb(async () => {
      const { prisma } = await import("@/lib/prisma");
      const {
        getInvoiceDetailForActor,
        shapeInvoiceDetailForAgent,
      } = await import("@/lib/finance/application/query-invoice-detail");
      const { queryOrderInvoicesForActor } = await import(
        "@/lib/finance/application/query-order-invoices"
      );
      const { NotFoundError } = await import("@/lib/application/errors");
      const { executeAgentAction } = await import("@/lib/agent-actions/registry");

      const admin = await prisma.user.create({
        data: { email: "t62-admin@example.com", name: "Admin", password: "h", role: "ADMIN" },
      });
      const userA = await prisma.user.create({
        data: { email: "t62-usera@example.com", name: "UserA", password: "h", role: "USER" },
      });
      const userB = await prisma.user.create({
        data: { email: "t62-userb@example.com", name: "UserB", password: "h", role: "USER" },
      });

      const adminActor = { userId: admin.id, role: "ADMIN" };
      const userAActor = { userId: userA.id, role: "USER", email: userA.email, name: userA.name };

      const profileA = await prisma.crmCustomerProfile.create({
        data: { ownerUserId: userA.id, name: "Customer A", assignmentStatus: "ASSIGNED" },
      });
      const profileB = await prisma.crmCustomerProfile.create({
        data: { ownerUserId: userB.id, name: "Customer B", assignmentStatus: "ASSIGNED" },
      });

      const org = await prisma.organization.create({
        data: {
          orgCode: "T62-ORG",
          canonicalName: "测试医院",
          normalizedName: "测试医院",
        },
      });

      const orderA = await prisma.order.create({
        data: {
          orderNo: "T62-A",
          source: "MANUAL",
          profileId: profileA.id,
          title: "Order A",
          createdById: admin.id,
          totalAmount: 50_000,
          status: "CONFIRMED",
        },
      });
      const orderB = await prisma.order.create({
        data: {
          orderNo: "T62-B",
          source: "MANUAL",
          profileId: profileB.id,
          title: "Order B",
          createdById: admin.id,
          totalAmount: 50_000,
          status: "CONFIRMED",
        },
      });

      const invoiceSingleA = await prisma.externalOrderInvoiceRequest.create({
        data: {
          orderId: orderA.id,
          buyerOrganizationId: org.id,
          buyerOrganizationName: org.canonicalName,
          totalAmount: 50_000,
          status: "ISSUED",
          actualIssuedAt: new Date(),
          actualInvoiceNo: "INV-A",
          createdById: admin.id,
          orderCoverage: {
            create: [{ orderId: orderA.id, amount: 50_000 }],
          },
        },
      });

      const invoiceMulti = await prisma.externalOrderInvoiceRequest.create({
        data: {
          orderId: orderA.id,
          buyerOrganizationId: org.id,
          buyerOrganizationName: org.canonicalName,
          totalAmount: 100_000,
          status: "ISSUED",
          actualIssuedAt: new Date(),
          actualInvoiceNo: "INV-MULTI",
          createdById: admin.id,
          orderCoverage: {
            create: [
              { orderId: orderA.id, amount: 50_000 },
              { orderId: orderB.id, amount: 50_000 },
            ],
          },
        },
      });

      const adminSingle = await getInvoiceDetailForActor(adminActor, invoiceSingleA.id);
      expect(adminSingle.disclosure).toBe("FULL");
      expect(adminSingle.invoice.totalAmount).toBe(50_000);
      expect(adminSingle.coveredOrders.map((c) => c.orderId)).toEqual([orderA.id]);

      const adminMulti = await getInvoiceDetailForActor(adminActor, invoiceMulti.id);
      expect(adminMulti.disclosure).toBe("FULL");
      expect(adminMulti.coveredOrders.map((c) => c.orderId).sort()).toEqual(
        [orderA.id, orderB.id].sort(),
      );

      const userSingle = await getInvoiceDetailForActor(userAActor, invoiceSingleA.id);
      expect(userSingle.disclosure).toBe("FULL");
      expect(userSingle.coveredOrders.every((c) => c.orderId === orderA.id)).toBe(true);

      await expect(
        getInvoiceDetailForActor(userAActor, invoiceMulti.id),
      ).rejects.toBeInstanceOf(NotFoundError);

      const agentSingle = await executeAgentAction<{
        invoice: { id: string };
        coveredOrders: Array<{ orderId: string; orderNo: string; title: string; amount: number }>;
      }>(agentExecCtx(userAActor), "finance.get_invoice_detail", { invoiceId: invoiceSingleA.id });
      const shapedSingle = shapeInvoiceDetailForAgent(userSingle);
      expect(agentSingle.result.invoice.id).toBe(shapedSingle.invoice.id);
      expect(agentSingle.result.coveredOrders).toEqual(shapedSingle.coveredOrders);

      await expect(
        executeAgentAction(agentExecCtx(userAActor), "finance.get_invoice_detail", {
          invoiceId: invoiceMulti.id,
        }),
      ).rejects.toMatchObject({ status: 404 });

      const listAdmin = await queryOrderInvoicesForActor(adminActor, {
        page: 1,
        pageSize: 50,
      });
      const adminListIds = listAdmin.invoices.map((i) => i.id);
      expect(adminListIds).toContain(invoiceSingleA.id);
      expect(adminListIds).toContain(invoiceMulti.id);

      const listUser = await queryOrderInvoicesForActor(userAActor, {
        page: 1,
        pageSize: 50,
      });
      const userListIds = listUser.invoices.map((i) => i.id);
      expect(userListIds).toContain(invoiceSingleA.id);
      expect(userListIds).not.toContain(invoiceMulti.id);

      const multiInUserList = listUser.invoices.find((i) => i.id === invoiceMulti.id);
      expect(multiInUserList).toBeUndefined();

      for (const inv of listUser.invoices) {
        for (const cov of inv.orderCoverage) {
          expect(cov.order.id).not.toBe(orderB.id);
        }
      }
    });
  });
});

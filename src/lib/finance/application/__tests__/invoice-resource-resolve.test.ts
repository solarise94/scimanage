import { describe, expect, it } from "vitest";
import { withTempSmokeDb } from "../../../../../scripts/lib/temp-smoke-db";

/**
 * T6.7: actor-aware invoice resource resolver for Agent resource navigation.
 */
describe("T6.7 getInvoiceResourceForActor", () => {
  it("returns href for in-scope order/project invoices and NotFound on partial order scope", async () => {
    await withTempSmokeDb(async () => {
      const { prisma } = await import("@/lib/prisma");
      const { getInvoiceResourceForActor } = await import(
        "@/lib/finance/application/query-invoice-detail"
      );
      const { NotFoundError } = await import("@/lib/application/errors");

      const admin = await prisma.user.create({
        data: { email: "t67-admin@example.com", name: "Admin", password: "h", role: "ADMIN" },
      });
      const userA = await prisma.user.create({
        data: { email: "t67-usera@example.com", name: "UserA", password: "h", role: "USER" },
      });
      const userB = await prisma.user.create({
        data: { email: "t67-userb@example.com", name: "UserB", password: "h", role: "USER" },
      });

      const adminActor = { userId: admin.id, role: "ADMIN" };
      const userAActor = { userId: userA.id, role: "USER" };

      const profileA = await prisma.crmCustomerProfile.create({
        data: { ownerUserId: userA.id, name: "Customer A", assignmentStatus: "ASSIGNED" },
      });
      const profileB = await prisma.crmCustomerProfile.create({
        data: { ownerUserId: userB.id, name: "Customer B", assignmentStatus: "ASSIGNED" },
      });

      const org = await prisma.organization.create({
        data: {
          orgCode: "T67-ORG",
          canonicalName: "测试医院",
          normalizedName: "测试医院",
        },
      });

      const orderA = await prisma.order.create({
        data: {
          orderNo: "T67-A",
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
          orderNo: "T67-B",
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

      const project = await prisma.project.create({
        data: {
          name: "Project A",
          status: "IN_PROGRESS",
          profileId: profileA.id,
          members: { create: { userId: userA.id, role: "OWNER" } },
        },
      });

      const projectInvoice = await prisma.projectInvoice.create({
        data: {
          projectId: project.id,
          buyerOrganizationName: "项目买方",
          totalAmount: 30_000,
          status: "ISSUED",
          createdById: admin.id,
        },
      });

      const singleResource = await getInvoiceResourceForActor(userAActor, invoiceSingleA.id);
      expect(singleResource).toMatchObject({
        id: invoiceSingleA.id,
        kind: "order_invoice",
        href: `/finance/invoices?invoiceId=${invoiceSingleA.id}`,
        title: "INV-A",
      });

      await expect(
        getInvoiceResourceForActor(userAActor, invoiceMulti.id),
      ).rejects.toBeInstanceOf(NotFoundError);

      const projectResource = await getInvoiceResourceForActor(userAActor, projectInvoice.id);
      expect(projectResource).toMatchObject({
        id: projectInvoice.id,
        kind: "project_invoice",
        href: `/finance/project-invoices?projectId=${encodeURIComponent(project.id)}`,
        title: "项目买方",
      });

      const adminMulti = await getInvoiceResourceForActor(adminActor, invoiceMulti.id);
      expect(adminMulti.kind).toBe("order_invoice");
    });
  });
});

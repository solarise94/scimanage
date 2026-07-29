import { describe, expect, it } from "vitest";
import { withTempSmokeDb } from "../../../../../scripts/lib/temp-smoke-db";

describe("linkOrderToProjectForActor (T2.3)", () => {
  it("ADMIN links same-profile order/project; USER forbidden; conflict/duplicate blocked", async () => {
    await withTempSmokeDb(async () => {
      const { prisma } = await import("@/lib/prisma");
      const {
        linkOrderToProjectForActor,
        OrderCustomerConflictError,
      } = await import("@/lib/orders/application/link-order-project");
      const { buildInvocationContext } = await import("@/lib/application/actor");
      const { ForbiddenError, ConflictError } = await import("@/lib/application/errors");

      const admin = await prisma.user.create({
        data: { email: "t23-admin@example.com", name: "Admin", password: "h", role: "ADMIN" },
      });
      const user = await prisma.user.create({
        data: { email: "t23-user@example.com", name: "User", password: "h", role: "USER" },
      });

      const profileA = await prisma.crmCustomerProfile.create({
        data: { name: "客户A", ownerUserId: admin.id, deleted: false, archived: false },
      });
      const profileB = await prisma.crmCustomerProfile.create({
        data: { name: "客户B", ownerUserId: admin.id, deleted: false, archived: false },
      });

      const order = await prisma.order.create({
        data: {
          orderNo: "SO-T23-001",
          title: "订单A",
          status: "DRAFT",
          source: "MANUAL",
          category: "SERVICE",
          totalAmount: 10000,
          profileId: profileA.id,
          createdById: admin.id,
        },
      });
      const projectSame = await prisma.project.create({
        data: {
          name: "项目同客户",
          status: "ACTIVE",
          profile: { connect: { id: profileA.id } },
        },
      });
      const projectOther = await prisma.project.create({
        data: {
          name: "项目异客户",
          status: "ACTIVE",
          profile: { connect: { id: profileB.id } },
        },
      });

      const adminActor = { userId: admin.id, role: "ADMIN", name: "Admin", email: admin.email };
      const userActor = { userId: user.id, role: "USER", name: "User", email: user.email };
      const invocation = buildInvocationContext({ channel: "web" });

      await expect(
        linkOrderToProjectForActor(userActor, invocation, {
          orderId: order.id,
          projectId: projectSame.id,
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);

      await expect(
        linkOrderToProjectForActor(adminActor, invocation, {
          orderId: order.id,
          projectId: projectOther.id,
        }),
      ).rejects.toBeInstanceOf(OrderCustomerConflictError);

      expect(await prisma.orderProjectLink.count()).toBe(0);

      const linked = await linkOrderToProjectForActor(adminActor, invocation, {
        orderId: order.id,
        projectId: projectSame.id,
        treatment: "PROJECT_INCLUDED",
        allocatedAmount: 50,
        moneyUnit: "yuan",
        isPrimary: true,
      });

      expect(linked.link.orderId).toBe(order.id);
      expect(linked.link.projectId).toBe(projectSame.id);
      expect(linked.link.allocatedAmount).toBe(5000);
      expect(linked.link.isPrimary).toBe(true);
      expect(await prisma.orderProjectLink.count()).toBe(1);

      await expect(
        linkOrderToProjectForActor(adminActor, invocation, {
          orderId: order.id,
          projectId: projectSame.id,
        }),
      ).rejects.toBeInstanceOf(ConflictError);
    });
  }, 120_000);
});

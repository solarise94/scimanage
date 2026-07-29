import { describe, expect, it } from "vitest";
import { withTempSmokeDb } from "../../../../../scripts/lib/temp-smoke-db";

describe("createOrderForActor (T2.2b)", () => {
  it("ADMIN creates order; USER is forbidden; failed prepare leaves no order", async () => {
    await withTempSmokeDb(async () => {
      const { prisma } = await import("@/lib/prisma");
      const { createOrderForActor } = await import("@/lib/orders/application/create-order");
      const { buildInvocationContext } = await import("@/lib/application/actor");
      const { ForbiddenError, ValidationError } = await import("@/lib/application/errors");

      const admin = await prisma.user.create({
        data: { email: "t22b-admin@example.com", name: "Admin", password: "h", role: "ADMIN" },
      });
      const user = await prisma.user.create({
        data: { email: "t22b-user@example.com", name: "User", password: "h", role: "USER" },
      });

      const org = await prisma.organization.create({
        data: {
          orgCode: "T22B-ORG-1",
          canonicalName: "测试单位B",
          normalizedName: "测试单位b",
        },
      });
      const profile = await prisma.crmCustomerProfile.create({
        data: {
          name: "客户乙",
          organizationId: org.id,
          ownerUserId: admin.id,
          deleted: false,
          archived: false,
        },
      });

      const adminActor = { userId: admin.id, role: "ADMIN", name: "Admin", email: admin.email };
      const userActor = { userId: user.id, role: "USER", name: "User", email: user.email };
      const webInvocation = buildInvocationContext({ channel: "web" });

      // Phase 1 review #2：新业务订单必须绑定 SKU。seed Product + SKU 供订单行使用。
      const product = await prisma.product.create({
        data: {
          productCode: "PRD-000001",
          name: "测序服务",
          kind: "SERVICE",
          status: "ACTIVE",
          createdById: admin.id,
          skus: {
            create: [{
              skuCode: "SKU-000001",
              name: "测序服务",
              standardUnit: "样本",
              sellable: true,
              purchasable: true,
              status: "ACTIVE",
              createdById: admin.id,
            }],
          },
        },
        include: { skus: true },
      });
      const skuId = product.skus[0].id;

      await expect(
        createOrderForActor(userActor, webInvocation, {
          title: "越权订单",
          profileId: profile.id,
          moneyUnit: "yuan",
          totalAmount: 100,
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);

      expect(await prisma.order.count()).toBe(0);

      await expect(
        createOrderForActor(adminActor, webInvocation, {
          title: "缺客户",
          profileId: "",
          moneyUnit: "yuan",
          totalAmount: 100,
        }),
      ).rejects.toBeInstanceOf(ValidationError);

      expect(await prisma.order.count()).toBe(0);

      const created = await createOrderForActor(adminActor, webInvocation, {
        title: "正式订单",
        profileId: profile.id,
        moneyUnit: "yuan",
        totalAmount: 99.5,
        category: "SERVICE",
        lines: [
          {
            itemName: "测序服务",
            quantity: 1,
            unitPrice: 99.5,
            amount: 99.5,
            productSkuId: skuId,
          },
        ],
      });

      expect(created.order.title).toBe("正式订单");
      expect(created.order.profileId).toBe(profile.id);
      expect(created.order.totalAmount).toBe(9950);
      expect(created.order.createdById).toBe(admin.id);
      expect(created.order.buyerOrganizationId).toBe(org.id);
      expect(created.prepared.meta.profileName).toBe("客户乙");
      expect(created.invocation.channel).toBe("web");

      expect(await prisma.order.count()).toBe(1);
      expect(await prisma.orderLine.count({ where: { orderId: created.order.id } })).toBe(1);
    });
  }, 120_000);
});

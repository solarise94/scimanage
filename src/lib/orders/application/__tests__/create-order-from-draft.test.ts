import { describe, expect, it } from "vitest";
import { withTempSmokeDb } from "../../../../../scripts/lib/temp-smoke-db";

describe("createOrderFromDraftForActor (P0 atomic draft consume)", () => {
  it("atomically creates order and marks draft CONSUMED; rejects non-PROPOSED / version mismatch", async () => {
    await withTempSmokeDb(async () => {
      const { prisma } = await import("@/lib/prisma");
      const { createOrderFromDraftForActor } = await import(
        "@/lib/orders/application/create-order"
      );
      const { buildInvocationContext } = await import("@/lib/application/actor");
      const { ConflictError, ForbiddenError } = await import("@/lib/application/errors");

      const admin = await prisma.user.create({
        data: { email: "draft-atom-admin@example.com", name: "Admin", password: "h", role: "ADMIN" },
      });
      const other = await prisma.user.create({
        data: { email: "draft-atom-other@example.com", name: "Other", password: "h", role: "ADMIN" },
      });

      const org = await prisma.organization.create({
        data: {
          orgCode: "DRAFT-ATOM-ORG",
          canonicalName: "草稿原子单位",
          normalizedName: "草稿原子单位",
        },
      });
      const profile = await prisma.crmCustomerProfile.create({
        data: {
          name: "草稿客户",
          organizationId: org.id,
          ownerUserId: admin.id,
          deleted: false,
          archived: false,
        },
      });

      // Phase 1 review #2：新业务订单（含草稿落单）必须绑定 SKU。seed Product + SKU。
      const product = await prisma.product.create({
        data: {
          productCode: "PRD-000001",
          name: "单细胞测序",
          kind: "SERVICE",
          status: "ACTIVE",
          createdById: admin.id,
          skus: {
            create: [{
              skuCode: "SKU-000001",
              name: "单细胞测序",
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

      const draft = await prisma.orderDraft.create({
        data: {
          ownerUserId: admin.id,
          customerProfileId: profile.id,
          status: "PROPOSED",
          version: 3,
          titleSnapshot: "单细胞测序 / 单细胞测序",
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          lines: {
            create: [
              {
                sortOrder: 0,
                productKey: "SKU-000001",
                productSkuId: skuId,
                productCodeSnapshot: "PRD-000001",
                skuCodeSnapshot: "SKU-000001",
                productDisplayNameSnapshot: "单细胞测序 / 单细胞测序",
                projectTypeKey: "SERVICE",
                quantity: 1,
                unitPriceCents: 12_500,
              },
            ],
          },
        },
      });

      const actor = { userId: admin.id, role: "ADMIN", name: "Admin", email: admin.email };
      const otherActor = { userId: other.id, role: "ADMIN", name: "Other", email: other.email };
      const invocation = buildInvocationContext({
        channel: "agent",
        proposalId: "prop-draft-atom-1",
      });

      await expect(
        createOrderFromDraftForActor(otherActor, invocation, {
          orderDraftId: draft.id,
          expectedVersion: 3,
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      expect(await prisma.order.count()).toBe(0);

      await expect(
        createOrderFromDraftForActor(actor, invocation, {
          orderDraftId: draft.id,
          expectedVersion: 2,
        }),
      ).rejects.toBeInstanceOf(ConflictError);
      expect(await prisma.order.count()).toBe(0);

      const created = await createOrderFromDraftForActor(actor, invocation, {
        orderDraftId: draft.id,
        expectedVersion: 3,
      });

      expect(created.order.title).toBe("单细胞测序 / 单细胞测序");
      expect(created.order.totalAmount).toBe(12_500);
      expect(created.order.technicalOwnerUserId).toBe(admin.id);

      const freshDraft = await prisma.orderDraft.findUnique({ where: { id: draft.id } });
      expect(freshDraft?.status).toBe("CONSUMED");
      expect(await prisma.order.count()).toBe(1);

      // 再次消费同一草稿 → Conflict，不落第二单
      await expect(
        createOrderFromDraftForActor(actor, invocation, {
          orderDraftId: draft.id,
          expectedVersion: 3,
        }),
      ).rejects.toBeInstanceOf(ConflictError);
      expect(await prisma.order.count()).toBe(1);
    });
  });
});

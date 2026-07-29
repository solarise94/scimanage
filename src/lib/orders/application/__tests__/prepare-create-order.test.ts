import { describe, expect, it } from "vitest";
import { withTempSmokeDb } from "../../../../../scripts/lib/temp-smoke-db";

describe("prepareCreateOrderForActor (T2.2a)", () => {
  it("enforces ADMIN-only, active profile, and authoritative CRM context", async () => {
    await withTempSmokeDb(async () => {
      const { prisma } = await import("@/lib/prisma");
      const { prepareCreateOrderForActor } = await import(
        "@/lib/orders/application/prepare-create-order"
      );
      const { ForbiddenError, ValidationError } = await import("@/lib/application/errors");

      const admin = await prisma.user.create({
        data: { email: "t22a-admin@example.com", name: "Admin", password: "h", role: "ADMIN" },
      });
      const user = await prisma.user.create({
        data: { email: "t22a-user@example.com", name: "User", password: "h", role: "USER" },
      });

      const org = await prisma.organization.create({
        data: {
          orgCode: "T22A-ORG-1",
          canonicalName: "测试单位A",
          normalizedName: "测试单位a",
        },
      });
      const profile = await prisma.crmCustomerProfile.create({
        data: {
          name: "客户甲",
          organizationId: org.id,
          ownerUserId: admin.id,
          deleted: false,
          archived: false,
        },
      });
      const archived = await prisma.crmCustomerProfile.create({
        data: {
          name: "已归档客户",
          ownerUserId: admin.id,
          deleted: false,
          archived: true,
        },
      });

      const adminActor = { userId: admin.id, role: "ADMIN", name: "Admin", email: admin.email };
      const userActor = { userId: user.id, role: "USER", name: "User", email: user.email };

      await expect(
        prepareCreateOrderForActor(userActor, {
          title: "U订单",
          profileId: profile.id,
          moneyUnit: "yuan",
          totalAmount: 100,
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);

      await expect(
        prepareCreateOrderForActor(adminActor, {
          title: "缺客户",
          profileId: "",
          moneyUnit: "yuan",
          totalAmount: 100,
        }),
      ).rejects.toBeInstanceOf(ValidationError);

      await expect(
        prepareCreateOrderForActor(adminActor, {
          title: "归档客户",
          profileId: archived.id,
          moneyUnit: "yuan",
          totalAmount: 100,
        }),
      ).rejects.toBeInstanceOf(ValidationError);

      await expect(
        prepareCreateOrderForActor(adminActor, {
          title: "伪造单位",
          profileId: profile.id,
          moneyUnit: "yuan",
          totalAmount: 100,
          buyerOrganizationId: "forged-org-id",
        }),
      ).rejects.toBeInstanceOf(ValidationError);

      const prepared = await prepareCreateOrderForActor(adminActor, {
        title: " 正式订单 ",
        profileId: profile.id,
        moneyUnit: "yuan",
        totalAmount: 12.5,
        category: "SERVICE",
        representativeId: "forged-rep-id",
        buyerNameSnapshot: "伪造姓名",
        buyerOrgNameSnapshot: "伪造单位名",
      });

      expect(prepared.payload.title).toBe("正式订单");
      expect(prepared.payload.profileId).toBe(profile.id);
      expect(prepared.payload.buyerOrganizationId).toBe(org.id);
      expect(prepared.payload.totalAmount).toBe(1250);
      expect(prepared.payload.createdById).toBe(admin.id);
      expect(prepared.payload.buyerNameSnapshot).toBe("客户甲");
      expect(prepared.payload.buyerOrgNameSnapshot).toBe("测试单位A");
      expect(prepared.payload.representativeId).not.toBe("forged-rep-id");
    });
  }, 120_000);
});

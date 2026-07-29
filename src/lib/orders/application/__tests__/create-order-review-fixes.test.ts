import { describe, expect, it } from "vitest";
import { withTempSmokeDb } from "../../../../../scripts/lib/temp-smoke-db";

describe("create-order review fixes", () => {
  it("rejects invalid status; TOCTOU archived profile fails at write; CRM snapshots win", async () => {
    await withTempSmokeDb(async () => {
      const { prisma } = await import("@/lib/prisma");
      const { prepareCreateOrderForActor } = await import(
        "@/lib/orders/application/prepare-create-order"
      );
      const { createOrderForActor } = await import("@/lib/orders/application/create-order");
      const { buildInvocationContext } = await import("@/lib/application/actor");
      const { ValidationError } = await import("@/lib/application/errors");

      const admin = await prisma.user.create({
        data: { email: "fix-admin@example.com", name: "Admin", password: "h", role: "ADMIN" },
      });
      const org = await prisma.organization.create({
        data: {
          orgCode: "FIX-ORG-1",
          canonicalName: "权威单位",
          normalizedName: "权威单位",
        },
      });
      const profile = await prisma.crmCustomerProfile.create({
        data: {
          name: "权威客户",
          organizationId: org.id,
          ownerUserId: admin.id,
          deleted: false,
          archived: false,
        },
      });

      const actor = { userId: admin.id, role: "ADMIN", name: "Admin", email: admin.email };
      const invocation = buildInvocationContext({ channel: "web" });

      await expect(
        prepareCreateOrderForActor(actor, {
          title: "坏状态",
          profileId: profile.id,
          moneyUnit: "yuan",
          totalAmount: 10,
          status: "SHIPPED",
        }),
      ).rejects.toBeInstanceOf(ValidationError);

      const prepared = await prepareCreateOrderForActor(actor, {
        title: "快照订单",
        profileId: profile.id,
        moneyUnit: "yuan",
        totalAmount: 10,
        buyerNameSnapshot: "文件姓名",
        buyerOrgNameSnapshot: "文件单位",
      });
      expect(prepared.payload.buyerNameSnapshot).toBe("权威客户");
      expect(prepared.payload.buyerOrgNameSnapshot).toBe("权威单位");

      // CRM 联系字段为空时，文件原文不得填入正式快照。
      const emptyContact = await prisma.crmCustomerProfile.create({
        data: {
          name: "仅有姓名",
          ownerUserId: admin.id,
          deleted: false,
          archived: false,
          principal: null,
          wechat: null,
          address: null,
        },
      });
      const sparse = await prepareCreateOrderForActor(actor, {
        title: "空 CRM 联系字段",
        profileId: emptyContact.id,
        moneyUnit: "yuan",
        totalAmount: 10,
        buyerNameSnapshot: "文件收件人",
        buyerPhoneSnapshot: "13800001111",
        buyerWechatSnapshot: "wx-file",
        buyerAddressSnapshot: "文件地址某某路",
        buyerOrgNameSnapshot: "文件单位名",
      });
      expect(sparse.payload.buyerNameSnapshot).toBe("仅有姓名");
      expect(sparse.payload.buyerPhoneSnapshot).toBeNull();
      expect(sparse.payload.buyerWechatSnapshot).toBeNull();
      expect(sparse.payload.buyerAddressSnapshot).toBeNull();
      expect(sparse.payload.buyerOrgNameSnapshot).toBeNull();

      // Archive after prepare — in-tx write must refuse stale profile intent.
      // 必须抛具名领域错误（而非普通 Error），createOrderForActor 才能映射为 400 ValidationError。
      const { OrderProjectMissingProfileError } = await import("@/lib/orders/link-project");
      const preparedOk = await prepareCreateOrderForActor(actor, {
        title: "TOCTOU",
        profileId: profile.id,
        moneyUnit: "yuan",
        totalAmount: 10,
      });
      await prisma.crmCustomerProfile.update({
        where: { id: profile.id },
        data: { archived: true },
      });

      await expect(
        prisma.$transaction((tx) =>
          import("@/lib/orders/application/create-order").then(({ createPreparedOrderInTx }) =>
            createPreparedOrderInTx(tx, preparedOk),
          ),
        ),
      ).rejects.toBeInstanceOf(OrderProjectMissingProfileError);

      // Full command path maps the in-tx missing-profile error to 400 ValidationError.
      await expect(
        createOrderForActor(actor, invocation, {
          title: "TOCTOU2",
          profileId: profile.id,
          moneyUnit: "yuan",
          totalAmount: 10,
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  }, 120_000);
});

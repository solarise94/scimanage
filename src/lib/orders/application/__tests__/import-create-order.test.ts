import { describe, expect, it } from "vitest";
import { withTempSmokeDb } from "../../../../../scripts/lib/temp-smoke-db";

describe("import writeOrderForRow CREATE via create command (T2.5)", () => {
  it("CREATE uses prepare path; empty CRM contact fields never adopt file text", async () => {
    await withTempSmokeDb(async () => {
      const { prisma } = await import("@/lib/prisma");
      const { writeOrderForRow } = await import("@/lib/orders/import-single-row");

      const admin = await prisma.user.create({
        data: { email: "t25-admin@example.com", name: "Admin", password: "h", role: "ADMIN" },
      });
      const user = await prisma.user.create({
        data: { email: "t25-user@example.com", name: "User", password: "h", role: "USER" },
      });
      const profile = await prisma.crmCustomerProfile.create({
        data: {
          name: "导入客户",
          ownerUserId: admin.id,
          deleted: false,
          archived: false,
        },
      });

      const session = await prisma.orderImportSession.create({
        data: {
          createdById: admin.id,
          status: "READY",
          source: "OTHER_IMPORT",
          category: "SERVICE",
          parserKey: "ORDER_GENERIC",
        },
      });
      const row = await prisma.orderImportRow.create({
        data: {
          sessionId: session.id,
          rowNo: 0,
          reviewStatus: "CONFIRMED_EXISTING",
          decisionType: "PICK_EXISTING",
          confirmedProfileId: profile.id,
          version: 1,
          rawPayloadJson: "{}",
          normalizedPayloadJson: JSON.stringify({
            externalOrderNo: "EXT-T25-1",
            receiverName: "收件人",
            productNamesRaw: "单细胞测序",
            paidAmount: 200,
            platform: "测试平台",
          }),
        },
      });

      const rowSnap = {
        id: row.id,
        rowNo: 0,
        reviewStatus: "CONFIRMED_EXISTING",
        decisionType: "PICK_EXISTING",
        confirmedProfileId: profile.id,
        createCustomerDraftJson: null,
        suggestedScore: null,
        normalizedPayloadJson: row.normalizedPayloadJson,
      };
      const customer = {
        profileId: profile.id,
        representativeId: null as string | null,
        buyerOrgId: null as string | null,
        reason: "test-pick",
        repSource: "NONE" as const,
        createdProfile: false,
      };
      const parsed = JSON.parse(row.normalizedPayloadJson);

      await expect(
        prisma.$transaction((tx) =>
          writeOrderForRow(tx, {
            row: rowSnap,
            customer,
            parsed,
            normalizedSource: "OTHER_IMPORT",
            sourceRemark: null,
            category: "SERVICE",
            userId: user.id,
            actorRole: "USER",
          }),
        ),
      ).rejects.toThrow(/管理员|Forbidden|仅管理员/i);

      const created = await prisma.$transaction((tx) =>
        writeOrderForRow(tx, {
          row: rowSnap,
          customer,
          parsed,
          normalizedSource: "OTHER_IMPORT",
          sourceRemark: "t25",
          category: "SERVICE",
          userId: admin.id,
          actorRole: "ADMIN",
          actorName: "Admin",
          actorEmail: admin.email,
        }),
      );

      expect(created.created).toBe(true);
      const order = await prisma.order.findUnique({ where: { id: created.orderId } });
      expect(order?.profileId).toBe(profile.id);
      expect(order?.status).toBe("DELIVERED");
      expect(order?.source).toBe("OTHER_IMPORT");
      expect(order?.externalOrderNo).toBe("EXT-T25-1");
      expect(order?.totalAmount).toBe(20000);
      expect(order?.orderNo.startsWith("IO-")).toBe(true);

      const sourceRec = await prisma.orderSourceRecord.findFirst({
        where: { orderId: created.orderId },
      });
      expect(sourceRec?.externalOrderNo).toBe("EXT-T25-1");

      // CRM phone/wechat/address/org empty + rich file fields → formal snapshots null;
      // file text only in OrderSourceRecord.rawJson.
      const sparseProfile = await prisma.crmCustomerProfile.create({
        data: {
          name: "CRM姓名",
          ownerUserId: admin.id,
          deleted: false,
          archived: false,
          principal: null,
          wechat: null,
          address: null,
        },
      });
      const sparseParsed = JSON.parse(
        JSON.stringify({
          externalOrderNo: "EXT-SNAP-C1",
          receiverName: "文件收件人",
          receiverPhone: "13900002222",
          receiverAddress: "文件地址路1号",
          orderUser: "wx-file-user",
          storeName: "文件店铺单位",
          productNamesRaw: "测序服务",
          paidAmount: 50,
          platform: "测试平台",
          miniProgramId: "mp-file-id",
        }),
      );
      const sparseRow = await prisma.orderImportRow.create({
        data: {
          sessionId: session.id,
          rowNo: 1,
          reviewStatus: "CONFIRMED_EXISTING",
          decisionType: "PICK_EXISTING",
          confirmedProfileId: sparseProfile.id,
          version: 1,
          rawPayloadJson: "{}",
          normalizedPayloadJson: JSON.stringify(sparseParsed),
        },
      });

      const sparseCreated = await prisma.$transaction((tx) =>
        writeOrderForRow(tx, {
          row: {
            id: sparseRow.id,
            rowNo: 1,
            reviewStatus: "CONFIRMED_EXISTING",
            decisionType: "PICK_EXISTING",
            confirmedProfileId: sparseProfile.id,
            createCustomerDraftJson: null,
            suggestedScore: null,
            normalizedPayloadJson: sparseRow.normalizedPayloadJson,
          },
          customer: {
            profileId: sparseProfile.id,
            representativeId: null,
            buyerOrgId: null,
            reason: "test-pick",
            repSource: "NONE",
            createdProfile: false,
          },
          parsed: sparseParsed,
          normalizedSource: "OTHER_IMPORT",
          sourceRemark: null,
          category: "SERVICE",
          userId: admin.id,
          actorRole: "ADMIN",
          actorName: "Admin",
          actorEmail: admin.email,
        }),
      );

      const sparseOrder = await prisma.order.findUnique({ where: { id: sparseCreated.orderId } });
      expect(sparseOrder?.buyerNameSnapshot).toBe("CRM姓名");
      expect(sparseOrder?.buyerPhoneSnapshot).toBeNull();
      expect(sparseOrder?.buyerWechatSnapshot).toBeNull();
      expect(sparseOrder?.buyerAddressSnapshot).toBeNull();
      expect(sparseOrder?.buyerOrgNameSnapshot).toBeNull();
      expect(sparseOrder?.buyerMiniProgramIdSnapshot).toBeNull();

      const sparseSource = await prisma.orderSourceRecord.findFirst({
        where: { orderId: sparseCreated.orderId },
      });
      const raw = JSON.parse(sparseSource?.rawJson || "{}");
      expect(raw.receiverPhone).toBe("13900002222");
      expect(raw.receiverAddress).toBe("文件地址路1号");
      expect(raw.orderUser).toBe("wx-file-user");
      expect(raw.storeName).toBe("文件店铺单位");
    });
  }, 120_000);
});

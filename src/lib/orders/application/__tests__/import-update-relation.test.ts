import { describe, expect, it } from "vitest";
import { withTempSmokeDb } from "../../../../../scripts/lib/temp-smoke-db";

describe("import UPDATE relation protection", () => {
  it("protects non-null relations; empty CRM keeps formal snapshots over file text", async () => {
    await withTempSmokeDb(async () => {
      const { prisma } = await import("@/lib/prisma");
      const { writeOrderForRow, ImportRowConflictError } = await import(
        "@/lib/orders/import-single-row"
      );

      const admin = await prisma.user.create({
        data: { email: "upd-admin@example.com", name: "Admin", password: "h", role: "ADMIN" },
      });
      const profileA = await prisma.crmCustomerProfile.create({
        data: { name: "客户A", ownerUserId: admin.id, deleted: false, archived: false },
      });
      const profileB = await prisma.crmCustomerProfile.create({
        data: { name: "客户B", ownerUserId: admin.id, deleted: false, archived: false },
      });

      const order = await prisma.order.create({
        data: {
          orderNo: "IO-UPD-001",
          title: "既有订单",
          status: "DELIVERED",
          source: "OTHER_IMPORT",
          category: "SERVICE",
          totalAmount: 1000,
          profileId: profileA.id,
          createdById: admin.id,
          externalOrderNo: "EXT-UPD-1",
        },
      });
      await prisma.orderSourceRecord.create({
        data: {
          orderId: order.id,
          source: "OTHER_IMPORT",
          externalOrderNo: "EXT-UPD-1",
          platform: "test",
          rawJson: "{}",
        },
      });

      const session = await prisma.orderImportSession.create({
        data: {
          createdById: admin.id,
          status: "READY",
          source: "OTHER_IMPORT",
          category: "SERVICE",
        },
      });
      const row = await prisma.orderImportRow.create({
        data: {
          sessionId: session.id,
          rowNo: 0,
          reviewStatus: "CONFIRMED_EXISTING",
          decisionType: "PICK_EXISTING",
          confirmedProfileId: profileB.id,
          version: 1,
          rawPayloadJson: "{}",
          normalizedPayloadJson: JSON.stringify({
            externalOrderNo: "EXT-UPD-1",
            receiverName: "收件",
            productNamesRaw: "服务",
            paidAmount: 20,
          }),
        },
      });

      const rowSnap = {
        id: row.id,
        rowNo: 0,
        reviewStatus: "CONFIRMED_EXISTING",
        decisionType: "PICK_EXISTING",
        confirmedProfileId: profileB.id,
        createCustomerDraftJson: null,
        suggestedScore: null,
        normalizedPayloadJson: row.normalizedPayloadJson,
      };
      const customerB = {
        profileId: profileB.id,
        representativeId: null as string | null,
        buyerOrgId: null as string | null,
        reason: "pick-b",
        repSource: "NONE" as const,
        createdProfile: false,
      };
      const parsed = JSON.parse(row.normalizedPayloadJson);

      await expect(
        prisma.$transaction((tx) =>
          writeOrderForRow(tx, {
            row: rowSnap,
            customer: customerB,
            parsed,
            normalizedSource: "OTHER_IMPORT",
            sourceRemark: null,
            category: "SERVICE",
            userId: admin.id,
            actorRole: "ADMIN",
          }),
        ),
      ).rejects.toBeInstanceOf(ImportRowConflictError);

      const unchanged = await prisma.order.findUnique({ where: { id: order.id } });
      expect(unchanged?.profileId).toBe(profileA.id);

      // Same profile → UPDATE allowed, relation preserved.
      const customerA = {
        profileId: profileA.id,
        representativeId: null as string | null,
        buyerOrgId: null as string | null,
        reason: "pick-a",
        repSource: "NONE" as const,
        createdProfile: false,
      };
      const same = await prisma.$transaction((tx) =>
        writeOrderForRow(tx, {
          row: { ...rowSnap, confirmedProfileId: profileA.id },
          customer: customerA,
          parsed,
          normalizedSource: "OTHER_IMPORT",
          sourceRemark: "ok",
          category: "SERVICE",
          userId: admin.id,
          actorRole: "ADMIN",
        }),
      );
      expect(same.created).toBe(false);
      const after = await prisma.order.findUnique({ where: { id: order.id } });
      expect(after?.profileId).toBe(profileA.id);
      expect(after?.sourceRemark).toBe("ok");

      // CRM contact fields empty + rich file fields → keep prior formal snapshots.
      const snapProfile = await prisma.crmCustomerProfile.create({
        data: {
          name: "快照客户",
          ownerUserId: admin.id,
          deleted: false,
          archived: false,
          principal: null,
          wechat: null,
          address: null,
        },
      });
      const snapOrder = await prisma.order.create({
        data: {
          orderNo: "IO-UPD-SNAP-001",
          title: "既有订单",
          status: "DELIVERED",
          source: "OTHER_IMPORT",
          category: "SERVICE",
          totalAmount: 1000,
          profileId: snapProfile.id,
          createdById: admin.id,
          externalOrderNo: "EXT-UPD-SNAP-1",
          buyerNameSnapshot: "既有正式姓名",
          buyerPhoneSnapshot: "13700000000",
          buyerWechatSnapshot: "wx-formal",
          buyerAddressSnapshot: "既有正式地址",
          buyerOrgNameSnapshot: "既有正式单位",
          buyerMiniProgramIdSnapshot: "mp-formal",
        },
      });
      await prisma.orderSourceRecord.create({
        data: {
          orderId: snapOrder.id,
          source: "OTHER_IMPORT",
          externalOrderNo: "EXT-UPD-SNAP-1",
          platform: "test",
          rawJson: "{}",
        },
      });
      const snapParsed = JSON.parse(
        JSON.stringify({
          externalOrderNo: "EXT-UPD-SNAP-1",
          receiverName: "文件收件人",
          receiverPhone: "13911112222",
          receiverAddress: "文件新地址",
          orderUser: "wx-file",
          storeName: "文件单位",
          productNamesRaw: "服务",
          paidAmount: 20,
          miniProgramId: "mp-file",
        }),
      );
      const snapRow = await prisma.orderImportRow.create({
        data: {
          sessionId: session.id,
          rowNo: 1,
          reviewStatus: "CONFIRMED_EXISTING",
          decisionType: "PICK_EXISTING",
          confirmedProfileId: snapProfile.id,
          version: 1,
          rawPayloadJson: "{}",
          normalizedPayloadJson: JSON.stringify(snapParsed),
        },
      });

      await prisma.$transaction((tx) =>
        writeOrderForRow(tx, {
          row: {
            id: snapRow.id,
            rowNo: 1,
            reviewStatus: "CONFIRMED_EXISTING",
            decisionType: "PICK_EXISTING",
            confirmedProfileId: snapProfile.id,
            createCustomerDraftJson: null,
            suggestedScore: null,
            normalizedPayloadJson: snapRow.normalizedPayloadJson,
          },
          customer: {
            profileId: snapProfile.id,
            representativeId: null,
            buyerOrgId: null,
            reason: "pick-snap",
            repSource: "NONE",
            createdProfile: false,
          },
          parsed: snapParsed,
          normalizedSource: "OTHER_IMPORT",
          sourceRemark: "snap-keep",
          category: "SERVICE",
          userId: admin.id,
          actorRole: "ADMIN",
        }),
      );

      const snapAfter = await prisma.order.findUnique({ where: { id: snapOrder.id } });
      expect(snapAfter?.buyerNameSnapshot).toBe("快照客户");
      expect(snapAfter?.buyerPhoneSnapshot).toBe("13700000000");
      expect(snapAfter?.buyerWechatSnapshot).toBe("wx-formal");
      expect(snapAfter?.buyerAddressSnapshot).toBe("既有正式地址");
      expect(snapAfter?.buyerOrgNameSnapshot).toBe("既有正式单位");
      expect(snapAfter?.buyerMiniProgramIdSnapshot).toBe("mp-formal");
      expect(snapAfter?.sourceRemark).toBe("snap-keep");

      const snapSource = await prisma.orderSourceRecord.findFirst({
        where: { orderId: snapOrder.id },
      });
      const raw = JSON.parse(snapSource?.rawJson || "{}");
      expect(raw.receiverPhone).toBe("13911112222");
      expect(raw.storeName).toBe("文件单位");
    });
  }, 120_000);
});

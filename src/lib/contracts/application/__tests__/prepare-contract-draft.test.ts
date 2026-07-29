import { describe, expect, it } from "vitest";
import { withTempSmokeDb } from "../../../../../scripts/lib/temp-smoke-db";

/**
 * T8.2a: prepareContractDraftForActor canonical service.
 * - 角色/存在/scope/同买方/模板/卖方校验；
 * - 默认模板与卖方解析；
 * - C6 类别适配仅 warning 不阻止；
 * - intent 按 owner+digest 复用；已有合同只提示。
 */
describe("T8.2a prepareContractDraftForActor", () => {
  it("validates, resolves defaults, warns on category mismatch, reuses intent by digest", async () => {
    await withTempSmokeDb(async () => {
      const { prisma } = await import("@/lib/prisma");
      const { prepareContractDraftForActor } = await import(
        "@/lib/contracts/application/prepare-contract-draft"
      );
      const { previewGenerateContractForActor } = await import(
        "@/lib/contracts/application/prepare-contract-draft"
      );
      const { ForbiddenError, NotFoundError } = await import(
        "@/lib/application/errors"
      );

      const admin = await prisma.user.create({
        data: { email: "t82a-admin@example.com", name: "Admin", password: "h", role: "ADMIN" },
      });
      const repUser = await prisma.user.create({
        data: { email: "t82a-rep@example.com", name: "Rep", password: "h", role: "REPRESENTATIVE" },
      });
      await prisma.representative.create({ data: { name: "代表", email: repUser.email } });
      const profile = await prisma.crmCustomerProfile.create({
        data: { name: "草稿客户", ownerUserId: repUser.id, assignmentStatus: "ASSIGNED" },
      });

      const org = await prisma.organization.create({
        data: { orgCode: "T82A-ORG", canonicalName: "同一买方单位", normalizedName: "同一买方单位" },
      });

      const mkOrder = (orderNo: string, category: string, buyerOrgId?: string) =>
        prisma.order.create({
          data: {
            orderNo,
            source: "MANUAL",
            profileId: profile.id,
            title: orderNo,
            createdById: admin.id,
            totalAmount: 100_000,
            status: "CONFIRMED",
            category,
            buyerOrganizationId: buyerOrgId ?? org.id,
            buyerOrgNameSnapshot: "同一买方单位",
          },
        });

      const orderA = await mkOrder("T82A-A", "SERVICE");
      const orderB = await mkOrder("T82A-B", "SERVICE");

      // 不同买方（不同 buyerOrganizationId）-> CROSS_BUYER
      const orderOtherBuyer = await prisma.order.create({
        data: {
          orderNo: "T82A-OTHER",
          source: "MANUAL",
          profileId: profile.id,
          title: "T82A-OTHER",
          createdById: admin.id,
          totalAmount: 50_000,
          status: "CONFIRMED",
          category: "SERVICE",
          buyerNameSnapshot: "另一买方",
          buyerOrgNameSnapshot: "另一单位",
        },
      });

      const tplSeq = await prisma.contractTemplate.create({
        data: {
          name: "测序合同",
          category: "SEQUENCING",
          fileUrl: "/uploads/contract-templates/t82a-seq/template.docx",
          fileName: "seq.docx",
          isDefault: true,
          createdById: admin.id,
        },
      });
      const tplNda = await prisma.contractTemplate.create({
        data: {
          name: "保密协议",
          category: "NDA",
          fileUrl: "/uploads/contract-templates/t82a-nda/template.docx",
          fileName: "nda.docx",
          createdById: admin.id,
        },
      });
      const tplArchived = await prisma.contractTemplate.create({
        data: {
          name: "已归档模板",
          category: "SEQUENCING",
          fileUrl: "/uploads/contract-templates/t82a-arch/template.docx",
          fileName: "arch.docx",
          archived: true,
          createdById: admin.id,
        },
      });

      const sellerProfile = await prisma.billingProfile.create({
        data: {
          name: "默认开票主体",
          taxId: "91330000XXX",
          bankName: "测试银行",
          bankAccount: "1234567890",
          isDefault: true,
        },
      });
      const sellerArchived = await prisma.billingProfile.create({
        data: { name: "已归档主体", isDefault: false, archived: true },
      });

      const adminActor = { userId: admin.id, role: "ADMIN", name: "Admin", email: admin.email };
      const repActor = { userId: repUser.id, role: "REPRESENTATIVE", name: "Rep", email: repUser.email };

      // 1. REP -> Forbidden
      await expect(
        prepareContractDraftForActor(repActor, { orderIds: [orderA.id] }),
      ).rejects.toBeInstanceOf(ForbiddenError);

      // 2. 跨买方 -> ValidationError(CROSS_BUYER_ORDERS)
      await expect(
        prepareContractDraftForActor(adminActor, { orderIds: [orderA.id, orderOtherBuyer.id] }),
      ).rejects.toMatchObject({ message: expect.stringContaining("CROSS_BUYER_ORDERS") });

      // 3. 默认模板 + 默认卖方解析（SERVICE -> SEQUENCING 默认模板 + 唯一 isDefault seller）
      const draft = await prepareContractDraftForActor(adminActor, {
        orderIds: [orderA.id, orderB.id],
      });
      expect(draft.template.id).toBe(tplSeq.id);
      expect(draft.sellerProfile.id).toBe(sellerProfile.id);
      expect(draft.totalAmountCents).toBe(200_000);
      expect(draft.lineCount).toBe(2);
      expect(draft.primaryOrderId).toBe(orderA.id);
      expect(draft.generationIntentId).toBeTruthy();
      expect(draft.inputDigest).toHaveLength(64); // sha256 hex

      // 4. C6：显式指定 NDA 模板给 SERVICE 订单 -> warning 不阻止
      const draftNda = await prepareContractDraftForActor(adminActor, {
        orderIds: [orderA.id],
        templateId: tplNda.id,
        sellerProfileId: sellerProfile.id,
      });
      expect(draftNda.template.id).toBe(tplNda.id);
      expect(draftNda.warnings.some((w) => w.includes("模板类别") && w.includes("NDA"))).toBe(true);

      // 5. 归档模板 -> NotFound
      await expect(
        prepareContractDraftForActor(adminActor, {
          orderIds: [orderA.id],
          templateId: tplArchived.id,
          sellerProfileId: sellerProfile.id,
        }),
      ).rejects.toBeInstanceOf(NotFoundError);

      // 6. 归档 seller -> NotFound
      await expect(
        prepareContractDraftForActor(adminActor, {
          orderIds: [orderA.id],
          templateId: tplSeq.id,
          sellerProfileId: sellerArchived.id,
        }),
      ).rejects.toBeInstanceOf(NotFoundError);

      // 7. intent 复用：同 digest 两次 prepare -> 同一 generationIntentId
      const draft2 = await prepareContractDraftForActor(adminActor, {
        orderIds: [orderA.id, orderB.id],
      });
      expect(draft2.generationIntentId).toBe(draft.generationIntentId);
      expect(draft2.inputDigest).toBe(draft.inputDigest);

      // 8. 已有合同只提示不阻止
      const existingContract = await prisma.contractDocument.create({
        data: {
          contractNo: "HT-T82A-EXISTING",
          templateId: tplSeq.id,
          sellerName: "卖方",
          buyerName: "买方",
          buyerOrgName: "买方单位",
          totalAmount: 100_000,
          status: "GENERATED",
          createdById: admin.id,
        },
      });
      await prisma.orderContractCoverage.create({
        data: { contractId: existingContract.id, orderId: orderA.id },
      });
      const draftWithExisting = await prepareContractDraftForActor(adminActor, {
        orderIds: [orderA.id],
        templateId: tplSeq.id,
        sellerProfileId: sellerProfile.id,
      });
      expect(
        draftWithExisting.warnings.some((w) =>
          w.includes("已有合同") && w.includes("HT-T82A-EXISTING"),
        ),
      ).toBe(true);

      // 9. preview（buildProposal）：重新校验 + digest 比对 + proposal card 形状
      const preview = await previewGenerateContractForActor(adminActor, {
        generationIntentId: draft.generationIntentId,
        orderIds: [orderA.id, orderB.id],
        templateId: tplSeq.id,
        sellerProfileId: sellerProfile.id,
      });
      expect(preview.title).toBe("生成合同：测序合同");
      expect(preview.target).toEqual({ type: "order", id: orderA.id });
      expect(preview.proposalInput).toHaveProperty("totalAmountCents", 200_000);
      expect(preview.proposalInput).toHaveProperty("coveredOrderCount", 2);
      expect(preview.displayProps).toHaveProperty("templateName", "测序合同");
      expect(preview.displayProps).toHaveProperty("totalAmount", "¥2000.00");

      // 10. digest 变化 -> ConflictError
      const { ConflictError } = await import("@/lib/application/errors");
      await expect(
        previewGenerateContractForActor(adminActor, {
          generationIntentId: draft.generationIntentId,
          orderIds: [orderA.id], // 少了一笔 -> digest 不匹配
          templateId: tplSeq.id,
          sellerProfileId: sellerProfile.id,
        }),
      ).rejects.toBeInstanceOf(ConflictError);
    });
  }, 120_000);
});

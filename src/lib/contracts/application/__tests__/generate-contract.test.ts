import { describe, expect, it } from "vitest";
import { withTempSmokeDb } from "../../../../../scripts/lib/temp-smoke-db";

/**
 * T8.2b: generateContractForActor canonical service.
 * - Agent intent-based：proposalId 必填、digest 复核、GENERATED 幂等快路径；
 * - Web intent-less：直生成（docxBuffer）；
 * - 重新校验模板/seller 状态；错误翻译（CROSS_BUYER 400、归档 404）。
 * 实际 .docx 渲染由 smoke-test-contract-generation 脚本覆盖，本测试聚焦校验与状态机。
 */
describe("T8.2b generateContractForActor", () => {
  it("validates, re-checks template/seller, and returns existing contract on GENERATED fast path", async () => {
    await withTempSmokeDb(async () => {
      const { prisma } = await import("@/lib/prisma");
      const { generateContractForActor } = await import(
        "@/lib/contracts/application/generate-contract"
      );
      const { prepareContractDraftForActor } = await import(
        "@/lib/contracts/application/prepare-contract-draft"
      );
      const {
        ForbiddenError,
        NotFoundError,
        ValidationError,
        ConflictError,
      } = await import("@/lib/application/errors");

      const admin = await prisma.user.create({
        data: { email: "t82b-admin@example.com", name: "Admin", password: "h", role: "ADMIN" },
      });
      const repUser = await prisma.user.create({
        data: { email: "t82b-rep@example.com", name: "Rep", password: "h", role: "REPRESENTATIVE" },
      });
      await prisma.representative.create({ data: { name: "代表", email: repUser.email } });
      const profile = await prisma.crmCustomerProfile.create({
        data: { name: "生成客户", ownerUserId: repUser.id, assignmentStatus: "ASSIGNED" },
      });
      const org = await prisma.organization.create({
        data: { orgCode: "T82B-ORG", canonicalName: "买方单位", normalizedName: "买方单位" },
      });

      const order = await prisma.order.create({
        data: {
          orderNo: "T82B-A",
          source: "MANUAL",
          profileId: profile.id,
          title: "T82B-A",
          createdById: admin.id,
          // Phase E（P0-3）：Agent 合同生成要求 actor 是 technicalOwner。
          technicalOwnerUserId: admin.id,
          totalAmount: 100_000,
          status: "CONFIRMED",
          category: "SERVICE",
          buyerOrganizationId: org.id,
          buyerOrgNameSnapshot: "买方单位",
        },
      });

      const template = await prisma.contractTemplate.create({
        data: {
          name: "测序合同",
          category: "SEQUENCING",
          fileUrl: "/uploads/contract-templates/t82b/template.docx",
          fileName: "seq.docx",
          isDefault: true,
          createdById: admin.id,
        },
      });
      const tplArchived = await prisma.contractTemplate.create({
        data: {
          name: "已归档",
          category: "SEQUENCING",
          fileUrl: "/uploads/contract-templates/t82b-arch/template.docx",
          fileName: "arch.docx",
          archived: true,
          createdById: admin.id,
        },
      });
      // 另一个有效模板（用于 digest 不匹配测试）
      const tplOther = await prisma.contractTemplate.create({
        data: {
          name: "其他合同",
          category: "EQUIPMENT",
          fileUrl: "/uploads/contract-templates/t82b-other/template.docx",
          fileName: "other.docx",
          createdById: admin.id,
        },
      });

      const seller = await prisma.billingProfile.create({
        data: { name: "开票主体", taxId: "91330000XXX", isDefault: true },
      });
      const sellerArchived = await prisma.billingProfile.create({
        data: { name: "已归档主体", isDefault: false, archived: true },
      });

      const adminActor = { userId: admin.id, role: "ADMIN", name: "Admin", email: admin.email };
      const repActor = { userId: repUser.id, role: "REPRESENTATIVE", name: "Rep", email: repUser.email };

      // 1. REP -> Forbidden
      await expect(
        generateContractForActor(repActor, {
          orderIds: [order.id],
          templateId: template.id,
          sellerProfileId: seller.id,
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);

      // 2. Agent 路径无 proposalId -> ValidationError
      await expect(
        generateContractForActor(
          adminActor,
          {
            generationIntentId: "fake-intent",
            orderIds: [order.id],
            templateId: template.id,
            sellerProfileId: seller.id,
          },
          { invocation: { channel: "agent", proposalId: null } },
        ),
      ).rejects.toBeInstanceOf(ValidationError);

      // 3. 归档模板 -> NotFound
      await expect(
        generateContractForActor(adminActor, {
          orderIds: [order.id],
          templateId: tplArchived.id,
          sellerProfileId: seller.id,
        }),
      ).rejects.toBeInstanceOf(NotFoundError);

      // 4. 归档 seller -> NotFound（C7 SANCTIONED：Web 路径也开始拒绝归档 seller）
      await expect(
        generateContractForActor(adminActor, {
          orderIds: [order.id],
          templateId: template.id,
          sellerProfileId: sellerArchived.id,
        }),
      ).rejects.toBeInstanceOf(NotFoundError);

      // 5. 不存在的 intent -> NotFound
      await expect(
        generateContractForActor(
          adminActor,
          {
            generationIntentId: "nonexistent-intent",
            orderIds: [order.id],
            templateId: template.id,
            sellerProfileId: seller.id,
          },
          { invocation: { channel: "agent", proposalId: "proposal-1" } },
        ),
      ).rejects.toBeInstanceOf(NotFoundError);

      // 6. digest 不匹配 -> ConflictError
      const draft = await prepareContractDraftForActor(adminActor, {
        orderIds: [order.id],
        templateId: template.id,
        sellerProfileId: seller.id,
      });
      await expect(
        generateContractForActor(
          adminActor,
          {
            generationIntentId: draft.generationIntentId,
            orderIds: [order.id],
            templateId: tplOther.id, // 不同模板 -> digest 不匹配
            sellerProfileId: seller.id,
          },
          { invocation: { channel: "agent", proposalId: "proposal-1" } },
        ),
      ).rejects.toBeInstanceOf(ConflictError);

      // 7. GENERATED 幂等快路径：intent 已完成，返回已有合同（不重新生成）
      const existingContract = await prisma.contractDocument.create({
        data: {
          contractNo: "HT-T82B-EXISTING",
          templateId: template.id,
          sellerName: "卖方",
          buyerName: "买方",
          buyerOrgName: "买方单位",
          totalAmount: 100_000,
          status: "GENERATED",
          generationIntentId: draft.generationIntentId,
          createdById: admin.id,
        },
      });
      await prisma.orderContractCoverage.create({
        data: { contractId: existingContract.id, orderId: order.id },
      });
      await prisma.contractGenerationIntent.update({
        where: { id: draft.generationIntentId },
        data: { status: "GENERATED", activeDigestKey: null, processingProposalId: null },
      });

      const result = await generateContractForActor(
        adminActor,
        {
          generationIntentId: draft.generationIntentId,
          orderIds: [order.id],
          templateId: template.id,
          sellerProfileId: seller.id,
        },
        { invocation: { channel: "agent", proposalId: "proposal-1" } },
      );
      expect(result.contractId).toBe(existingContract.id);
      expect(result.contractNo).toBe("HT-T82B-EXISTING");
      expect(result.docxBuffer).toBeNull(); // 幂等快路径不返回 buffer
      expect(result.coveredOrderCount).toBe(1);
      expect(result.totalAmountCents).toBe(100_000);
    });
  }, 120_000);
});

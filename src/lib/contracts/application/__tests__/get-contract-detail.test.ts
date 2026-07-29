import { describe, expect, it } from "vitest";
import { withTempSmokeDb } from "../../../../../scripts/lib/temp-smoke-db";

/**
 * T8.1b: canonical actor-aware contract detail shared by GET /api/contracts/[id]
 * and Agent contracts.get_detail.
 * - 全覆盖 scope fail-closed：partial/none → NotFoundError（403→404 统一口径，
 *   不以 Forbidden 泄露存在性）；
 * - 零覆盖合同空真可见（C9）；
 * - Web 记录逐字节保持（template 全字段、全部 source 附件）；Agent shape 稳定。
 */
describe("T8.1b getContractDetailForActor", () => {
  it("requires full coverage scope (fail-closed), shows zero-coverage contracts, keeps DTO shapes", async () => {
    await withTempSmokeDb(async () => {
      const { prisma } = await import("@/lib/prisma");
      const {
        getContractDetailForActor,
        shapeContractDetailForAgent,
      } = await import("@/lib/contracts/application/get-contract-detail");
      const { NotFoundError } = await import("@/lib/application/errors");

      const admin = await prisma.user.create({
        data: { email: "t81b-d-admin@example.com", name: "Admin", password: "h", role: "ADMIN" },
      });
      const repAUser = await prisma.user.create({
        data: { email: "t81b-d-repa@example.com", name: "RepA", password: "h", role: "REPRESENTATIVE" },
      });
      const repBUser = await prisma.user.create({
        data: { email: "t81b-d-repb@example.com", name: "RepB", password: "h", role: "REPRESENTATIVE" },
      });
      await prisma.representative.create({ data: { name: "代表A", email: repAUser.email } });
      await prisma.representative.create({ data: { name: "代表B", email: repBUser.email } });

      const profileA = await prisma.crmCustomerProfile.create({
        data: { name: "详情客户A", ownerUserId: repAUser.id, assignmentStatus: "ASSIGNED" },
      });
      const profileB = await prisma.crmCustomerProfile.create({
        data: { name: "详情客户B", ownerUserId: repBUser.id, assignmentStatus: "ASSIGNED" },
      });
      // 部门隔离 Phase 4：可见性以部门 CLAIMED state 为准；raw fixture 需回填 state
      // （ASSIGNED+owner → FIELD_SALES CLAIMED，可见范围与旧语义等价）。
      const { backfillDepartmentStates } = await import("../../../../../scripts/lib/department-states");
      await backfillDepartmentStates(prisma, { apply: true });

      const orderA1 = await prisma.order.create({
        data: {
          orderNo: "T81BD-A1",
          source: "MANUAL",
          profileId: profileA.id,
          title: "T81BD-A1",
          createdById: admin.id,
          totalAmount: 100_000,
          status: "CONFIRMED",
        },
      });
      const orderB1 = await prisma.order.create({
        data: {
          orderNo: "T81BD-B1",
          source: "MANUAL",
          profileId: profileB.id,
          title: "T81BD-B1",
          createdById: admin.id,
          totalAmount: 100_000,
          status: "CONFIRMED",
        },
      });

      const template = await prisma.contractTemplate.create({
        data: {
          name: "测序合同",
          category: "SEQUENCING",
          fileUrl: "/uploads/contract-templates/t81bd/template.docx",
          fileName: "seq.docx",
          detectedVariables: JSON.stringify(["sellerName"]),
          createdById: admin.id,
        },
      });

      const contractMixed = await prisma.contractDocument.create({
        data: {
          contractNo: "HT-T81BD-MIXED",
          templateId: template.id,
          sellerName: "卖方",
          sellerTaxId: "91330000XXX",
          buyerName: "买方",
          buyerOrgName: "买方单位",
          totalAmount: 200_000,
          status: "GENERATED",
          createdById: admin.id,
        },
      });
      const contractZero = await prisma.contractDocument.create({
        data: {
          contractNo: "HT-T81BD-ZERO",
          templateId: template.id,
          sellerName: "卖方",
          buyerName: "买方",
          buyerOrgName: "买方单位",
          totalAmount: 0,
          status: "GENERATED",
          createdById: admin.id,
        },
      });
      const contractPending = await prisma.contractDocument.create({
        data: {
          contractNo: "HT-T81BD-PENDING",
          templateId: template.id,
          sellerName: "卖方",
          buyerName: "买方",
          buyerOrgName: "买方单位",
          totalAmount: 100_000,
          status: "PENDING_FILE",
          createdById: admin.id,
        },
      });

      await prisma.orderContractCoverage.create({ data: { contractId: contractMixed.id, orderId: orderA1.id } });
      await prisma.orderContractCoverage.create({ data: { contractId: contractMixed.id, orderId: orderB1.id } });
      await prisma.orderContractCoverage.create({ data: { contractId: contractPending.id, orderId: orderA1.id } });
      await prisma.contractAttachment.create({
        data: {
          contractDocumentId: contractMixed.id,
          fileName: "contract.docx",
          fileUrl: "/uploads/contracts/t81bd/contract.docx",
          source: "GENERATED",
        },
      });

      const repAActor = { userId: repAUser.id, role: "REPRESENTATIVE", name: "RepA", email: repAUser.email };
      const repBActor = { userId: repBUser.id, role: "REPRESENTATIVE", name: "RepB", email: repBUser.email };
      const adminActor = { userId: admin.id, role: "ADMIN", name: "Admin", email: admin.email };

      // 不存在 → NotFound
      await expect(getContractDetailForActor(adminActor, "missing-contract")).rejects.toBeInstanceOf(
        NotFoundError,
      );

      // partial scope fail-closed：repA/repB 各只见 mixed 的一半 → 均 NotFound（不泄露存在性）
      await expect(getContractDetailForActor(repAActor, contractMixed.id)).rejects.toBeInstanceOf(
        NotFoundError,
      );
      await expect(getContractDetailForActor(repBActor, contractMixed.id)).rejects.toBeInstanceOf(
        NotFoundError,
      );

      // ADMIN 全覆盖 → 可读；Web 记录保持全量 include（template 全字段 + 全 source 附件）
      const adminDetail = await getContractDetailForActor(adminActor, contractMixed.id);
      expect(adminDetail.contractNo).toBe("HT-T81BD-MIXED");
      expect(adminDetail.template?.id).toBe(template.id);
      expect(adminDetail.template?.detectedVariables).toBe(JSON.stringify(["sellerName"]));
      expect(adminDetail.createdBy).toEqual({ id: admin.id, name: "Admin" });
      expect(adminDetail.orderCoverage.map((c) => c.orderId).sort()).toEqual(
        [orderA1.id, orderB1.id].sort(),
      );
      expect(adminDetail.orderCoverage[0]?.order.orderNo).toBeTruthy();
      expect(adminDetail.attachments).toHaveLength(1);
      expect(adminDetail.attachments[0]).toHaveProperty("mimeType");
      expect(adminDetail.attachments[0]).toHaveProperty("source", "GENERATED");

      // 零覆盖合同 fail-closed（P1：非 ADMIN -> NotFound；ADMIN 可读）
      await expect(getContractDetailForActor(repAActor, contractZero.id)).rejects.toBeInstanceOf(
        NotFoundError,
      );
      const zeroForAdmin = await getContractDetailForActor(adminActor, contractZero.id);
      expect(zeroForAdmin.contractNo).toBe("HT-T81BD-ZERO");

      // PENDING_FILE 详情仍可读（下载侧的 409 由 T8.4 download route 负责）
      const pendingDetail = await getContractDetailForActor(repAActor, contractPending.id);
      expect(pendingDetail.status).toBe("PENDING_FILE");

      // Agent shape：稳定键集合；downloadUrl 仅 GENERATED 非空
      const shaped = shapeContractDetailForAgent(adminDetail);
      expect(Object.keys(shaped).sort()).toEqual(
        [
          "contractNo",
          "status",
          "category",
          "totalAmountCents",
          "seller",
          "buyer",
          "coveredOrders",
          "downloadUrl",
          "createdAt",
          "creatorName",
        ].sort(),
      );
      expect(shaped.seller).toEqual({
        name: "卖方",
        taxId: "91330000XXX",
        bankName: "",
        bankAccount: "",
        address: "",
        phone: "",
        legalRepresentative: "",
      });
      expect(shaped.buyer.buyerOrgName).toBe("买方单位");
      expect(shaped.downloadUrl).toBe(`/api/contracts/${contractMixed.id}/download`);
      expect(shaped.category).toBe("SEQUENCING");
      expect(shaped.creatorName).toBe("Admin");

      const shapedPending = shapeContractDetailForAgent(pendingDetail);
      expect(shapedPending.downloadUrl).toBeNull();
    });
  }, 120_000);
});

import { describe, expect, it } from "vitest";
import { withTempSmokeDb } from "../../../../../scripts/lib/temp-smoke-db";

/**
 * T8.1b: canonical actor-aware contract list query shared by GET /api/contracts
 * and Agent contracts.list.
 * - 跨 scope 合同（覆盖订单一内一外）对 scoped 角色列表不可见、零泄露；
 * - PENDING_FILE 隐藏，DELIVERY_NOTE 保留；total 为过滤后真实总数；
 * - ADMIN 全量 + DB 分页；无订单访问权角色 → ForbiddenError。
 */
describe("T8.1b queryContractsForActor", () => {
  it("filters by full-coverage scope with exact post-filter total and hides nothing out of scope", async () => {
    await withTempSmokeDb(async () => {
      const { prisma } = await import("@/lib/prisma");
      const {
        queryContractsForActor,
        shapeContractListForAgent,
        classifyContractOrderGateForActor,
      } = await import("@/lib/contracts/application/query-contracts");
      const { ForbiddenError } = await import("@/lib/application/errors");

      const admin = await prisma.user.create({
        data: { email: "t81b-admin@example.com", name: "Admin", password: "h", role: "ADMIN" },
      });
      const repAUser = await prisma.user.create({
        data: { email: "t81b-repa@example.com", name: "RepA", password: "h", role: "REPRESENTATIVE" },
      });
      const blockedUser = await prisma.user.create({
        data: { email: "t81b-portal@example.com", name: "Portal", password: "h", role: "PORTAL" },
      });
      await prisma.representative.create({ data: { name: "代表A", email: repAUser.email } });

      const profileA = await prisma.crmCustomerProfile.create({
        data: { name: "列表客户A", ownerUserId: repAUser.id, assignmentStatus: "ASSIGNED" },
      });
      const profileB = await prisma.crmCustomerProfile.create({
        data: { name: "列表客户B", ownerUserId: admin.id, assignmentStatus: "ASSIGNED" },
      });

      // 部门隔离 Phase 4：可见性以部门 CLAIMED state 为准；raw fixture 需回填 state
      // （ASSIGNED+owner → FIELD_SALES CLAIMED，可见范围与旧语义等价）。
      const { backfillDepartmentStates } = await import("../../../../../scripts/lib/department-states");
      await backfillDepartmentStates(prisma, { apply: true });

      const mkOrder = (orderNo: string, profileId: string) =>
        prisma.order.create({
          data: {
            orderNo,
            source: "MANUAL",
            profileId,
            title: orderNo,
            createdById: admin.id,
            totalAmount: 100_000,
            status: "CONFIRMED",
            buyerOrgNameSnapshot: `${orderNo}-单位`,
          },
        });
      const orderA1 = await mkOrder("T81B-A1", profileA.id);
      const orderA2 = await mkOrder("T81B-A2", profileA.id);
      const orderB1 = await mkOrder("T81B-B1", profileB.id);

      const tplSeq = await prisma.contractTemplate.create({
        data: {
          name: "测序合同",
          category: "SEQUENCING",
          fileUrl: "/uploads/contract-templates/t81b-seq/template.docx",
          fileName: "seq.docx",
          createdById: admin.id,
        },
      });
      const tplDelivery = await prisma.contractTemplate.create({
        data: {
          name: "出库单",
          category: "DELIVERY_NOTE",
          fileUrl: "/uploads/contract-templates/t81b-delivery/template.docx",
          fileName: "delivery.docx",
          createdById: admin.id,
        },
      });

      const mkContract = (
        contractNo: string,
        templateId: string,
        status: string,
        createdAt: string,
      ) =>
        prisma.contractDocument.create({
          data: {
            contractNo,
            templateId,
            sellerName: "卖方",
            buyerName: "买方",
            buyerOrgName: "买方单位",
            totalAmount: 100_000,
            status,
            createdById: admin.id,
            createdAt: new Date(createdAt),
          },
        });

      // 全部覆盖在 repA scope 内（三份，用于分页）
      const full1 = await mkContract("HT-T81B-F1", tplSeq.id, "GENERATED", "2026-03-03");
      const full2 = await mkContract("HT-T81B-F2", tplSeq.id, "GENERATED", "2026-03-02");
      const full3 = await mkContract("HT-T81B-F3", tplSeq.id, "GENERATED", "2026-03-01");
      // 跨 scope：A2（repA 可见）+ B1（repA 不可见）→ repA 列表/详情均不可见
      const mixed = await mkContract("HT-T81B-MIXED", tplSeq.id, "GENERATED", "2026-03-04");
      // PENDING_FILE：任何列表都不展示
      const pending = await mkContract("HT-T81B-PENDING", tplSeq.id, "PENDING_FILE", "2026-03-05");
      // DELIVERY_NOTE：列表保留（与 hasContract 口径不同）
      const delivery = await mkContract("HT-T81B-DELIVERY", tplDelivery.id, "GENERATED", "2026-02-28");

      await prisma.orderContractCoverage.create({ data: { contractId: full1.id, orderId: orderA1.id } });
      await prisma.orderContractCoverage.create({ data: { contractId: full2.id, orderId: orderA1.id } });
      await prisma.orderContractCoverage.create({ data: { contractId: full3.id, orderId: orderA2.id } });
      await prisma.orderContractCoverage.create({ data: { contractId: mixed.id, orderId: orderA2.id } });
      await prisma.orderContractCoverage.create({ data: { contractId: mixed.id, orderId: orderB1.id } });
      await prisma.orderContractCoverage.create({ data: { contractId: pending.id, orderId: orderA1.id } });
      await prisma.orderContractCoverage.create({ data: { contractId: delivery.id, orderId: orderA1.id } });

      const repAActor = { userId: repAUser.id, role: "REPRESENTATIVE", name: "RepA", email: repAUser.email };
      const adminActor = { userId: admin.id, role: "ADMIN", name: "Admin", email: admin.email };
      const blockedActor = { userId: blockedUser.id, role: "PORTAL" };

      // 无订单访问权角色 → Forbidden
      await expect(queryContractsForActor(blockedActor, {})).rejects.toBeInstanceOf(ForbiddenError);

      // repA：跨 scope 合同与 PENDING_FILE 不可见；DELIVERY_NOTE 保留；total 为过滤后真实总数
      const page1 = await queryContractsForActor(repAActor, { page: 1, pageSize: 2 });
      expect(page1.total).toBe(4); // F1 F2 F3 DELIVERY（mixed/pending 排除）
      expect(page1.contracts.map((c) => c.contractNo)).toEqual(["HT-T81B-F1", "HT-T81B-F2"]);
      const serialized = JSON.stringify(page1);
      expect(serialized).not.toContain("HT-T81B-MIXED");
      expect(serialized).not.toContain(mixed.id);
      expect(serialized).not.toContain(orderB1.id);
      expect(serialized).not.toContain("T81B-B1");
      expect(serialized).not.toContain("HT-T81B-PENDING");

      const page2 = await queryContractsForActor(repAActor, { page: 2, pageSize: 2 });
      expect(page2.total).toBe(4);
      expect(page2.contracts.map((c) => c.contractNo)).toEqual(["HT-T81B-F3", "HT-T81B-DELIVERY"]);

      // 过滤条件：orderId / category / status
      const byOrder = await queryContractsForActor(repAActor, { orderId: orderA1.id });
      expect(byOrder.contracts.map((c) => c.contractNo).sort()).toEqual(
        ["HT-T81B-DELIVERY", "HT-T81B-F1", "HT-T81B-F2"].sort(),
      );
      const byCategory = await queryContractsForActor(repAActor, { category: "DELIVERY_NOTE" });
      expect(byCategory.contracts.map((c) => c.contractNo)).toEqual(["HT-T81B-DELIVERY"]);
      const byStatus = await queryContractsForActor(adminActor, { status: "PENDING_FILE" });
      // status 过滤与 not PENDING_FILE 基础条件叠加 → 空（语义保持：AND 冲突）
      expect(byStatus.total).toBe(0);

      // ADMIN：全量（含 mixed 跨 scope 合同；PENDING_FILE 同样排除），DB 分页
      const adminPage = await queryContractsForActor(adminActor, { page: 1, pageSize: 50 });
      expect(adminPage.total).toBe(5); // F1 F2 F3 mixed delivery（pending 排除）
      expect(adminPage.contracts.map((c) => c.contractNo)).toContain("HT-T81B-MIXED");
      expect(adminPage.contracts.map((c) => c.contractNo)).not.toContain("HT-T81B-PENDING");
      expect(adminPage.pageSize).toBe(50);

      // pageSize clamp 与非法值回退
      const clamped = await queryContractsForActor(repAActor, { pageSize: 500 });
      expect(clamped.pageSize).toBe(50);
      const defaulted = await queryContractsForActor(repAActor, {
        page: Number.NaN,
        pageSize: Number.NaN,
      });
      expect(defaulted.page).toBe(1);
      expect(defaulted.pageSize).toBe(20);

      // orderId 入口门：历史空 envelope 分类
      expect(await classifyContractOrderGateForActor(repAActor, orderA1.id)).toBe("pass");
      expect(await classifyContractOrderGateForActor(repAActor, orderB1.id)).toBe("empty");
      expect(await classifyContractOrderGateForActor(adminActor, orderB1.id)).toBe("pass");
      expect(await classifyContractOrderGateForActor(adminActor, "missing-order")).toBe("empty");

      // Agent shape：稳定 8 键，category 来自 template
      const shaped = shapeContractListForAgent(page1.contracts[0]!);
      expect(Object.keys(shaped).sort()).toEqual(
        [
          "id",
          "contractNo",
          "status",
          "category",
          "totalAmountCents",
          "buyerOrgName",
          "createdAt",
          "coveredOrderCount",
        ].sort(),
      );
      expect(shaped.category).toBe("SEQUENCING");
      expect(shaped.totalAmountCents).toBe(100_000);
      expect(shaped.coveredOrderCount).toBe(1);
      expect(typeof shaped.createdAt).toBe("string");

      // Web envelope 去 template 键后仍含历史字段
      const webRow: Record<string, unknown> = { ...page1.contracts[0]! };
      delete webRow.template;
      expect(webRow).not.toHaveProperty("template");
      expect(webRow).toHaveProperty("contractNo");
      expect(webRow).toHaveProperty("createdBy");
      expect(webRow).toHaveProperty("orderCoverage");
      expect(webRow).toHaveProperty("attachments");
    });
  }, 120_000);
});

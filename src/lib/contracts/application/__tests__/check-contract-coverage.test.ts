import { describe, expect, it } from "vitest";
import { withTempSmokeDb } from "../../../../../scripts/lib/temp-smoke-db";

/**
 * T8.1a: canonical actor-aware coverage check shared by Agent contracts.check_coverage.
 * - 只返回调用者订单 scope 内的订单，scope 外订单零泄露（ID/编号/金额/状态）；
 * - §2.5.1 hasContract 口径：排除 PENDING_FILE 与 DELIVERY_NOTE，有一份有效合同即已覆盖；
 * - uncoveredCount/totalCount 在 uncoveredOnly 过滤前计算。
 */
describe("T8.1a checkContractCoverageForActor", () => {
  it("scopes to visible orders, applies the §2.5.1 hasContract predicate, and never leaks out-of-scope data", async () => {
    await withTempSmokeDb(async () => {
      const { prisma } = await import("@/lib/prisma");
      const {
        checkContractCoverageForActor,
        isValidCoverageContract,
        loadValidCoverageByOrderId,
      } = await import("@/lib/contracts/application/check-contract-coverage");
      const {
        classifyContractCoverageScope,
        isContractFullyVisible,
      } = await import("@/lib/contracts/application/contract-order-scope");
      const { ForbiddenError } = await import("@/lib/application/errors");

      const admin = await prisma.user.create({
        data: { email: "t81a-admin@example.com", name: "Admin", password: "h", role: "ADMIN" },
      });
      const repAUser = await prisma.user.create({
        data: { email: "t81a-repa@example.com", name: "RepA", password: "h", role: "REPRESENTATIVE" },
      });
      const repBUser = await prisma.user.create({
        data: { email: "t81a-repb@example.com", name: "RepB", password: "h", role: "REPRESENTATIVE" },
      });
      const blockedUser = await prisma.user.create({
        data: { email: "t81a-portal@example.com", name: "Portal", password: "h", role: "PORTAL" },
      });

      await prisma.representative.create({ data: { name: "代表A", email: repAUser.email } });
      await prisma.representative.create({ data: { name: "代表B", email: repBUser.email } });

      const profileA = await prisma.crmCustomerProfile.create({
        data: { name: "覆盖客户A", ownerUserId: repAUser.id, assignmentStatus: "ASSIGNED" },
      });
      const profileB = await prisma.crmCustomerProfile.create({
        data: { name: "覆盖客户B", ownerUserId: repBUser.id, assignmentStatus: "ASSIGNED" },
      });
      // 部门隔离 Phase 4：可见性以部门 CLAIMED state 为准；raw fixture 需回填 state
      // （ASSIGNED+owner → FIELD_SALES CLAIMED，可见范围与旧语义等价）。
      const { backfillDepartmentStates } = await import("../../../../../scripts/lib/department-states");
      await backfillDepartmentStates(prisma, { apply: true });

      const mkOrder = (orderNo: string, profileId: string, totalAmount: number, orderedAt: string) =>
        prisma.order.create({
          data: {
            orderNo,
            source: "MANUAL",
            profileId,
            title: orderNo,
            createdById: admin.id,
            totalAmount,
            status: "CONFIRMED",
            orderedAt: new Date(orderedAt),
            buyerNameSnapshot: `${orderNo}-买方`,
            buyerOrgNameSnapshot: `${orderNo}-单位`,
          },
        });

      const orderA1 = await mkOrder("T81A-A1", profileA.id, 100_000, "2026-03-03");
      const orderA2 = await mkOrder("T81A-A2", profileA.id, 200_000, "2026-03-02");
      const orderA3 = await mkOrder("T81A-A3", profileA.id, 300_000, "2026-03-01");
      const orderB1 = await mkOrder("T81A-B1", profileB.id, 999_000, "2026-03-04");
      // 无 profile 订单（仅 ADMIN 可见）：验证 customerName 快照回退链
      const orderA5 = await prisma.order.create({
        data: {
          orderNo: "T81A-A5",
          source: "MANUAL",
          title: "T81A-A5",
          createdById: admin.id,
          totalAmount: 50_000,
          status: "CONFIRMED",
          orderedAt: new Date("2026-02-15"),
          buyerNameSnapshot: "手工买方",
          buyerOrgNameSnapshot: "手工单位",
        },
      });
      const orderA6 = await prisma.order.create({
        data: {
          orderNo: "T81A-A6",
          source: "MANUAL",
          title: "T81A-A6",
          createdById: admin.id,
          totalAmount: 60_000,
          status: "CONFIRMED",
          orderedAt: new Date("2026-02-14"),
        },
      });

      const tplSeq = await prisma.contractTemplate.create({
        data: {
          name: "测序合同模板",
          category: "SEQUENCING",
          fileUrl: "/uploads/contract-templates/t81a-seq/template.docx",
          fileName: "seq.docx",
          createdById: admin.id,
        },
      });
      const tplDelivery = await prisma.contractTemplate.create({
        data: {
          name: "出库单模板",
          category: "DELIVERY_NOTE",
          fileUrl: "/uploads/contract-templates/t81a-delivery/template.docx",
          fileName: "delivery.docx",
          createdById: admin.id,
        },
      });

      const mkContract = (contractNo: string, templateId: string, status: string) =>
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
          },
        });

      // orderA1: GENERATED + PENDING_FILE → hasContract=true，合同列表只含 GENERATED
      const contractGen = await mkContract("HT-T81A-GEN", tplSeq.id, "GENERATED");
      const contractPending = await mkContract("HT-T81A-PENDING", tplSeq.id, "PENDING_FILE");
      // orderA2: 仅 DELIVERY_NOTE → hasContract=false
      const contractDelivery = await mkContract("HT-T81A-DELIVERY", tplDelivery.id, "GENERATED");
      // orderA3: 无任何覆盖 → hasContract=false
      // orderB1: 有覆盖但不在 repA scope 内
      const contractB = await mkContract("HT-T81A-B", tplSeq.id, "GENERATED");

      await prisma.orderContractCoverage.create({ data: { contractId: contractGen.id, orderId: orderA1.id } });
      await prisma.orderContractCoverage.create({ data: { contractId: contractPending.id, orderId: orderA1.id } });
      await prisma.orderContractCoverage.create({ data: { contractId: contractDelivery.id, orderId: orderA2.id } });
      await prisma.orderContractCoverage.create({ data: { contractId: contractB.id, orderId: orderB1.id } });

      const repAActor = { userId: repAUser.id, role: "REPRESENTATIVE", name: "RepA", email: repAUser.email };
      const adminActor = { userId: admin.id, role: "ADMIN", name: "Admin", email: admin.email };
      const blockedActor = { userId: blockedUser.id, role: "PORTAL" };

      // 无订单访问权的角色 → Forbidden
      await expect(
        checkContractCoverageForActor(blockedActor, {}),
      ).rejects.toBeInstanceOf(ForbiddenError);

      // repA：只见 profileA 的订单；scope 外订单零泄露；排序 [orderedAt desc, createdAt desc]
      const repAResult = await checkContractCoverageForActor(repAActor, {});
      expect(repAResult.totalCount).toBe(3);
      expect(repAResult.uncoveredCount).toBe(2); // A2（仅 DELIVERY_NOTE）+ A3（无覆盖）
      expect(repAResult.orders.map((o) => o.orderId)).toEqual([
        orderA1.id, // 2026-03-03
        orderA2.id, // 2026-03-02
        orderA3.id, // 2026-03-01
      ]);
      const serialized = JSON.stringify(repAResult);
      expect(serialized).not.toContain(orderB1.id);
      expect(serialized).not.toContain("T81A-B1");
      expect(serialized).not.toContain("999000");
      expect(serialized).not.toContain(contractB.contractNo);

      // §2.5.1 口径：PENDING_FILE 排除、DELIVERY_NOTE 排除、GENERATED 计入
      const a1 = repAResult.orders.find((o) => o.orderId === orderA1.id)!;
      expect(a1.hasContract).toBe(true);
      expect(a1.contracts).toHaveLength(1);
      expect(a1.contracts[0]?.contractId).toBe(contractGen.id);
      expect(a1.contracts[0]?.contractNo).toBe("HT-T81A-GEN");
      expect(a1.customerName).toBe("覆盖客户A");
      expect(a1.totalAmountCents).toBe(100_000);

      const a2 = repAResult.orders.find((o) => o.orderId === orderA2.id)!;
      expect(a2.hasContract).toBe(false);
      expect(a2.contracts).toEqual([]);
      expect(a2.customerName).toBe("覆盖客户A");

      const a3 = repAResult.orders.find((o) => o.orderId === orderA3.id)!;
      expect(a3.hasContract).toBe(false);

      // uncoveredOnly：列表过滤但计数口径不变
      const uncoveredOnly = await checkContractCoverageForActor(repAActor, { uncoveredOnly: true });
      expect(uncoveredOnly.orders.map((o) => o.orderId).sort()).toEqual([orderA2.id, orderA3.id].sort());
      expect(uncoveredOnly.totalCount).toBe(3);
      expect(uncoveredOnly.uncoveredCount).toBe(2);

      // orderIds 过滤与 scope 取交集：请求 A1+B1 只返回 A1
      const filtered = await checkContractCoverageForActor(repAActor, {
        orderIds: [orderA1.id, orderB1.id],
      });
      expect(filtered.orders.map((o) => o.orderId)).toEqual([orderA1.id]);
      expect(JSON.stringify(filtered)).not.toContain(orderB1.id);

      // customerId 过滤
      const byCustomer = await checkContractCoverageForActor(adminActor, { customerId: profileB.id });
      expect(byCustomer.orders.map((o) => o.orderId)).toEqual([orderB1.id]);

      // dateRange 过滤（orderedAt：A1=03-03, A2=03-02 命中；A3=03-01, B1=03-04 不命中）
      const byDate = await checkContractCoverageForActor(adminActor, {
        dateRange: { from: "2026-03-02", to: "2026-03-03" },
      });
      expect(byDate.orders.map((o) => o.orderId).sort()).toEqual([orderA1.id, orderA2.id].sort());

      // ADMIN 无 scope：全量可见（含无 profile 订单）
      const adminResult = await checkContractCoverageForActor(adminActor, {});
      expect(adminResult.totalCount).toBe(6);
      expect(adminResult.uncoveredCount).toBe(4); // A2（交货单排除）+ A3 + A5 + A6

      // customerName 回退链：profile.name → buyerOrgNameSnapshot → buyerNameSnapshot → null
      const a5 = adminResult.orders.find((o) => o.orderId === orderA5.id)!;
      expect(a5.customerName).toBe("手工单位"); // 无 profile → 机构快照
      const a6 = adminResult.orders.find((o) => o.orderId === orderA6.id)!;
      expect(a6.customerName).toBeNull(); // 三个来源全空 → null

      // 纯函数：分类与列表可见性谓词
      expect(classifyContractCoverageScope([], null)).toBe("none");
      expect(classifyContractCoverageScope(["x"], null)).toBe("full");
      const scopeSet = new Set(["a", "b"]);
      expect(classifyContractCoverageScope(["a", "b"], scopeSet)).toBe("full");
      expect(classifyContractCoverageScope(["a", "c"], scopeSet)).toBe("partial");
      expect(classifyContractCoverageScope(["c"], scopeSet)).toBe("none");
      expect(classifyContractCoverageScope(["c"], new Set(["__NO_MATCH__"]))).toBe("none");
      expect(isContractFullyVisible([], scopeSet)).toBe(false); // 列表口径：空覆盖不可见
      expect(isContractFullyVisible([{ orderId: "a" }], scopeSet)).toBe(true);
      expect(isContractFullyVisible([{ orderId: "a" }, { orderId: "c" }], scopeSet)).toBe(false);
      expect(isContractFullyVisible([], null)).toBe(true); // ADMIN：无订单级过滤

      // hasContract 谓词：模板已删除（category=null）仍计入
      expect(isValidCoverageContract({ status: "GENERATED", templateCategory: null })).toBe(true);
      expect(isValidCoverageContract({ status: "GENERATED", templateCategory: "DELIVERY_NOTE" })).toBe(false);
      expect(isValidCoverageContract({ status: "PENDING_FILE", templateCategory: "SEQUENCING" })).toBe(false);

      // 共享 loader：prepare 阶段重复覆盖提示同源
      const coverageMap = await loadValidCoverageByOrderId([orderA1.id, orderA2.id, orderA3.id]);
      expect(coverageMap.get(orderA1.id)?.map((c) => c.contractNo)).toEqual(["HT-T81A-GEN"]);
      expect(coverageMap.get(orderA2.id)).toBeUndefined();
      expect(coverageMap.get(orderA3.id)).toBeUndefined();
    });
  }, 120_000);
});

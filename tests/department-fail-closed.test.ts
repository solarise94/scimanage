/**
 * 部门解析 fail-closed 回归测试（缺陷 7）。
 *
 * 验证：用户不存在或 department 字段非法时——
 *   - 读路径 scope 返回空集（no-match），不静默降级为 FIELD_SALES；
 *   - 写路径拒绝并抛 typed error；
 *   - 正常 FIELD_SALES / ONLINE_OPS / ADMIN 行为不回退。
 *
 * 全部在 withTempSmokeDb 临时 SQLite 中执行（schema 模板 + COW 克隆），
 * 严禁触碰真实库。
 *
 * 注：Prisma 单例在同进程内不能跨多次 temp db 重建，故全部断言放在单次
 * withTempSmokeDb 回调中（与 tests/supply-chain-department-scope.test.ts 同惯例）。
 */
import { describe, expect, it } from "vitest";
import { withTempSmokeDb } from "../scripts/lib/temp-smoke-db";

describe("部门解析 fail-closed（缺陷 7）", () => {
  it("用户不存在/部门非法：读 scope 返回空集；写路径拒绝；正常行为不回退", async () => {
    await withTempSmokeDb(async () => {
      const { prisma } = await import("@/lib/prisma");
      const {
        getInquiryScopeWhere,
        getCostEntryScopeWhere,
        getSupplyExecutionScopeWhere,
      } = await import("@/lib/supply-chain/permissions");
      const { getSupplierPaymentScopeWhere } = await import(
        "@/lib/finance/supplier-permissions"
      );
      const { getFinanceProfileScopeWhere } = await import("@/lib/finance/permissions");
      const { getOrderScopeWhere } = await import("@/lib/orders/permissions");
      const { createManualCostEntry } = await import("@/lib/costing/entries");
      const { registerSupplierPayment, PaymentError } = await import(
        "@/lib/finance/supplier-payments"
      );
      const { getActorDepartment } = await import("@/lib/department");

      // ── 种子 ──
      const uFs = await prisma.user.create({
        data: { email: "fs@t.test", name: "FS", password: "x", role: "ADMIN", department: "FIELD_SALES" },
      });
      const uFsUser = await prisma.user.create({
        data: { email: "fsu@t.test", name: "FSU", password: "x", role: "USER", department: "FIELD_SALES" },
      });
      const uOps = await prisma.user.create({
        data: { email: "ops@t.test", name: "OPS", password: "x", role: "USER", department: "ONLINE_OPS" },
      });
      const uBadDept = await prisma.user.create({
        data: { email: "bad@t.test", name: "BAD", password: "x", role: "USER", department: "GARBAGE" },
      });
      const ghostUserId = "non-existent-user-id";

      const supplier = await prisma.supplier.create({
        data: { name: "S", normalizedName: "s" },
      });
      const profile = await prisma.crmCustomerProfile.create({
        data: { name: "P", assignmentStatus: "ASSIGNED", ownerUserId: uFs.id },
      });

      // 建一些 FIELD_SALES 执行记录，验证 bad/ghost 用户看不到（而非被当成 FS 看到）
      const inquiryFs = await prisma.supplierInquiry.create({
        data: {
          supplierId: supplier.id,
          orderId: null,
          departmentSnapshot: "FIELD_SALES",
          requestedItem: "FS 询价",
          createdById: uFs.id,
        },
      });

      // ── 1. 读路径：用户不存在/部门非法 → no-match，不降级 FIELD_SALES ──

      // 1a. 部门非法用户：getInquiryScopeWhere 必须返回 no-match，看不到 FS 询价
      const scopeBad = await getInquiryScopeWhere(uBadDept.id, "USER");
      expect(isNoMatchScope(scopeBad)).toBe(true);
      const visibleBad = await prisma.supplierInquiry.findMany({ where: (scopeBad ?? {}) as never });
      expect(visibleBad.map((i) => i.id)).not.toContain(inquiryFs.id);
      expect(visibleBad).toHaveLength(0);

      // 1b. 不存在用户：同样 no-match
      const scopeGhost = await getInquiryScopeWhere(ghostUserId, "USER");
      expect(isNoMatchScope(scopeGhost)).toBe(true);

      // 1c. 显式传入非法部门值：也 no-match（不静默接受 "GARBAGE"）
      const scopeBadArg = await getInquiryScopeWhere(uFsUser.id, "USER", "GARBAGE");
      expect(isNoMatchScope(scopeBadArg)).toBe(true);

      // getCostEntryScopeWhere：同样 fail-closed
      expect(isNoMatchScope(await getCostEntryScopeWhere(uBadDept.id, "USER"))).toBe(true);
      expect(isNoMatchScope(await getCostEntryScopeWhere(ghostUserId, "USER"))).toBe(true);

      // getSupplierPaymentScopeWhere：同样 fail-closed
      expect(isNoMatchScope(await getSupplierPaymentScopeWhere(uBadDept.id, "USER"))).toBe(true);
      expect(isNoMatchScope(await getSupplierPaymentScopeWhere(ghostUserId, "USER"))).toBe(true);

      // getFinanceProfileScopeWhere：同样 fail-closed
      expect(isNoMatchScope(await getFinanceProfileScopeWhere(uBadDept.id, "USER"))).toBe(true);

      // getOrderScopeWhere：部门非法时返回带 __NO_MATCH__ 的 where，count 为 0
      const ordScopeBad = await getOrderScopeWhere(uBadDept.id, "USER");
      expect(JSON.stringify(ordScopeBad)).toContain("__NO_MATCH__");
      expect(await prisma.order.count({ where: ordScopeBad as never })).toBe(0);

      // getSupplyExecutionScopeWhere 走 Order scope 继承，部门非法时也空
      const execScopeBad = await getSupplyExecutionScopeWhere(uBadDept.id, "USER");
      const visiblePlansBad = await prisma.supplyPlan.findMany({ where: execScopeBad as never });
      expect(visiblePlansBad).toHaveLength(0);

      // ── 2. 写路径：用户不存在/部门非法 → 拒绝，不落 FIELD_SALES 快照 ──

      // createManualCostEntry：actor 部门非法 → 拒绝（CUSTOMER/MANUAL 取 actor 部门）
      await expect(
        createManualCostEntry({
          subjectType: "CUSTOMER",
          profileId: profile.id,
          bucket: "REAL",
          costType: "SUPPLIER",
          amount: 1000,
          actorUserId: uBadDept.id,
        }),
      ).rejects.toThrow(/部门/);

      // createManualCostEntry：actor 不存在 → 拒绝
      await expect(
        createManualCostEntry({
          subjectType: "CUSTOMER",
          profileId: profile.id,
          bucket: "REAL",
          costType: "SUPPLIER",
          amount: 1000,
          actorUserId: ghostUserId,
        }),
      ).rejects.toThrow(/部门/);

      // registerSupplierPayment：actor 部门非法 → PaymentError DEPARTMENT_UNRESOLVED
      await expect(
        registerSupplierPayment({
          supplierId: supplier.id,
          amount: 1000,
          allocations: [],
          actorUserId: uBadDept.id,
        }),
      ).rejects.toMatchObject({ code: "DEPARTMENT_UNRESOLVED" });

      // registerSupplierPayment：actor 不存在 → 拒绝
      await expect(
        registerSupplierPayment({
          supplierId: supplier.id,
          amount: 1000,
          allocations: [],
          actorUserId: ghostUserId,
        }),
      ).rejects.toMatchObject({ code: "DEPARTMENT_UNRESOLVED" });

      // PaymentError 仍可被 instanceof 识别
      let caught: unknown;
      try {
        await registerSupplierPayment({
          supplierId: supplier.id,
          amount: 1000,
          allocations: [],
          actorUserId: uBadDept.id,
        });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(PaymentError);

      // ── 3. 正常 FIELD_SALES / ONLINE_OPS / ADMIN 行为不回退（回归保护）──

      // getActorDepartment 正常返回合法部门
      expect(await getActorDepartment(uFsUser.id)).toBe("FIELD_SALES");
      expect(await getActorDepartment(uOps.id)).toBe("ONLINE_OPS");

      // getActorDepartment：用户不存在时抛 ValidationError
      await expect(getActorDepartment(ghostUserId)).rejects.toThrow(/部门/);

      // ADMIN scope 全量（null），不受部门解析影响
      expect(await getInquiryScopeWhere(uFs.id, "ADMIN")).toBeNull();
      expect(await getCostEntryScopeWhere(uFs.id, "ADMIN")).toBeNull();
      expect(await getSupplierPaymentScopeWhere(uFs.id, "ADMIN")).toBeNull();

      // FS USER 显式传 FIELD_SALES：返回正常 scope（非 no-match）
      const fsPayScope = await getSupplierPaymentScopeWhere(uFsUser.id, "USER", "FIELD_SALES");
      expect(fsPayScope).toEqual({ departmentSnapshot: "FIELD_SALES" });
      // OPS USER 显式传 ONLINE_OPS：返回正常 scope
      const opsPayScope = await getSupplierPaymentScopeWhere(uOps.id, "USER", "ONLINE_OPS");
      expect(opsPayScope).toEqual({ departmentSnapshot: "ONLINE_OPS" });

      // 正常 FS USER 不传 department：从 DB 解析出 FIELD_SALES（非 no-match）
      const fsResolvedScope = await getSupplierPaymentScopeWhere(uFsUser.id, "USER");
      expect(fsResolvedScope).toEqual({ departmentSnapshot: "FIELD_SALES" });
    });
  });
});

// ── helpers：判定 scope 是否为 no-match（{ id: { in: ["__NO_MATCH__"] } }）──
function isNoMatchScope(scope: Record<string, unknown> | null): boolean {
  if (!scope) return false;
  const id = (scope as { id?: unknown }).id;
  if (typeof id !== "object" || id === null) return false;
  const inArr = (id as { in?: unknown }).in;
  return Array.isArray(inArr) && inArr.includes("__NO_MATCH__");
}

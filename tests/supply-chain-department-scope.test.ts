/**
 * Phase 5 供应链共享/执行 scope 拆分与跨部门约束测试。
 *
 * 全部在 withTempSmokeDb 临时 SQLite 中执行（schema 模板 + COW 克隆），
 * 严禁触碰 prisma/dev.db 或任何真实库。
 *
 * 覆盖（设计 §12.2 场景 13/19 + §6.5 + §7.3）：
 *  1. 场景 #13：两部门都能读取同一共享供应商和报价（无部门过滤）。
 *  2. 场景 #19：报价共享，但订单 Inquiry/Plan/CostEntry/Payable/Payment 不跨部门。
 *  3. 无订单 Inquiry 的部门过滤（A 部门无订单 Inquiry 对 B 部门不可见）。
 *  4. Payment 跨部门分摊 Payable 被拒（409 / DEPARTMENT_MISMATCH）。
 *  5. 敏感字段脱敏回归（getQuoteSelect / getSupplierSelect）。
 *  6. CostEntry scope 不能通过共享 profileId 放宽部门。
 */
import { describe, expect, it } from "vitest";
import { withTempSmokeDb } from "../scripts/lib/temp-smoke-db";

describe("Phase 5 供应链共享/执行 scope 拆分与跨部门约束", () => {
  it("共享供应商/报价两部门可读；执行记录按部门隔离；Payment 跨部门分摊被拒", async () => {
    await withTempSmokeDb(async () => {
      const { prisma } = await import("@/lib/prisma");
      const {
        getSupplyExecutionScopeWhere,
        getInquiryScopeWhere,
        getCostEntryScopeWhere,
        getQuoteSelect,
        getSupplierSelect,
        canViewFloorPrice,
      } = await import("@/lib/supply-chain/permissions");
      const { getSupplierPaymentScopeWhere } = await import(
        "@/lib/finance/supplier-permissions"
      );
      const { registerSupplierPayment, PaymentError } = await import(
        "@/lib/finance/supplier-payments"
      );

      // ── 种子用户 ──
      const uFs = await prisma.user.create({
        data: { email: "fs@t.test", name: "FS", password: "x", role: "USER", department: "FIELD_SALES" },
      });
      const uOps = await prisma.user.create({
        data: { email: "ops@t.test", name: "OPS", password: "x", role: "USER", department: "ONLINE_OPS" },
      });
      const uAdmin = await prisma.user.create({
        data: { email: "admin@t.test", name: "ADM", password: "x", role: "ADMIN", department: "FIELD_SALES" },
      });

      // ── 共享供应商与报价（设计 §4.7：不加部门字段）──
      const supplier = await prisma.supplier.create({
        data: { name: "共享供应商", normalizedName: "shared supplier", riskNote: "敏感风险备注" },
      });
      const quote = await prisma.supplierQuote.create({
        data: {
          supplierId: supplier.id,
          itemName: "共享试剂",
          listPrice: 10000,
          quotedPrice: 9000,
          floorPriceHint: 7000,
        },
      });

      // ── 1. 场景 #13：两部门都能读取共享供应商/报价 ──
      // 共享路由不应用 scope where，直接可读；这里验证 supplier/quote 无 department 字段。
      const supplierBoth = await prisma.supplier.findUnique({ where: { id: supplier.id } });
      const quoteBoth = await prisma.supplierQuote.findUnique({ where: { id: quote.id } });
      expect(supplierBoth).not.toBeNull();
      expect(quoteBoth).not.toBeNull();
      expect(supplierBoth).not.toHaveProperty("departmentSnapshot");

      // ── 2. 场景 #19：报价共享，但订单执行记录不跨部门 ──
      // 两部门各建一个订单（同 profile 也可，但订单带各自 departmentSnapshot）
      const profile = await prisma.crmCustomerProfile.create({
        data: { name: "共享客户", assignmentStatus: "ASSIGNED", ownerUserId: uFs.id },
      });
      const orderFs = await prisma.order.create({
        data: {
          orderNo: "ORD-FS-1",
          title: "FS 订单",
          departmentSnapshot: "FIELD_SALES",
          profileId: profile.id,
          createdById: uFs.id,
        },
      });
      const orderOps = await prisma.order.create({
        data: {
          orderNo: "ORD-OPS-1",
          title: "OPS 订单",
          departmentSnapshot: "ONLINE_OPS",
          profileId: profile.id,
          createdById: uOps.id,
        },
      });

      // 2a. SupplyPlan scope：从 Order 继承，FS 用户看不到 OPS 订单的方案
      const planOps = await prisma.supplyPlan.create({
        data: { orderId: orderOps.id, createdById: uAdmin.id, name: "OPS 方案" },
      });
      const planFs = await prisma.supplyPlan.create({
        data: { orderId: orderFs.id, createdById: uAdmin.id, name: "FS 方案" },
      });
      const execScopeFs = await getSupplyExecutionScopeWhere(uFs.id, "USER", "FIELD_SALES");
      expect(execScopeFs).not.toBeNull();
      const visiblePlansFs = await prisma.supplyPlan.findMany({
        where: execScopeFs as never,
      });
      expect(visiblePlansFs.map((p) => p.id)).toContain(planFs.id);
      expect(visiblePlansFs.map((p) => p.id)).not.toContain(planOps.id);

      // 2b. SupplierInquiry scope：order-bound 按订单继承 + 无订单按自身快照
      // FS 订单上的询价（FS 部门）
      const inquiryFsOrder = await prisma.supplierInquiry.create({
        data: {
          supplierId: supplier.id,
          orderId: orderFs.id,
          departmentSnapshot: "FIELD_SALES",
          requestedItem: "FS 订单询价",
          createdById: uFs.id,
        },
      });
      // OPS 订单上的询价（OPS 部门）
      const inquiryOpsOrder = await prisma.supplierInquiry.create({
        data: {
          supplierId: supplier.id,
          orderId: orderOps.id,
          departmentSnapshot: "ONLINE_OPS",
          requestedItem: "OPS 订单询价",
          createdById: uOps.id,
        },
      });
      // FS 用户无订单询价（FIELD_SALES 快照）
      const inquiryFsNoOrder = await prisma.supplierInquiry.create({
        data: {
          supplierId: supplier.id,
          orderId: null,
          departmentSnapshot: "FIELD_SALES",
          requestedItem: "FS 无订单询价",
          createdById: uFs.id,
        },
      });
      // OPS 用户无订单询价（ONLINE_OPS 快照）
      const inquiryOpsNoOrder = await prisma.supplierInquiry.create({
        data: {
          supplierId: supplier.id,
          orderId: null,
          departmentSnapshot: "ONLINE_OPS",
          requestedItem: "OPS 无订单询价",
          createdById: uOps.id,
        },
      });

      const inquiryScopeFs = await getInquiryScopeWhere(uFs.id, "USER", "FIELD_SALES");
      expect(inquiryScopeFs).not.toBeNull();
      const visibleInquiriesFs = await prisma.supplierInquiry.findMany({
        where: inquiryScopeFs as never,
      });
      const fsInquiryIds = visibleInquiriesFs.map((i) => i.id);
      expect(fsInquiryIds).toContain(inquiryFsOrder.id);
      expect(fsInquiryIds).toContain(inquiryFsNoOrder.id);
      // 旧 bug 修复前：orderId=null 的 OPS 询价因 createdById 兜底+无部门过滤会被 FS 看到吗？
      // 修复后按 departmentSnapshot 严格隔离：
      expect(fsInquiryIds).not.toContain(inquiryOpsOrder.id);
      expect(fsInquiryIds).not.toContain(inquiryOpsNoOrder.id);

      // OPS 视角对称
      const inquiryScopeOps = await getInquiryScopeWhere(uOps.id, "USER", "ONLINE_OPS");
      const visibleInquiriesOps = await prisma.supplierInquiry.findMany({
        where: inquiryScopeOps as never,
      });
      const opsInquiryIds = visibleInquiriesOps.map((i) => i.id);
      expect(opsInquiryIds).toContain(inquiryOpsOrder.id);
      expect(opsInquiryIds).toContain(inquiryOpsNoOrder.id);
      expect(opsInquiryIds).not.toContain(inquiryFsOrder.id);
      expect(opsInquiryIds).not.toContain(inquiryFsNoOrder.id);

      // ── 3. 无订单 Inquiry 的部门过滤（场景 #19 补充）──
      // 直接 ID 校验：FS 无订单询价对 OPS 不可见
      const inquiryScopeOpsForFsNoOrder = await getInquiryScopeWhere(uOps.id, "USER", "ONLINE_OPS");
      const fsNoOrderVisibleToOps = await prisma.supplierInquiry.findFirst({
        where: { AND: [inquiryScopeOpsForFsNoOrder as never, { id: inquiryFsNoOrder.id }] },
      });
      expect(fsNoOrderVisibleToOps).toBeNull();

      // ── 4. CostEntry scope：不能通过共享 profileId 放宽部门 ──
      // 同一 profile 被 FS 和 OPS 订单引用；两个 CostEntry 各带自己部门快照
      const costFs = await prisma.costEntry.create({
        data: {
          subjectType: "CUSTOMER",
          profileId: profile.id,
          departmentSnapshot: "FIELD_SALES",
          bucket: "REAL",
          costType: "SUPPLIER",
          status: "COMMITTED",
          amount: 1000,
          sourceType: "MANUAL",
          sourceKey: "manual:fs-cost-1",
          effectiveGroupKey: "manual:fs-cost-1",
          supplierId: supplier.id,
          createdById: uAdmin.id,
        },
      });
      const costOps = await prisma.costEntry.create({
        data: {
          subjectType: "CUSTOMER",
          profileId: profile.id,
          departmentSnapshot: "ONLINE_OPS",
          bucket: "REAL",
          costType: "SUPPLIER",
          status: "COMMITTED",
          amount: 2000,
          sourceType: "MANUAL",
          sourceKey: "manual:ops-cost-1",
          effectiveGroupKey: "manual:ops-cost-1",
          supplierId: supplier.id,
          createdById: uAdmin.id,
        },
      });
      // USER FS 让 profile 进入 finance profile scope（ownerUserId=FS, ASSIGNED）
      const costScopeFs = await getCostEntryScopeWhere(uFs.id, "USER", "FIELD_SALES");
      expect(costScopeFs).not.toBeNull();
      const visibleCostsFs = await prisma.costEntry.findMany({
        where: costScopeFs as never,
      });
      const fsCostIds = visibleCostsFs.map((c) => c.id);
      expect(fsCostIds).toContain(costFs.id);
      // 关键：共享 profile 不能放宽——FS 看不到 OPS 部门的 cost
      expect(fsCostIds).not.toContain(costOps.id);

      // ── 5. FinancePayable / FinancePayment scope：按自身快照 ──
      const payableFs = await prisma.financePayable.create({
        data: {
          supplierId: supplier.id,
          orderId: orderFs.id,
          amount: 5000,
          paidAmount: 0,
          status: "UNPAID",
          departmentSnapshot: "FIELD_SALES",
          sourceType: "MANUAL",
          sourceKey: "manual:payable-fs-1",
          createdById: uAdmin.id,
        },
      });
      const payableOps = await prisma.financePayable.create({
        data: {
          supplierId: supplier.id,
          orderId: orderOps.id,
          amount: 6000,
          paidAmount: 0,
          status: "UNPAID",
          departmentSnapshot: "ONLINE_OPS",
          sourceType: "MANUAL",
          sourceKey: "manual:payable-ops-1",
          createdById: uAdmin.id,
        },
      });
      const payScopeFs = await getSupplierPaymentScopeWhere(uFs.id, "USER", "FIELD_SALES");
      expect(payScopeFs).toEqual({ departmentSnapshot: "FIELD_SALES" });
      const visiblePayablesFs = await prisma.financePayable.findMany({
        where: payScopeFs as never,
      });
      expect(visiblePayablesFs.map((p) => p.id)).toContain(payableFs.id);
      expect(visiblePayablesFs.map((p) => p.id)).not.toContain(payableOps.id);

      const paymentFs = await prisma.financePayment.create({
        data: {
          supplierId: supplier.id,
          amount: 4000,
          departmentSnapshot: "FIELD_SALES",
          createdById: uAdmin.id,
        },
      });
      const paymentScopeFs = await getSupplierPaymentScopeWhere(uFs.id, "USER", "FIELD_SALES");
      const visiblePaymentsFs = await prisma.financePayment.findMany({
        where: paymentScopeFs as never,
      });
      expect(visiblePaymentsFs.map((p) => p.id)).toContain(paymentFs.id);

      // ── 6. Payment 跨部门分摊 Payable 被拒（设计 §7.3 → 409 / DEPARTMENT_MISMATCH）──
      // FS 部门 actor 尝试用 OPS 部门的 payable 分摊 → 拒绝
      await expect(
        registerSupplierPayment({
          supplierId: supplier.id,
          amount: 1000,
          allocations: [{ payableId: payableOps.id, amount: 1000 }],
          actorUserId: uFs.id,
        }),
      ).rejects.toMatchObject({ code: "DEPARTMENT_MISMATCH" });

      // 同部门分摊成功
      const result = await registerSupplierPayment({
        supplierId: supplier.id,
        amount: 3000,
        allocations: [{ payableId: payableFs.id, amount: 3000 }],
        actorUserId: uFs.id,
      });
      expect(result.paymentId).toBeTruthy();
      // 新付款落本部门快照
      const newPayment = await prisma.financePayment.findUnique({
        where: { id: result.paymentId },
        select: { departmentSnapshot: true },
      });
      expect(newPayment?.departmentSnapshot).toBe("FIELD_SALES");

      // ── 7. 敏感字段脱敏回归（getQuoteSelect / getSupplierSelect）──
      const quoteSelectUser = getQuoteSelect("USER");
      expect(quoteSelectUser).not.toHaveProperty("floorPriceHint");
      const quoteSelectAdmin = getQuoteSelect("ADMIN");
      expect(quoteSelectAdmin).toHaveProperty("floorPriceHint");
      // 脱敏逻辑只依赖角色，与部门无关
      expect(canViewFloorPrice("USER")).toBe(false);
      expect(canViewFloorPrice("ADMIN")).toBe(true);

      const supplierSelectUser = getSupplierSelect("USER");
      expect(supplierSelectUser).not.toHaveProperty("riskNote");
      expect(supplierSelectUser).not.toHaveProperty("preferenceNote");
      const supplierSelectAdmin = getSupplierSelect("ADMIN");
      expect(supplierSelectAdmin).toHaveProperty("riskNote");
      expect(supplierSelectAdmin).toHaveProperty("preferenceNote");

      // ADMIN scope 全量（null）
      expect(await getSupplyExecutionScopeWhere(uAdmin.id, "ADMIN", "FIELD_SALES")).toBeNull();
      expect(await getInquiryScopeWhere(uAdmin.id, "ADMIN", "FIELD_SALES")).toBeNull();
      expect(await getCostEntryScopeWhere(uAdmin.id, "ADMIN", "FIELD_SALES")).toBeNull();
      expect(await getSupplierPaymentScopeWhere(uAdmin.id, "ADMIN", "FIELD_SALES")).toBeNull();

      // ── 8. 无供应链权限的角色（REPRESENTATIVE）拒绝 ──
      const uRep = await prisma.user.create({
        data: { email: "rep@t.test", name: "REP", password: "x", role: "REPRESENTATIVE", department: "FIELD_SALES" },
      });
      const execScopeRep = await getSupplyExecutionScopeWhere(uRep.id, "REPRESENTATIVE", "FIELD_SALES");
      const noPlans = await prisma.supplyPlan.findMany({ where: execScopeRep as never });
      expect(noPlans).toHaveLength(0);
      const inquiryScopeRep = await getInquiryScopeWhere(uRep.id, "REPRESENTATIVE", "FIELD_SALES");
      const noInquiries = await prisma.supplierInquiry.findMany({ where: inquiryScopeRep as never });
      expect(noInquiries).toHaveLength(0);

      // ── 9. PaymentError DEPARTMENT_MISMATCH 可被 instanceof 识别（路由层 409 映射依据）──
      // 复用同一次 withTempSmokeDb（Prisma 单例在同进程内不能跨多次 temp db 重建）。
      const payableOps2 = await prisma.financePayable.create({
        data: {
          supplierId: supplier.id,
          amount: 1000,
          paidAmount: 0,
          status: "UNPAID",
          departmentSnapshot: "ONLINE_OPS",
          sourceType: "MANUAL",
          sourceKey: "manual:payable-ops-2",
          createdById: uFs.id,
        },
      });

      let caught: unknown;
      try {
        await registerSupplierPayment({
          supplierId: supplier.id,
          amount: 500,
          allocations: [{ payableId: payableOps2.id, amount: 500 }],
          actorUserId: uFs.id,
        });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(PaymentError);
      expect((caught as InstanceType<typeof PaymentError>).code).toBe("DEPARTMENT_MISMATCH");
    });
  });
});

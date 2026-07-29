/**
 * 产品目录与订单—供应链—成本一体化 测试。
 *
 * 对应设计文档 §13 验收标准。覆盖：
 *  - BusinessSequence 原子编号 + 并发不冲突 + 序列独立 + 空洞不回收（§13.1）
 *  - Product/SKU CRUD + 编号唯一 + 停用/合并（§13.1）
 *  - 订单行 SKU 绑定 + 编号快照（§13.2）
 *  - PRJ-OTHER 治理桶不进入正常项目聚合 + operational where AND-composition（§13.5）
 *
 * 全部使用临时 SQLite（withTempSmokeDb）。按现有惯例（order-rep-notify /
 * order-receivables-query-parity），全部场景共享单个 withTempSmokeDb 临时库，
 * 避免多次 create/dispose temp DB 的 prisma 单例/模块缓存时序问题。
 *
 * ⚠️ 顶层只允许 type-only import：withTempSmokeDb 之前不能实例化 prisma 单例。
 * 业务模块用 @/ 别名动态 import（vitest resolve.alias 已配置）。
 */
import { describe, it, expect } from "vitest";
import { withTempSmokeDb } from "../scripts/lib/temp-smoke-db";

const ADMIN_ACTOR = { userId: "user-admin", role: "ADMIN", name: "Admin", email: "admin@test" } as const;
const TEST_PASSWORD_HASH = "$2a$10$testhashplaceholderplaceholderplaceholderplaceholde";

describe("产品目录与订单—供应链—成本一体化（共享临时库）", () => {
  it("BusinessSequence 编号 + Product/SKU CRUD + 订单行绑定 + 治理桶（§13 全覆盖）", async () => {
    await withTempSmokeDb(async () => {
      const { prisma } = await import("@/lib/prisma");
      const { nextProductCode, nextSkuCode } = await import("@/lib/business-sequence");
      const {
        createProductForActor,
        createSkuForActor,
        retireSkuForActor,
        mergeSkuForActor,
      } = await import("@/lib/products/application/create-product");
      const { getActiveSellableSku } = await import("@/lib/products/application/query-products");
      const { satisfiesCompatibilityInvariant } = await import("@/lib/products/application/bind-order-line");
      const { createOrderWithProject } = await import("@/lib/orders/create-order-with-project");
      const {
        ensureGeneralOtherProject,
        createGovernanceAssignmentForActor,
        resolveGovernanceAssignmentForActor,
      } = await import("@/lib/projects/application/governance-bucket");
      const { resolveProjectListWhere } = await import("@/lib/projects/application/query-projects");
      const { getOperationalProjectWhere } = await import("@/lib/projects/application/operational-where");

      // seed admin
      await prisma.user.create({
        data: { id: "user-admin", email: "admin@test", name: "Admin", password: TEST_PASSWORD_HASH, role: "ADMIN" },
      });

      // ═══════════════════════════════════════════════════════════════
      // §13.1 BusinessSequence 原子编号
      // ═══════════════════════════════════════════════════════════════

      // 1. 10 个并发事务领产品号——SQLite 写锁串行化，原子 upsert 保证单调递增。
      //    max+1 方案在并发下会重复，原子 upsert 不会。
      const codes = await Promise.all(
        Array.from({ length: 10 }, () =>
          prisma.$transaction((tx) => nextProductCode(tx), { timeout: 30000 }),
        ),
      );
      expect(codes).toHaveLength(10);
      expect(new Set(codes).size).toBe(10);
      expect(new Set(codes)).toEqual(
        new Set(Array.from({ length: 10 }, (_, i) => `PRD-${String(i + 1).padStart(6, "0")}`)),
      );

      // 2. Product 和 ProductSku 独立序列
      const skuCode = await prisma.$transaction((tx) => nextSkuCode(tx));
      const productCode11 = await prisma.$transaction((tx) => nextProductCode(tx));
      expect(skuCode).toBe("SKU-000001");
      expect(productCode11).toBe("PRD-000011");

      // 3. 事务失败：领号在同一事务内，事务回滚则序号声明也回滚（不浪费编号）。
      //    这是比"产生空洞"更安全的行为——编号服务与业务写在同一事务，原子性保证。
      await expect(
        prisma.$transaction(async (tx) => {
          await nextProductCode(tx); // 领了 PRD-000012
          throw new Error("intentional");
        }),
      ).rejects.toThrow("intentional");
      const nextCode = await prisma.$transaction((tx) => nextProductCode(tx));
      // 失败事务的声明已回滚，所以下一个仍是 PRD-000012（不产生空洞也不复用冲突）
      expect(nextCode).toBe("PRD-000012");

      // ═══════════════════════════════════════════════════════════════
      // §13.1 Product/SKU CRUD
      // ═══════════════════════════════════════════════════════════════

      const { product, aliases } = await createProductForActor(ADMIN_ACTOR, {
        name: "单细胞 RNA 测序",
        kind: "SERVICE",
        domain: "SEQUENCING",
        status: "ACTIVE",
        aliases: ["10x 单细胞", "10x  Single-Cell", "scRNA"],
      });
      expect(product.productCode).toMatch(/^PRD-\d{6}$/);
      expect(product.status).toBe("ACTIVE");
      expect(aliases).toHaveLength(3);
      expect(new Set(aliases.map((a) => a.normalizedAlias)).size).toBe(3);

      const { sku } = await createSkuForActor(ADMIN_ACTOR, {
        productId: product.id,
        name: "10x 3' GEX",
        spec: "3' GEX",
        standardUnit: "样本",
        defaultSalesPriceYuan: 5000,
        status: "ACTIVE",
      });
      expect(sku.skuCode).toMatch(/^SKU-\d{6}$/);
      expect(sku.defaultSalesPrice).toBe(500000);
      expect(await getActiveSellableSku(sku.id)).not.toBeNull();

      // 停用
      await retireSkuForActor(ADMIN_ACTOR, sku.id);
      expect(await getActiveSellableSku(sku.id)).toBeNull();

      // 合并
      const { sku: replacement } = await createSkuForActor(ADMIN_ACTOR, {
        productId: product.id, name: "新规格", standardUnit: "样本", status: "ACTIVE",
      });
      const { sourceSku } = await mergeSkuForActor(ADMIN_ACTOR, sku.id, replacement.id);
      expect(sourceSku.status).toBe("MERGED");
      expect(sourceSku.replacementSkuId).toBe(replacement.id);
      await expect(mergeSkuForActor(ADMIN_ACTOR, replacement.id, replacement.id)).rejects.toThrow();

      // review #5：已 MERGED/RETIRED 的 SKU 不可经通用 PATCH 修改（状态机收口）
      const { updateSkuForActor } = await import("@/lib/products/application/create-product");
      await expect(
        updateSkuForActor(ADMIN_ACTOR, sku.id, { name: "尝试改已合并SKU" }),
      ).rejects.toThrow(/不可经通用编辑修改/);
      // 通用 PATCH 不可直接改成 RETIRED/MERGED
      await expect(
        updateSkuForActor(ADMIN_ACTOR, replacement.id, { status: "RETIRED" }),
      ).rejects.toThrow(/不可经通用编辑将 SKU 改为/);

      // ═══════════════════════════════════════════════════════════════
      // §13.2 订单行 SKU 绑定
      // ═══════════════════════════════════════════════════════════════

      const { sku: sellableSku } = await createSkuForActor(ADMIN_ACTOR, {
        productId: product.id, name: "可售规格", standardUnit: "样本", status: "ACTIVE", sellable: true,
      });
      const result = await prisma.$transaction((tx) =>
        createOrderWithProject(tx, {
          title: "测试订单",
          status: "DRAFT",
          techSupport: "测试",
          lines: [{
            itemName: sellableSku.name,
            amount: 100000, quantity: 2, unitPrice: 50000,
            productSkuId: sellableSku.id,
            productCodeSnapshot: product.productCode,
            skuCodeSnapshot: sellableSku.skuCode,
          }],
          createdById: "user-admin",
        }),
      );
      const orderLine = result.order.lines?.[0];
      expect(orderLine!.productCodeSnapshot).toBe(product.productCode);
      expect(orderLine!.skuCodeSnapshot).toBe(sellableSku.skuCode);
      const binding = await prisma.orderLineServiceMapping.findUnique({ where: { orderLineId: orderLine!.id } });
      expect(binding).not.toBeNull();
      expect(binding!.productSkuId).toBe(sellableSku.id);
      expect(binding!.serviceKey).toBeNull();

      // 兼容期不变量守卫
      expect(satisfiesCompatibilityInvariant({ productSkuId: "s1", serviceKey: null })).toBe(true);
      expect(satisfiesCompatibilityInvariant({ productSkuId: null, serviceKey: "legacy" })).toBe(true);
      expect(satisfiesCompatibilityInvariant({ productSkuId: null, serviceKey: null })).toBe(false);

      // ═══════════════════════════════════════════════════════════════
      // §13.5 PRJ-OTHER 治理桶
      // ═══════════════════════════════════════════════════════════════

      // operational where helper AND-composition
      const opWhere = getOperationalProjectWhere({ deleted: false }, { status: "NOT_STARTED" });
      expect(opWhere).toEqual({
        AND: [{ deleted: false }, { systemType: "NORMAL" }, { status: "NOT_STARTED" }],
      });

      // 治理桶不进入正常项目聚合
      await prisma.project.create({ data: { name: "普通项目 A", projectNo: "PRJ-20260101-0001", systemType: "NORMAL" } });
      const bucket = await ensureGeneralOtherProject(ADMIN_ACTOR);
      expect(bucket.systemType).toBe("GOVERNANCE_BUCKET");

      const listResult = await resolveProjectListWhere(ADMIN_ACTOR, {});
      expect("empty" in listResult).toBe(false);
      if (!("empty" in listResult)) {
        const projects = await prisma.project.findMany({ where: listResult.where });
        expect(projects.every((p) => p.systemType === "NORMAL")).toBe(true);
        expect(projects.find((p) => p.systemKey === "GENERAL_OTHER_PROJECT")).toBeUndefined();
      }

      // 治理 assignment 创建 + 解决 + 审计保留
      const realProject = await prisma.project.create({ data: { name: "真实项目", projectNo: "PRJ-20260101-0002", systemType: "NORMAL" } });
      // review #7：治理 assignment 必须恰好关联一个对象。创建一个测试订单作为 subject。
      const govOrder = await prisma.order.create({
        data: { orderNo: "SO-GOV-001", title: "治理测试订单", source: "OTHER_IMPORT", createdById: "user-admin", totalAmount: 0 },
      });
      const assignment = await createGovernanceAssignmentForActor(ADMIN_ACTOR, {
        reasonCode: "MISSING_PROJECT_NO",
        orderId: govOrder.id,
        note: "历史导入缺项目号",
      });
      expect(assignment.governanceProjectId).toBe(bucket.id);
      const resolved = await resolveGovernanceAssignmentForActor(ADMIN_ACTOR, assignment.id, realProject.id, "已确认");
      expect(resolved.status).toBe("RESOLVED");
      expect(resolved.resolvedProjectId).toBe(realProject.id);
      const stillExists = await prisma.projectGovernanceAssignment.findUnique({ where: { id: assignment.id } });
      expect(stillExists).not.toBeNull();
      expect(stillExists!.status).toBe("RESOLVED");

      // review #7：无 subject 的 assignment 被拒；多 subject 也被拒
      await expect(
        createGovernanceAssignmentForActor(ADMIN_ACTOR, { reasonCode: "MISSING_PROJECT_NO" }),
      ).rejects.toThrow(/必须关联恰好一个对象/);
      await expect(
        createGovernanceAssignmentForActor(ADMIN_ACTOR, {
          reasonCode: "MISSING_PROJECT_NO",
          orderId: govOrder.id,
          legacyProjectId: "lp-1",
        }),
      ).rejects.toThrow(/三选一/);

      // ═══════════════════════════════════════════════════════════════
      // 权限：非内部员工不可管理目录
      // ═══════════════════════════════════════════════════════════════
      await prisma.user.create({
        data: { id: "rep-1", email: "rep@test", name: "REP", password: TEST_PASSWORD_HASH, role: "REPRESENTATIVE" },
      });
      await expect(
        createProductForActor({ userId: "rep-1", role: "REPRESENTATIVE" }, { name: "X" }),
      ).rejects.toThrow();
    });
  }, 120000);
});

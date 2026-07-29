/**
 * 供应方案主链路回归：BOM 展开、legacy 创建、锁定校验、取消释放需求。
 *
 * 覆盖 review P0/P1：
 *  - legacy serviceKey 可创建方案（不把 serviceKey 当 ProductSku id）
 *  - BOM 组件数量不重复乘算
 *  - INTERNAL 不强制报价；PROCUREMENT 无报价阻断
 *  - 方案行冻结 definitionHash；锁定三方比较
 *  - 锁定前复核报价有效性
 *  - 取消非锁定方案释放 PLANNED → OPEN
 *  - 方案创建后改订单数量 → 锁定失败（hash 读当前 OrderLine）
 *  - BOM 增删后整组 refreshRequirementsForOrderLine → 完整新需求组
 *  - 仅改订单单位 / 根 SKU 绑定变更 → 锁定失败
 *  - 新增 BOM 组件 supersedes=null；兼容包装按 identity 返回
 *  - 候选生成后改数量再 create → ConflictError 且无草稿落库
 *  - BOM 含无报价 OPTIONAL：预览/创建成功，OPTIONAL requirement 保持 OPEN
 *
 * ⚠️ 顶层只允许 type-only import：withTempSmokeDb 之前不能实例化 prisma 单例。
 */
import { describe, it, expect } from "vitest";
import { withTempSmokeDb } from "../scripts/lib/temp-smoke-db";

const ADMIN_ACTOR = { userId: "user-admin", role: "ADMIN", name: "Admin", email: "admin@test" } as const;
const TEST_PASSWORD_HASH = "$2a$10$testhashplaceholderplaceholderplaceholderplaceholde";

describe("供应方案主链路（BOM / legacy / lock / cancel）", () => {
  it("legacy 可创建 + BOM 数量正确 + INTERNAL 不阻断 + 锁定/取消状态机", async () => {
    await withTempSmokeDb(async () => {
      const { prisma } = await import("@/lib/prisma");
      const { createProductForActor, createSkuForActor } = await import("@/lib/products/application/create-product");
      const { createOrderWithProject } = await import("@/lib/orders/create-order-with-project");
      const {
        buildSupplyPlanCandidates,
        createSupplyPlanFromCandidate,
      } = await import("@/lib/supply-chain/plan-builder");
      const { lockSupplyPlan, SupplyPlanLockError } = await import("@/lib/supply-chain/commit-plan");
      const { cancelSupplyPlan } = await import("@/lib/supply-chain/cancel-plan");
      const { PLAN_TYPE } = await import("@/lib/supply-chain/constants");
      const { ConflictError } = await import("@/lib/application/errors");

      await prisma.user.create({
        data: { id: "user-admin", email: "admin@test", name: "Admin", password: TEST_PASSWORD_HASH, role: "ADMIN" },
      });
      const profile = await prisma.crmCustomerProfile.create({
        data: { name: "供应方案客户", ownerUserId: "user-admin" },
      });
      const supplier = await prisma.supplier.create({
        data: { name: "测试供应商", normalizedName: "测试供应商", status: "ACTIVE" },
      });

      // ── 产品目录：组合 SKU = PROCUREMENT(×2) + INTERNAL(×1) ──
      const { product } = await createProductForActor(ADMIN_ACTOR, {
        name: "组合测序套餐", kind: "SERVICE", domain: "SEQUENCING", status: "ACTIVE",
      });
      const { sku: rootSku } = await createSkuForActor(ADMIN_ACTOR, {
        productId: product.id, name: "组合套餐", standardUnit: "样本",
        status: "ACTIVE", sellable: true, purchasable: false,
      });
      const { sku: procSku } = await createSkuForActor(ADMIN_ACTOR, {
        productId: product.id, name: "外采试剂", standardUnit: "样本",
        status: "ACTIVE", sellable: false, purchasable: true,
      });
      const { sku: internalSku } = await createSkuForActor(ADMIN_ACTOR, {
        productId: product.id, name: "内部实验", standardUnit: "样本",
        status: "ACTIVE", sellable: false, purchasable: false,
        fulfillmentMode: "INTERNAL_ONLY",
      });
      await prisma.productSkuComponent.createMany({
        data: [
          { parentSkuId: rootSku.id, componentSkuId: procSku.id, quantity: 2, role: "PROCUREMENT", active: true },
          { parentSkuId: rootSku.id, componentSkuId: internalSku.id, quantity: 1, role: "INTERNAL", active: true },
        ],
      });

      // 外采组件报价：单价 1000 分
      await prisma.supplierQuote.create({
        data: {
          supplierId: supplier.id,
          productSkuId: procSku.id,
          itemName: "外采试剂",
          unit: "样本",
          listPrice: 1200,
          quotedPrice: 1000,
          status: "ACTIVE",
          leadDays: 5,
        },
      });

      // ── BOM 订单：数量 3 → PROCUREMENT 需求数量应为 6，不是 12 ──
      const bomOrder = await prisma.$transaction((tx) =>
        createOrderWithProject(tx, {
          title: "BOM 供应方案订单",
          status: "DRAFT",
          techSupport: "测试",
          profileId: profile.id,
          lines: [{
            itemName: rootSku.name,
            amount: 300000, quantity: 3, unitPrice: 100000,
            productSkuId: rootSku.id,
            productCodeSnapshot: product.productCode,
            skuCodeSnapshot: rootSku.skuCode,
          }],
          createdById: "user-admin",
        }),
      );

      const bomCandidate = await buildSupplyPlanCandidates({
        orderId: bomOrder.order.id,
        mode: PLAN_TYPE.LOWEST_COST,
      });
      expect(bomCandidate.blockingIssues).toEqual([]);
      expect(bomCandidate.readyToLock).toBe(true);

      const procLine = bomCandidate.lines.find((l) => l.productSkuId === procSku.id);
      const internalLine = bomCandidate.lines.find((l) => l.productSkuId === internalSku.id);
      expect(procLine).toBeDefined();
      expect(internalLine).toBeDefined();
      expect(procLine!.orderQuantity).toBe(3);
      expect(procLine!.quantity).toBe(6); // 2 × 3
      expect(procLine!.selectedQuote).not.toBeNull();
      expect(procLine!.lineAmount).toBe(6000); // 6 × 1000
      expect(internalLine!.role).toBe("INTERNAL");
      expect(internalLine!.selectedQuote).toBeNull();
      expect(internalLine!.lineAmount).toBe(0);

      const bomPlanId = await createSupplyPlanFromCandidate(bomCandidate, "user-admin");
      const bomReqs = await prisma.supplyRequirement.findMany({
        where: { orderId: bomOrder.order.id },
        orderBy: { productSkuId: "asc" },
      });
      expect(bomReqs).toHaveLength(2);
      const procReq = bomReqs.find((r) => r.productSkuId === procSku.id)!;
      const internalReq = bomReqs.find((r) => r.productSkuId === internalSku.id)!;
      expect(procReq.quantity).toBe(6);
      expect(procReq.status).toBe("PLANNED");
      expect(internalReq.quantity).toBe(3);
      expect(internalReq.status).toBe("PLANNED");

      const bomPlanLines = await prisma.supplyPlanLine.findMany({ where: { planId: bomPlanId } });
      expect(bomPlanLines).toHaveLength(2);
      const procPlanLine = bomPlanLines.find((l) => l.productSkuId === procSku.id)!;
      expect(procPlanLine.quantity).toBe(6);
      expect(procPlanLine.definitionHash).toBe(procLine!.definitionHash);
      expect(procPlanLine.definitionHash).toBeTruthy();
      const internalPlanLine = bomPlanLines.find((l) => l.productSkuId === internalSku.id)!;
      expect(internalPlanLine.supplierId).toBeNull();
      expect(internalPlanLine.quoteId).toBeNull();
      expect(internalPlanLine.componentRole).toBe("INTERNAL");
      expect(procPlanLine.productCodeSnapshot).toBe(product.productCode);
      expect(procPlanLine.skuCodeSnapshot).toBe(procSku.skuCode);
      expect(procPlanLine.unit).toBe("样本");
      expect(procReq.componentRole).toBe("PROCUREMENT");
      expect(internalReq.componentRole).toBe("INTERNAL");
      expect(procReq.componentPath).toContain(":PROCUREMENT");
      expect(internalReq.componentPath).toContain(":INTERNAL");

      // 锁定成功：definitionHash 三方一致 + 报价复核通过
      const locked = await lockSupplyPlan({ planId: bomPlanId, actorUserId: "user-admin" });
      expect(locked.status).toBe("LOCKED");
      expect(locked.costEntryIds).toHaveLength(2);
      const lockedReqs = await prisma.supplyRequirement.findMany({ where: { orderId: bomOrder.order.id } });
      expect(lockedReqs.every((r) => r.status === "LOCKED")).toBe(true);

      // ── legacy serviceKey 订单：可预览且可创建（不再把 serviceKey 当 SKU id）──
      const legacyOrder = await prisma.$transaction((tx) =>
        createOrderWithProject(tx, {
          title: "Legacy 供应方案订单",
          status: "DRAFT",
          techSupport: "测试",
          profileId: profile.id,
          lines: [{
            itemName: "旧服务项",
            amount: 50000, quantity: 2, unitPrice: 25000,
            // 不传 productSkuId → 需手工写 legacy mapping
          }],
          createdById: "user-admin",
        }),
      );
      const legacyLineId = legacyOrder.order.lines![0].id;
      // createOrderWithProject 可能未建 mapping；确保 legacy-only
      await prisma.orderLineServiceMapping.deleteMany({ where: { orderLineId: legacyLineId } });
      await prisma.orderLineServiceMapping.create({
        data: {
          orderLineId: legacyLineId,
          productSkuId: null,
          serviceKey: "legacy.scrnaseq",
          confidence: 1,
          source: "MIGRATION_EXACT",
        },
      });
      await prisma.supplierQuote.create({
        data: {
          supplierId: supplier.id,
          serviceKey: "legacy.scrnaseq",
          itemName: "旧服务项",
          unit: "样本",
          listPrice: 30000,
          quotedPrice: 25000,
          status: "ACTIVE",
          leadDays: 7,
        },
      });

      const legacyCandidate = await buildSupplyPlanCandidates({
        orderId: legacyOrder.order.id,
        mode: PLAN_TYPE.LOWEST_COST,
      });
      expect(legacyCandidate.readyToLock).toBe(true);
      expect(legacyCandidate.lines).toHaveLength(1);
      expect(legacyCandidate.lines[0].productSkuId).toBeNull();
      expect(legacyCandidate.lines[0].serviceKey).toBe("legacy.scrnaseq");

      const legacyPlanId = await createSupplyPlanFromCandidate(legacyCandidate, "user-admin");
      const legacyPlanLines = await prisma.supplyPlanLine.findMany({ where: { planId: legacyPlanId } });
      expect(legacyPlanLines).toHaveLength(1);
      expect(legacyPlanLines[0].productSkuId).toBeNull();
      expect(legacyPlanLines[0].supplyRequirementId).toBeNull();
      expect(legacyPlanLines[0].quantity).toBe(2);
      expect(legacyPlanLines[0].serviceKeySnapshot).toBe("legacy.scrnaseq");
      // 无 SupplyRequirement 产生
      const legacyReqs = await prisma.supplyRequirement.count({ where: { orderId: legacyOrder.order.id } });
      expect(legacyReqs).toBe(0);

      // ── 取消非锁定方案：PLANNED → OPEN ──
      const cancelOrder = await prisma.$transaction((tx) =>
        createOrderWithProject(tx, {
          title: "取消释放需求订单",
          status: "DRAFT",
          techSupport: "测试",
          profileId: profile.id,
          lines: [{
            itemName: procSku.name,
            amount: 100000, quantity: 1, unitPrice: 100000,
            productSkuId: procSku.id,
            productCodeSnapshot: product.productCode,
            skuCodeSnapshot: procSku.skuCode,
          }],
          createdById: "user-admin",
        }),
      );
      const cancelCandidate = await buildSupplyPlanCandidates({
        orderId: cancelOrder.order.id,
        mode: PLAN_TYPE.LOWEST_COST,
      });
      expect(cancelCandidate.readyToLock).toBe(true);
      const cancelPlanId = await createSupplyPlanFromCandidate(cancelCandidate, "user-admin");
      const plannedBefore = await prisma.supplyRequirement.findMany({
        where: { orderId: cancelOrder.order.id },
      });
      expect(plannedBefore.length).toBeGreaterThan(0);
      expect(plannedBefore.every((r) => r.status === "PLANNED")).toBe(true);

      await cancelSupplyPlan({ planId: cancelPlanId, actorUserId: "user-admin", reason: "测试取消" });
      const afterCancel = await prisma.supplyRequirement.findMany({
        where: { orderId: cancelOrder.order.id },
      });
      expect(afterCancel.every((r) => r.status === "OPEN")).toBe(true);

      // ── 锁定前报价过期应失败 ──
      const expireOrder = await prisma.$transaction((tx) =>
        createOrderWithProject(tx, {
          title: "报价过期锁定订单",
          status: "DRAFT",
          techSupport: "测试",
          profileId: profile.id,
          lines: [{
            itemName: procSku.name,
            amount: 100000, quantity: 1, unitPrice: 100000,
            productSkuId: procSku.id,
            productCodeSnapshot: product.productCode,
            skuCodeSnapshot: procSku.skuCode,
          }],
          createdById: "user-admin",
        }),
      );
      const expireCandidate = await buildSupplyPlanCandidates({
        orderId: expireOrder.order.id,
        mode: PLAN_TYPE.LOWEST_COST,
      });
      const expirePlanId = await createSupplyPlanFromCandidate(expireCandidate, "user-admin");
      const expireLine = await prisma.supplyPlanLine.findFirst({ where: { planId: expirePlanId } });
      expect(expireLine?.quoteId).toBeTruthy();
      await prisma.supplierQuote.update({
        where: { id: expireLine!.quoteId! },
        data: { validTo: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      });
      await expect(
        lockSupplyPlan({ planId: expirePlanId, actorUserId: "user-admin" }),
      ).rejects.toBeInstanceOf(SupplyPlanLockError);

      // ═══════════════════════════════════════════════════════════════
      // 组合场景：多草稿共享 + 同 SKU 多 role + 跨产品组件快照
      // （同一临时库，避免多次 withTempSmokeDb 的 prisma 单例冲突）
      // ═══════════════════════════════════════════════════════════════

      const { product: rootProduct } = await createProductForActor(ADMIN_ACTOR, {
        name: "销售套餐产品", kind: "COMPOSITE", domain: "SEQUENCING", status: "ACTIVE",
      });
      const { product: reagentProduct } = await createProductForActor(ADMIN_ACTOR, {
        name: "试剂耗材产品", kind: "PHYSICAL", domain: "SEQUENCING", status: "ACTIVE",
      });
      const { sku: comboRootSku } = await createSkuForActor(ADMIN_ACTOR, {
        productId: rootProduct.id, name: "套餐A", standardUnit: "套餐",
        status: "ACTIVE", sellable: true, purchasable: false,
      });
      const { sku: sharedCompSku } = await createSkuForActor(ADMIN_ACTOR, {
        productId: reagentProduct.id, name: "通用试剂盒", standardUnit: "盒",
        status: "ACTIVE", sellable: false, purchasable: true,
      });
      await prisma.productSkuComponent.createMany({
        data: [
          {
            parentSkuId: comboRootSku.id, componentSkuId: sharedCompSku.id,
            quantity: 2, role: "PROCUREMENT", active: true,
          },
          {
            parentSkuId: comboRootSku.id, componentSkuId: sharedCompSku.id,
            quantity: 1, role: "INTERNAL", active: true,
          },
        ],
      });
      // 独立报价（上面 expire 测试已过期了旧报价）
      await prisma.supplierQuote.create({
        data: {
          supplierId: supplier.id,
          productSkuId: sharedCompSku.id,
          itemName: "通用试剂盒",
          unit: "盒",
          listPrice: 2000,
          quotedPrice: 1500,
          status: "ACTIVE",
          leadDays: 3,
        },
      });

      const multiOrder = await prisma.$transaction((tx) =>
        createOrderWithProject(tx, {
          title: "多草稿/多role订单",
          status: "DRAFT",
          techSupport: "测试",
          profileId: profile.id,
          lines: [{
            itemName: comboRootSku.name,
            amount: 200000, quantity: 2, unitPrice: 100000,
            productSkuId: comboRootSku.id,
            productCodeSnapshot: rootProduct.productCode,
            skuCodeSnapshot: comboRootSku.skuCode,
            unit: "套餐",
          }],
          createdById: "user-admin",
        }),
      );

      const candidate1 = await buildSupplyPlanCandidates({
        orderId: multiOrder.order.id, mode: PLAN_TYPE.LOWEST_COST,
      });
      expect(candidate1.readyToLock).toBe(true);
      expect(candidate1.lines).toHaveLength(2);

      const procCand = candidate1.lines.find((l) => l.role === "PROCUREMENT")!;
      const internalCand = candidate1.lines.find((l) => l.role === "INTERNAL")!;
      expect(procCand.productSkuId).toBe(sharedCompSku.id);
      expect(internalCand.productSkuId).toBe(sharedCompSku.id);
      expect(procCand.quantity).toBe(4);
      expect(internalCand.quantity).toBe(2);
      expect(procCand.unit).toBe("盒");
      expect(internalCand.unit).toBe("盒");
      expect(procCand.productCodeSnapshot).toBe(reagentProduct.productCode);
      expect(procCand.skuCodeSnapshot).toBe(sharedCompSku.skuCode);
      expect(procCand.componentPath).toContain(":PROCUREMENT");
      expect(internalCand.componentPath).toContain(":INTERNAL");

      const plan1Id = await createSupplyPlanFromCandidate(candidate1, "user-admin", "草稿1");
      const reqsAfterFirst = await prisma.supplyRequirement.findMany({
        where: { orderId: multiOrder.order.id },
      });
      expect(reqsAfterFirst).toHaveLength(2);
      expect(reqsAfterFirst.every((r) => r.revision === 1)).toBe(true);
      expect(reqsAfterFirst.every((r) => r.status === "PLANNED")).toBe(true);
      const multiProcReq = reqsAfterFirst.find((r) => r.componentRole === "PROCUREMENT")!;
      const multiInternalReq = reqsAfterFirst.find((r) => r.componentRole === "INTERNAL")!;
      expect(multiProcReq.id).not.toBe(multiInternalReq.id);
      expect(multiProcReq.productSkuId).toBe(sharedCompSku.id);
      expect(multiInternalReq.productSkuId).toBe(sharedCompSku.id);

      const candidate2 = await buildSupplyPlanCandidates({
        orderId: multiOrder.order.id, mode: PLAN_TYPE.FASTEST,
      });
      const plan2Id = await createSupplyPlanFromCandidate(candidate2, "user-admin", "草稿2");
      expect(plan2Id).not.toBe(plan1Id);
      const reqsAfterSecond = await prisma.supplyRequirement.findMany({
        where: { orderId: multiOrder.order.id },
      });
      expect(reqsAfterSecond).toHaveLength(2);
      expect(new Set(reqsAfterSecond.map((r) => r.id))).toEqual(
        new Set(reqsAfterFirst.map((r) => r.id)),
      );

      const plan1Lines = await prisma.supplyPlanLine.findMany({ where: { planId: plan1Id } });
      const plan2Lines = await prisma.supplyPlanLine.findMany({ where: { planId: plan2Id } });
      expect(plan1Lines).toHaveLength(2);
      expect(plan2Lines).toHaveLength(2);
      expect(plan1Lines.find((l) => l.componentRole === "PROCUREMENT")!.supplyRequirementId).toBe(multiProcReq.id);
      expect(plan1Lines.find((l) => l.componentRole === "INTERNAL")!.supplyRequirementId).toBe(multiInternalReq.id);
      expect(plan2Lines.find((l) => l.componentRole === "PROCUREMENT")!.supplyRequirementId).toBe(multiProcReq.id);

      const multiProcPlanLine = plan1Lines.find((l) => l.componentRole === "PROCUREMENT")!;
      expect(multiProcPlanLine.productCodeSnapshot).toBe(reagentProduct.productCode);
      expect(multiProcPlanLine.skuCodeSnapshot).toBe(sharedCompSku.skuCode);
      expect(multiProcPlanLine.unit).toBe("盒");
      expect(multiProcPlanLine.productCodeSnapshot).not.toBe(rootProduct.productCode);

      await cancelSupplyPlan({ planId: plan1Id, actorUserId: "user-admin", reason: "保留草稿2" });
      const afterCancel1 = await prisma.supplyRequirement.findMany({
        where: { orderId: multiOrder.order.id },
      });
      expect(afterCancel1.every((r) => r.status === "PLANNED")).toBe(true);

      const locked2 = await lockSupplyPlan({ planId: plan2Id, actorUserId: "user-admin" });
      expect(locked2.status).toBe("LOCKED");
      expect(locked2.costEntryIds).toHaveLength(2);
      const afterLock2 = await prisma.supplyRequirement.findMany({
        where: { orderId: multiOrder.order.id },
      });
      expect(afterLock2.every((r) => r.status === "LOCKED")).toBe(true);
      const costs = await prisma.costEntry.findMany({ where: { supplyPlanId: plan2Id } });
      const procCost = costs.find((c) => c.supplyRequirementId === multiProcReq.id)!;
      expect(procCost.productSkuId).toBe(sharedCompSku.id);
      expect(procCost.productCodeSnapshot).toBe(reagentProduct.productCode);
      expect(procCost.skuCodeSnapshot).toBe(sharedCompSku.skuCode);
      expect(procCost.amount).toBe(6000);

      // ═══════════════════════════════════════════════════════════════
      // P1 回归：方案创建后改订单数量 → 锁定必须失败（hash 用当前订单数量）
      // ═══════════════════════════════════════════════════════════════
      const { sku: qtyRootSku } = await createSkuForActor(ADMIN_ACTOR, {
        productId: product.id, name: "数量变更套餐", standardUnit: "样本",
        status: "ACTIVE", sellable: true, purchasable: false,
      });
      await prisma.productSkuComponent.create({
        data: {
          parentSkuId: qtyRootSku.id, componentSkuId: procSku.id,
          quantity: 2, role: "PROCUREMENT", active: true,
        },
      });
      // 恢复可用报价（expire 测试可能污染了旧 quote；新建一条绑定 procSku）
      await prisma.supplierQuote.create({
        data: {
          supplierId: supplier.id,
          productSkuId: procSku.id,
          itemName: "外采试剂-数量回归",
          unit: "样本",
          listPrice: 1200,
          quotedPrice: 1000,
          status: "ACTIVE",
          leadDays: 5,
        },
      });

      const qtyOrder = await prisma.$transaction((tx) =>
        createOrderWithProject(tx, {
          title: "数量变更锁定回归",
          status: "DRAFT",
          techSupport: "测试",
          profileId: profile.id,
          lines: [{
            itemName: qtyRootSku.name,
            amount: 300000, quantity: 3, unitPrice: 100000,
            productSkuId: qtyRootSku.id,
            productCodeSnapshot: product.productCode,
            skuCodeSnapshot: qtyRootSku.skuCode,
            unit: "样本",
          }],
          createdById: "user-admin",
        }),
      );
      const qtyLineId = qtyOrder.order.lines![0].id;
      const qtyCandidate = await buildSupplyPlanCandidates({
        orderId: qtyOrder.order.id, mode: PLAN_TYPE.LOWEST_COST,
      });
      expect(qtyCandidate.readyToLock).toBe(true);
      const qtyPlanId = await createSupplyPlanFromCandidate(qtyCandidate, "user-admin");
      const qtyReqsBefore = await prisma.supplyRequirement.findMany({
        where: { orderLineId: qtyLineId, status: "PLANNED" },
      });
      expect(qtyReqsBefore).toHaveLength(1);
      expect(qtyReqsBefore[0].quantity).toBe(6); // 2 × 3

      // 方案已创建后把订单行数量 3 → 4；冻结 hash 仍按 qty=6，当前应为 8
      await prisma.orderLine.update({
        where: { id: qtyLineId },
        data: { quantity: 4 },
      });
      await expect(
        lockSupplyPlan({ planId: qtyPlanId, actorUserId: "user-admin" }),
      ).rejects.toBeInstanceOf(SupplyPlanLockError);

      // ═══════════════════════════════════════════════════════════════
      // P1 回归：候选生成后改数量再 create → 409 且无草稿落库
      // ═══════════════════════════════════════════════════════════════
      const staleCandOrder = await prisma.$transaction((tx) =>
        createOrderWithProject(tx, {
          title: "候选过期创建回归",
          status: "DRAFT",
          techSupport: "测试",
          profileId: profile.id,
          lines: [{
            itemName: qtyRootSku.name,
            amount: 300000, quantity: 3, unitPrice: 100000,
            productSkuId: qtyRootSku.id,
            productCodeSnapshot: product.productCode,
            skuCodeSnapshot: qtyRootSku.skuCode,
            unit: "样本",
          }],
          createdById: "user-admin",
        }),
      );
      const staleCandLineId = staleCandOrder.order.lines![0].id;
      const staleCandidate = await buildSupplyPlanCandidates({
        orderId: staleCandOrder.order.id, mode: PLAN_TYPE.LOWEST_COST,
      });
      expect(staleCandidate.readyToLock).toBe(true);
      expect(staleCandidate.lines[0].orderQuantity).toBe(3);

      await prisma.orderLine.update({
        where: { id: staleCandLineId },
        data: { quantity: 4 },
      });

      const plansBefore = await prisma.supplyPlan.count({
        where: { orderId: staleCandOrder.order.id },
      });
      const reqsBefore = await prisma.supplyRequirement.count({
        where: { orderId: staleCandOrder.order.id },
      });
      await expect(
        createSupplyPlanFromCandidate(staleCandidate, "user-admin"),
      ).rejects.toBeInstanceOf(ConflictError);
      expect(await prisma.supplyPlan.count({ where: { orderId: staleCandOrder.order.id } })).toBe(plansBefore);
      expect(await prisma.supplyRequirement.count({ where: { orderId: staleCandOrder.order.id } })).toBe(reqsBefore);

      // ═══════════════════════════════════════════════════════════════
      // P1 回归：BOM 增删组件后整组刷新 → 完整新需求组
      // ═══════════════════════════════════════════════════════════════
      const { refreshRequirementsForOrderLine } = await import(
        "@/lib/products/application/supply-requirements"
      );

      // 取消过期方案释放需求 → OPEN，才能刷新
      await cancelSupplyPlan({ planId: qtyPlanId, actorUserId: "user-admin", reason: "数量已变，取消后刷新" });
      const openAfterCancel = await prisma.supplyRequirement.findMany({
        where: { orderLineId: qtyLineId, status: "OPEN" },
      });
      expect(openAfterCancel).toHaveLength(1);

      // 新增 INTERNAL 组件到 BOM
      await prisma.productSkuComponent.create({
        data: {
          parentSkuId: qtyRootSku.id, componentSkuId: internalSku.id,
          quantity: 1, role: "INTERNAL", active: true,
        },
      });

      // 不刷新直接再生成候选/方案：expand 会因组不完整而 Conflict
      await expect(
        createSupplyPlanFromCandidate(
          await buildSupplyPlanCandidates({
            orderId: qtyOrder.order.id, mode: PLAN_TYPE.LOWEST_COST,
          }),
          "user-admin",
        ),
      ).rejects.toBeInstanceOf(ConflictError);

      const refreshResult = await refreshRequirementsForOrderLine(
        ADMIN_ACTOR,
        { channel: "web" },
        qtyLineId,
      );
      expect(refreshResult.cancelledIds).toHaveLength(1);
      expect(refreshResult.createdIds).toHaveLength(2);

      const refreshed = await prisma.supplyRequirement.findMany({
        where: { orderLineId: qtyLineId, status: "OPEN" },
        orderBy: { componentRole: "asc" },
      });
      expect(refreshed).toHaveLength(2);
      expect(refreshed.every((r) => r.revision === 2)).toBe(true);
      // 订单数量已是 4：PROCUREMENT = 2×4=8，INTERNAL = 1×4=4
      const refreshedProc = refreshed.find((r) => r.componentRole === "PROCUREMENT")!;
      const refreshedInternal = refreshed.find((r) => r.componentRole === "INTERNAL")!;
      expect(refreshedProc.quantity).toBe(8);
      expect(refreshedInternal.quantity).toBe(4);
      expect(refreshedProc.supersedesRequirementId).toBe(refreshResult.cancelledIds[0]);
      // P2：新增 INTERNAL 组件无前驱，不应回退关联旧 PROCUREMENT
      expect(refreshedInternal.supersedesRequirementId).toBeNull();

      // P1：仅改订单单位（数量不变）→ 锁定失败
      const unitOrder = await prisma.$transaction((tx) =>
        createOrderWithProject(tx, {
          title: "订单单位变更锁定回归",
          status: "DRAFT",
          techSupport: "测试",
          profileId: profile.id,
          lines: [{
            itemName: qtyRootSku.name,
            amount: 200000, quantity: 2, unitPrice: 100000,
            productSkuId: qtyRootSku.id,
            productCodeSnapshot: product.productCode,
            skuCodeSnapshot: qtyRootSku.skuCode,
            unit: "样本",
          }],
          createdById: "user-admin",
        }),
      );
      const unitLineId = unitOrder.order.lines![0].id;
      // qtyRootSku 此时已有 PROCUREMENT+INTERNAL，候选 2 行
      const unitCandidate = await buildSupplyPlanCandidates({
        orderId: unitOrder.order.id, mode: PLAN_TYPE.LOWEST_COST,
      });
      expect(unitCandidate.readyToLock).toBe(true);
      const unitPlanId = await createSupplyPlanFromCandidate(unitCandidate, "user-admin");
      await prisma.orderLine.update({
        where: { id: unitLineId },
        data: { unit: "盒" },
      });
      await expect(
        lockSupplyPlan({ planId: unitPlanId, actorUserId: "user-admin" }),
      ).rejects.toBeInstanceOf(SupplyPlanLockError);

      // P1：订单行根 SKU 绑定变更 → 锁定失败
      const bindOrder = await prisma.$transaction((tx) =>
        createOrderWithProject(tx, {
          title: "根SKU绑定变更锁定回归",
          status: "DRAFT",
          techSupport: "测试",
          profileId: profile.id,
          lines: [{
            itemName: qtyRootSku.name,
            amount: 200000, quantity: 2, unitPrice: 100000,
            productSkuId: qtyRootSku.id,
            productCodeSnapshot: product.productCode,
            skuCodeSnapshot: qtyRootSku.skuCode,
            unit: "样本",
          }],
          createdById: "user-admin",
        }),
      );
      const bindLineId = bindOrder.order.lines![0].id;
      const bindCandidate = await buildSupplyPlanCandidates({
        orderId: bindOrder.order.id, mode: PLAN_TYPE.LOWEST_COST,
      });
      const bindPlanId = await createSupplyPlanFromCandidate(bindCandidate, "user-admin");
      await prisma.orderLineServiceMapping.update({
        where: { orderLineId: bindLineId },
        data: { productSkuId: procSku.id },
      });
      await expect(
        lockSupplyPlan({ planId: bindPlanId, actorUserId: "user-admin" }),
      ).rejects.toBeInstanceOf(SupplyPlanLockError);

      // P2：兼容包装按 identity 返回，而非整组首项
      await cancelSupplyPlan({ planId: unitPlanId, actorUserId: "user-admin", reason: "测兼容包装" });
      const unitOpenReqs = await prisma.supplyRequirement.findMany({
        where: { orderLineId: unitLineId, status: "OPEN" },
      });
      expect(unitOpenReqs.length).toBeGreaterThanOrEqual(2);
      const nonFirst = unitOpenReqs.find((r) => r.id !== unitOpenReqs[0].id)!;
      const { refreshOpenRequirementForActor } = await import(
        "@/lib/products/application/supply-requirements"
      );
      const wrapped = await refreshOpenRequirementForActor(
        ADMIN_ACTOR,
        { channel: "web" },
        nonFirst.id,
      );
      expect(wrapped.cancelled).toBe(nonFirst.id);
      const createdRow = await prisma.supplyRequirement.findUnique({
        where: { id: wrapped.created },
        select: { productSkuId: true, componentRole: true },
      });
      expect(createdRow).not.toBeNull();
      expect(createdRow!.productSkuId).toBe(nonFirst.productSkuId);
      expect(createdRow!.componentRole).toBe(nonFirst.componentRole);

      // 刷新后可重新生成并锁定
      const afterRefreshCandidate = await buildSupplyPlanCandidates({
        orderId: qtyOrder.order.id, mode: PLAN_TYPE.LOWEST_COST,
      });
      expect(afterRefreshCandidate.readyToLock).toBe(true);
      expect(afterRefreshCandidate.lines).toHaveLength(2);
      const afterRefreshPlanId = await createSupplyPlanFromCandidate(
        afterRefreshCandidate,
        "user-admin",
      );
      const lockedAfterRefresh = await lockSupplyPlan({
        planId: afterRefreshPlanId,
        actorUserId: "user-admin",
      });
      expect(lockedAfterRefresh.status).toBe("LOCKED");

      // ═══════════════════════════════════════════════════════════════
      // P1 回归：BOM 含无报价 OPTIONAL → 预览/创建成功，OPTIONAL 保持 OPEN
      // ═══════════════════════════════════════════════════════════════
      const { sku: optRootSku } = await createSkuForActor(ADMIN_ACTOR, {
        productId: product.id, name: "含可选组件套餐", standardUnit: "样本",
        status: "ACTIVE", sellable: true, purchasable: false,
      });
      const { sku: optSku } = await createSkuForActor(ADMIN_ACTOR, {
        productId: product.id, name: "可选加项", standardUnit: "样本",
        status: "ACTIVE", sellable: false, purchasable: true,
      });
      await prisma.productSkuComponent.createMany({
        data: [
          {
            parentSkuId: optRootSku.id, componentSkuId: procSku.id,
            quantity: 1, role: "PROCUREMENT", active: true,
          },
          {
            parentSkuId: optRootSku.id, componentSkuId: optSku.id,
            quantity: 1, role: "OPTIONAL", active: true,
          },
        ],
      });
      // optSku 故意不建报价

      const optOrder = await prisma.$transaction((tx) =>
        createOrderWithProject(tx, {
          title: "无报价OPTIONAL回归",
          status: "DRAFT",
          techSupport: "测试",
          profileId: profile.id,
          lines: [{
            itemName: optRootSku.name,
            amount: 100000, quantity: 2, unitPrice: 50000,
            productSkuId: optRootSku.id,
            productCodeSnapshot: product.productCode,
            skuCodeSnapshot: optRootSku.skuCode,
            unit: "样本",
          }],
          createdById: "user-admin",
        }),
      );
      const optCandidate = await buildSupplyPlanCandidates({
        orderId: optOrder.order.id, mode: PLAN_TYPE.LOWEST_COST,
      });
      expect(optCandidate.readyToLock).toBe(true);
      expect(optCandidate.blockingIssues).toEqual([]);
      expect(optCandidate.lines).toHaveLength(1);
      expect(optCandidate.lines[0].role).toBe("PROCUREMENT");
      expect(optCandidate.lines.some((l) => l.role === "OPTIONAL")).toBe(false);

      const optPlanId = await createSupplyPlanFromCandidate(optCandidate, "user-admin");
      expect(optPlanId).toBeTruthy();

      const optReqs = await prisma.supplyRequirement.findMany({
        where: { orderId: optOrder.order.id },
      });
      expect(optReqs).toHaveLength(2);
      const optProcReq = optReqs.find((r) => r.componentRole === "PROCUREMENT")!;
      const optOptionalReq = optReqs.find((r) => r.componentRole === "OPTIONAL")!;
      expect(optProcReq.status).toBe("PLANNED");
      expect(optOptionalReq.status).toBe("OPEN");
      expect(optOptionalReq.productSkuId).toBe(optSku.id);

      const optPlanLines = await prisma.supplyPlanLine.findMany({ where: { planId: optPlanId } });
      expect(optPlanLines).toHaveLength(1);
      expect(optPlanLines[0].supplyRequirementId).toBe(optProcReq.id);
    });
  }, 120_000);
});

/**
 * 供应方案候选生成——buildSupplyPlanCandidates()。
 *
 * 设计文档 §6.4 供应方案生成流程（review #1/#2 重构为 requirement 粒度 + 纯读预览）：
 * 1. 读取订单行 SKU 绑定（productSkuId 优先，serviceKey legacy fallback）。
 * 2. **纯读**展开 BOM：组合 SKU 按组件拆成多条候选行（模拟，不写 DB）。
 * 3. 对每个可采购需求按 productSkuId 查有效报价，各自选最优。
 * 4. 应用数量门槛、有效期、供应商状态、货期约束。
 * 5. 生成最低成本/最快/均衡/手工方案。
 *
 * review #2 修正：预览阶段**不写数据库**（不创建 SupplyRequirement）。
 * BOM 展开在内存中模拟，definitionHash 也在内存中计算。
 * 实际的需求持久化在 createSupplyPlanFromCandidate（授权写）中执行。
 *
 * 方案类型：
 *   LOWEST_COST：每需求选最低报价
 *   FASTEST：每需求选最短货期
 *   BALANCED：综合评分（价格 + 货期）
 */
import { prisma } from "@/lib/prisma";
import { ConflictError } from "@/lib/application/errors";
import {
  PLAN_TYPE,
  SUPPLY_PLAN_STATUS,
  QUOTE_STATUS,
  MAPPING_CONFIDENCE_THRESHOLD,
  type PlanType,
} from "./constants";
import { SKU_COMPONENT_ROLE, type SkuComponentRole } from "@/lib/products/constants";
import {
  buildBomComponentPath,
  computeDefinitionHash,
} from "@/lib/products/application/supply-requirements";
import type {
  BuildSupplyPlanCandidatesParams,
  CandidateLine,
  CandidateQuote,
  SupplyPlanCandidate,
} from "./types";

/**
 * 按 productSkuId 查询有效供应商报价，并按数量门槛过滤。
 */
async function queryQuotesForSku(
  productSkuId: string,
  requiredQuantity: number,
  constraints?: BuildSupplyPlanCandidatesParams["constraints"],
): Promise<CandidateQuote[]> {
  const now = new Date();
  const quoteWhere: Record<string, unknown> = {
    productSkuId,
    status: QUOTE_STATUS.ACTIVE,
    supplier: { archived: false, status: "ACTIVE" },
    OR: [
      { validFrom: null, validTo: null },
      { validFrom: null, validTo: { gte: now } },
      { validFrom: { lte: now }, validTo: null },
      { validFrom: { lte: now }, validTo: { gte: now } },
    ],
  };
  if (constraints?.supplierIds?.length) quoteWhere.supplierId = { in: constraints.supplierIds };
  if (constraints?.excludedSupplierIds?.length) {
    const excl = constraints.excludedSupplierIds as string[];
    quoteWhere.supplierId = { notIn: excl };
  }

  const dbQuotes = await prisma.supplierQuote.findMany({
    where: quoteWhere,
    select: {
      id: true, supplierId: true, supplier: { select: { name: true } },
      quotedPrice: true, negotiatedPrice: true, leadDays: true, discountRate: true,
      minQuantity: true,
    },
  });
  return dbQuotes
    .filter((q) => q.minQuantity == null || q.minQuantity <= requiredQuantity)
    .map((q) => ({
      quoteId: q.id, supplierId: q.supplierId, supplierName: q.supplier.name,
      unitCost: q.negotiatedPrice ?? q.quotedPrice, leadDays: q.leadDays,
      discountRate: q.discountRate, minQuantity: q.minQuantity,
    }));
}

/**
 * 按 legacy serviceKey 查询有效供应商报价（兼容期 fallback）。
 */
async function queryQuotesForLegacyKey(
  serviceKey: string,
  requiredQuantity: number,
  constraints?: BuildSupplyPlanCandidatesParams["constraints"],
): Promise<CandidateQuote[]> {
  const now = new Date();
  const quoteWhere: Record<string, unknown> = {
    serviceKey,
    status: QUOTE_STATUS.ACTIVE,
    supplier: { archived: false, status: "ACTIVE" },
    OR: [
      { validFrom: null, validTo: null },
      { validFrom: null, validTo: { gte: now } },
      { validFrom: { lte: now }, validTo: null },
      { validFrom: { lte: now }, validTo: { gte: now } },
    ],
  };
  if (constraints?.supplierIds?.length) quoteWhere.supplierId = { in: constraints.supplierIds };
  if (constraints?.excludedSupplierIds?.length) {
    const excl = constraints.excludedSupplierIds as string[];
    quoteWhere.supplierId = { notIn: excl };
  }

  const dbQuotes = await prisma.supplierQuote.findMany({
    where: quoteWhere,
    select: {
      id: true, supplierId: true, supplier: { select: { name: true } },
      quotedPrice: true, negotiatedPrice: true, leadDays: true, discountRate: true,
      minQuantity: true,
    },
  });
  return dbQuotes
    .filter((q) => q.minQuantity == null || q.minQuantity <= requiredQuantity)
    .map((q) => ({
      quoteId: q.id, supplierId: q.supplierId, supplierName: q.supplier.name,
      unitCost: q.negotiatedPrice ?? q.quotedPrice, leadDays: q.leadDays,
      discountRate: q.discountRate, minQuantity: q.minQuantity,
    }));
}

/**
 * 对单需求候选报价按 mode 排序，返回最优。
 */
function pickBestQuote(quotes: CandidateQuote[], mode: PlanType): CandidateQuote | null {
  if (quotes.length === 0) return null;
  const sorted = [...quotes];
  if (mode === PLAN_TYPE.LOWEST_COST) {
    sorted.sort((a, b) => a.unitCost - b.unitCost);
  } else if (mode === PLAN_TYPE.FASTEST) {
    sorted.sort((a, b) => (a.leadDays ?? 999) - (b.leadDays ?? 999));
  } else {
    // BALANCED：价格和货期各占权重（价格 70%，货期 30%）
    const maxCost = Math.max(...sorted.map((q) => q.unitCost), 1);
    const maxLead = Math.max(...sorted.map((q) => q.leadDays ?? 0), 1);
    sorted.sort((a, b) => {
      const scoreA = 0.7 * (a.unitCost / maxCost) + 0.3 * ((a.leadDays ?? 0) / maxLead);
      const scoreB = 0.7 * (b.unitCost / maxCost) + 0.3 * ((b.leadDays ?? 0) / maxLead);
      return scoreA - scoreB;
    });
  }
  return sorted[0];
}

function isProcurementLikeRole(role: string): boolean {
  return role === SKU_COMPONENT_ROLE.PROCUREMENT || role === SKU_COMPONENT_ROLE.LOGISTICS;
}

/**
 * 生成供应方案候选（纯读预览，不写数据库）。
 *
 * review #2：预览阶段不创建 SupplyRequirement。BOM 展开在内存中模拟，
 * definitionHash 也在内存中计算（与持久化时使用的算法一致）。
 * 实际需求持久化在 createSupplyPlanFromCandidate 中执行。
 */
export async function buildSupplyPlanCandidates(
  params: BuildSupplyPlanCandidatesParams,
): Promise<SupplyPlanCandidate> {
  const { orderId, mode, constraints } = params;

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      deleted: true,
      lines: {
        orderBy: { sortOrder: "asc" },
        select: {
          id: true,
          itemName: true,
          spec: true,
          unit: true,
          quantity: true,
          productCodeSnapshot: true,
          skuCodeSnapshot: true,
          serviceMapping: {
            select: { productSkuId: true, serviceKey: true, confidence: true, source: true },
          },
        },
      },
    },
  });

  if (!order || order.deleted) {
    throw new Error("NOT_FOUND");
  }

  // 批量预取订单行绑定 SKU 的 BOM 组件（纯读，一次查询）
  const orderLineSkuIds = order.lines
    .map((l) => l.serviceMapping?.productSkuId)
    .filter((id): id is string => !!id);
  const skuWithBomMap = new Map<string, {
    id: string; skuCode: string; name: string; spec: string | null; standardUnit: string;
    product: { productCode: string };
    parentComponents: Array<{
      componentSkuId: string;
      quantity: number;
      role: string;
      componentSku: {
        skuCode: string;
        name: string;
        spec: string | null;
        standardUnit: string;
        product: { productCode: string };
      };
    }>;
  }>();
  if (orderLineSkuIds.length > 0) {
    const skus = await prisma.productSku.findMany({
      where: { id: { in: orderLineSkuIds } },
      include: {
        product: { select: { productCode: true } },
        parentComponents: {
          where: { active: true },
          include: {
            componentSku: {
              select: {
                skuCode: true,
                name: true,
                spec: true,
                standardUnit: true,
                product: { select: { productCode: true } },
              },
            },
          },
        },
      },
    });
    for (const s of skus) skuWithBomMap.set(s.id, s);
  }

  const lines: CandidateLine[] = [];
  const blockingIssues: string[] = [];

  for (const ol of order.lines) {
    const productSkuId = ol.serviceMapping?.productSkuId ?? null;
    const serviceKey = ol.serviceMapping?.serviceKey ?? null;
    const confidence = ol.serviceMapping?.confidence ?? null;
    const needsConfirmation =
      (!productSkuId && !serviceKey) || (confidence != null && confidence < MAPPING_CONFIDENCE_THRESHOLD);

    const orderQty = ol.quantity ?? 1;
    const orderUnit = ol.unit ?? "项";

    // review #1：按需求粒度生成候选行。组合 SKU 的每个组件独立一行。
    if (productSkuId) {
      const sku = skuWithBomMap.get(productSkuId);
      if (!sku) {
        blockingIssues.push(`订单行「${ol.itemName}」绑定的 SKU 不存在`);
        continue;
      }
      const rootBomComponents = sku.parentComponents.map((c) => ({
        componentSkuId: c.componentSkuId, quantity: c.quantity, role: c.role,
      }));

      if (sku.parentComponents.length === 0) {
        // 普通 SKU：1 条 DIRECT 需求
        const hash = computeDefinitionHash({ productSkuId, quantity: orderQty, unit: orderUnit });
        const quotes = await queryQuotesForSku(productSkuId, orderQty, constraints);
        const filtered = constraints?.maxLeadDays != null
          ? quotes.filter((q) => q.leadDays == null || q.leadDays <= constraints.maxLeadDays!)
          : quotes;
        const selectedQuote = pickBestQuote(filtered, mode);
        const lineAmount = selectedQuote ? Math.round(orderQty * selectedQuote.unitCost) : 0;
        if (needsConfirmation) {
          blockingIssues.push(`订单行「${ol.itemName}」未确认映射，需先在目录绑定`);
        } else if (!selectedQuote) {
          blockingIssues.push(`订单行「${ol.itemName}」（${sku.skuCode}）无有效供应商报价`);
        }
        lines.push({
          orderLineId: ol.id, supplyRequirementId: null, source: "DIRECT",
          productSkuId, rootSkuId: productSkuId, componentPath: null,
          orderQuantity: orderQty, quantity: orderQty, unit: orderUnit, definitionHash: hash,
          role: null,
          productCodeSnapshot: sku.product.productCode,
          skuCodeSnapshot: sku.skuCode,
          itemName: sku.name, spec: sku.spec, serviceKey: null,
          confidence, needsConfirmation, quotes: filtered, selectedQuote, lineAmount,
        });
      } else {
        // 组合 SKU：每个 active BOM 组件一条 BOM 需求（按 role 分流履约）
        for (const comp of sku.parentComponents) {
          const role = comp.role as SkuComponentRole;
          const compQty = comp.quantity * orderQty;
          const compUnit = comp.componentSku.standardUnit;
          const componentPath = buildBomComponentPath(comp.componentSkuId, role);
          // hash 基于根 SKU 的完整 BOM；单位用组件标准单位；订单行单位单独纳入（与持久化一致）
          const hash = computeDefinitionHash({
            productSkuId, quantity: compQty, unit: compUnit, rootOrderUnit: orderUnit, bomComponents: rootBomComponents,
          });
          const snapshots = {
            productCodeSnapshot: comp.componentSku.product.productCode,
            skuCodeSnapshot: comp.componentSku.skuCode,
          };

          if (role === SKU_COMPONENT_ROLE.INTERNAL) {
            lines.push({
              orderLineId: ol.id, supplyRequirementId: null, source: "BOM",
              productSkuId: comp.componentSkuId, rootSkuId: productSkuId,
              componentPath,
              orderQuantity: orderQty, quantity: compQty, unit: compUnit, definitionHash: hash,
              role,
              ...snapshots,
              itemName: comp.componentSku.name, spec: comp.componentSku.spec,
              serviceKey: null, confidence, needsConfirmation,
              quotes: [], selectedQuote: null, lineAmount: 0,
            });
            continue;
          }

          const quotes = await queryQuotesForSku(comp.componentSkuId, compQty, constraints);
          const filtered = constraints?.maxLeadDays != null
            ? quotes.filter((q) => q.leadDays == null || q.leadDays <= constraints.maxLeadDays!)
            : quotes;
          const selectedQuote = pickBestQuote(filtered, mode);
          const lineAmount = selectedQuote ? Math.round(compQty * selectedQuote.unitCost) : 0;

          if (role === SKU_COMPONENT_ROLE.OPTIONAL) {
            if (!selectedQuote) continue;
            lines.push({
              orderLineId: ol.id, supplyRequirementId: null, source: "BOM",
              productSkuId: comp.componentSkuId, rootSkuId: productSkuId,
              componentPath,
              orderQuantity: orderQty, quantity: compQty, unit: compUnit, definitionHash: hash,
              role,
              ...snapshots,
              itemName: comp.componentSku.name, spec: comp.componentSku.spec,
              serviceKey: null, confidence, needsConfirmation,
              quotes: filtered, selectedQuote, lineAmount,
            });
            continue;
          }

          if (!selectedQuote) {
            blockingIssues.push(
              `组件「${comp.componentSku.name}」（${comp.componentSku.skuCode}）无有效供应商报价`,
            );
          }
          lines.push({
            orderLineId: ol.id, supplyRequirementId: null, source: "BOM",
            productSkuId: comp.componentSkuId, rootSkuId: productSkuId,
            componentPath,
            orderQuantity: orderQty, quantity: compQty, unit: compUnit, definitionHash: hash,
            role: isProcurementLikeRole(role) ? role : SKU_COMPONENT_ROLE.PROCUREMENT,
            ...snapshots,
            itemName: comp.componentSku.name, spec: comp.componentSku.spec,
            serviceKey: null, confidence, needsConfirmation,
            quotes: filtered, selectedQuote, lineAmount,
          });
        }
      }
    } else if (serviceKey) {
      // legacy fallback：无 productSkuId，直接按 serviceKey 查（无 BOM 展开）
      const quotes = await queryQuotesForLegacyKey(serviceKey, orderQty, constraints);
      const filtered = constraints?.maxLeadDays != null
        ? quotes.filter((q) => q.leadDays == null || q.leadDays <= constraints.maxLeadDays!)
        : quotes;
      const selectedQuote = pickBestQuote(filtered, mode);
      const lineAmount = selectedQuote ? Math.round(orderQty * selectedQuote.unitCost) : 0;
      if (needsConfirmation) {
        blockingIssues.push(`订单行「${ol.itemName}」未映射到产品 SKU，需先在目录绑定`);
      } else if (!selectedQuote) {
        blockingIssues.push(`订单行「${ol.itemName}」（${serviceKey}）无有效供应商报价`);
      }
      lines.push({
        orderLineId: ol.id, supplyRequirementId: null, source: "DIRECT",
        productSkuId: null, rootSkuId: null, componentPath: null,
        orderQuantity: orderQty, quantity: orderQty, unit: orderUnit, definitionHash: "",
        role: null,
        productCodeSnapshot: null,
        skuCodeSnapshot: null,
        itemName: ol.itemName, spec: ol.spec, serviceKey,
        confidence, needsConfirmation, quotes: filtered, selectedQuote, lineAmount,
      });
    } else {
      blockingIssues.push(`订单行「${ol.itemName}」未映射到产品 SKU`);
    }
  }

  const totalQuotedCost = lines.reduce((sum, l) => sum + l.lineAmount, 0);
  const expectedLeadDays =
    lines.length > 0
      ? Math.max(...lines.map((l) => l.selectedQuote?.leadDays ?? 0))
      : null;
  const supplierSet = new Set(
    lines.filter((l) => l.selectedQuote).map((l) => l.selectedQuote!.supplierId),
  );

  if (constraints?.maxSuppliers != null && supplierSet.size > constraints.maxSuppliers) {
    blockingIssues.push(
      `方案涉及 ${supplierSet.size} 个供应商，超过最大限制 ${constraints.maxSuppliers}`,
    );
  }

  const readyToLock = blockingIssues.length === 0 && lines.length > 0;

  return {
    orderId,
    mode,
    planType: mode,
    lines,
    totalQuotedCost,
    expectedLeadDays,
    supplierCount: supplierSet.size,
    readyToLock,
    blockingIssues,
  };
}

/**
 * 从候选创建 SupplyPlan（草稿状态），返回 planId。
 *
 * review #1：这是授权写操作。在此处持久化 SupplyRequirement（展开 BOM），
 * 将每条需求关联到对应的 SupplyPlanLine 并标记 PLANNED。
 * 候选行现在是 requirement 粒度，每个候选行 = 一条需求 + 一条方案行。
 *
 * legacy（仅 serviceKey）：不进入 ProductSku 展开，方案行无 supplyRequirementId。
 * 多草稿：expand 复用 OPEN/PLANNED 完整需求组，不重复创建。
 *
 * P1：创建事务内必须用 live OrderLine（数量/单位/根 SKU）展开，并与候选
 * definitionHash/quantity/unit 逐项比对；不一致抛 ConflictError，整笔回滚，
 * 避免写出「需求已 PLANNED 但方案行仍是旧定义、必然无法锁定」的草稿。
 */
export async function createSupplyPlanFromCandidate(
  candidate: SupplyPlanCandidate,
  actorUserId: string,
  name?: string,
): Promise<string> {
  return prisma.$transaction(async (tx) => {
    const plan = await tx.supplyPlan.create({
      data: {
        orderId: candidate.orderId,
        name: name || `${candidate.planType} 方案`,
        status: SUPPLY_PLAN_STATUS.DRAFT,
        planType: candidate.planType,
        totalQuotedCost: candidate.totalQuotedCost,
        expectedLeadDays: candidate.expectedLeadDays,
        createdById: actorUserId,
      },
    });

    const processedOrderLines = new Set<string>();
    // orderLineId → 展开后的需求列表（含 componentRole / 定义字段）
    const expandedByOrderLine = new Map<string, Array<{
      id: string;
      productSkuId: string;
      componentRole: string | null;
      source: string;
      definitionHash: string;
      quantity: number;
      unit: string;
    }>>();

    for (const line of candidate.lines) {
      const isInternal = line.role === SKU_COMPONENT_ROLE.INTERNAL;
      if (!line.selectedQuote && !isInternal) continue;

      let supplyRequirementId: string | null = null;
      if (line.productSkuId && line.rootSkuId && (line.source === "DIRECT" || line.source === "BOM")) {
        if (!processedOrderLines.has(line.orderLineId)) {
          const { expandSupplyRequirementsInTx } = await import("@/lib/products/application/supply-requirements");
          // fail-closed：必须有 live OrderLine、数量、根 SKU；禁止回退候选快照
          const orderLineLive = await tx.orderLine.findUnique({
            where: { id: line.orderLineId },
            select: {
              quantity: true,
              unit: true,
              serviceMapping: { select: { productSkuId: true } },
            },
          });
          if (!orderLineLive) {
            throw new ConflictError("订单行不存在，无法创建供应方案，请重新生成候选");
          }
          if (orderLineLive.quantity == null) {
            throw new ConflictError("订单行数量为空，无法创建供应方案");
          }
          const liveRootSkuId = orderLineLive.serviceMapping?.productSkuId ?? null;
          if (!liveRootSkuId || liveRootSkuId !== line.rootSkuId) {
            throw new ConflictError(
              "订单行产品绑定已变更或缺失，请重新生成供应方案候选",
            );
          }
          if (orderLineLive.quantity !== line.orderQuantity) {
            throw new ConflictError(
              "订单行数量已变更，请重新生成供应方案候选后再创建",
            );
          }

          const expandUnit = orderLineLive.unit ?? "项";
          const expanded = await expandSupplyRequirementsInTx(
            tx,
            candidate.orderId,
            line.orderLineId,
            liveRootSkuId,
            orderLineLive.quantity,
            expandUnit,
          );

          // 同订单行：候选中已纳入的需求必须与 live 展开一致；
          // 允许额外的 expanded 仅为未选中的 OPTIONAL（无报价时预览会省略）。
          // PROCUREMENT / LOGISTICS / INTERNAL 缺失则 fail-closed。
          const siblingLines = candidate.lines.filter(
            (l) =>
              l.orderLineId === line.orderLineId &&
              l.productSkuId &&
              l.rootSkuId &&
              (l.source === "DIRECT" || l.source === "BOM") &&
              (l.selectedQuote || l.role === SKU_COMPONENT_ROLE.INTERNAL),
          );
          const matchedExpandedIds = new Set<string>();
          for (const sib of siblingLines) {
            const match = expanded.find(
              (r) =>
                r.productSkuId === sib.productSkuId &&
                (r.componentRole ?? null) === (sib.role ?? null),
            );
            if (
              !match ||
              match.definitionHash !== sib.definitionHash ||
              match.quantity !== sib.quantity ||
              match.unit !== sib.unit
            ) {
              throw new ConflictError(
                "候选方案定义与当前订单/BOM 不一致，请重新生成供应方案候选后再创建",
              );
            }
            matchedExpandedIds.add(match.id);
          }
          for (const exp of expanded) {
            if (matchedExpandedIds.has(exp.id)) continue;
            if (exp.componentRole === SKU_COMPONENT_ROLE.OPTIONAL) {
              // 无报价 OPTIONAL：展开会创建 OPEN 需求，但不进方案行 — 合法
              continue;
            }
            throw new ConflictError(
              "供应需求组存在未纳入候选的必选组件（可能 BOM 已变更），请重新生成候选",
            );
          }

          expandedByOrderLine.set(
            line.orderLineId,
            expanded.map((r) => ({
              id: r.id,
              productSkuId: r.productSkuId,
              componentRole: r.componentRole,
              source: r.source,
              definitionHash: r.definitionHash,
              quantity: r.quantity,
              unit: r.unit,
            })),
          );
          processedOrderLines.add(line.orderLineId);
        }

        const expanded = expandedByOrderLine.get(line.orderLineId) ?? [];
        const match = expanded.find(
          (r) =>
            r.productSkuId === line.productSkuId &&
            (r.componentRole ?? null) === (line.role ?? null),
        );
        if (match) supplyRequirementId = match.id;
      }

      if (supplyRequirementId) {
        await tx.supplyRequirement.updateMany({
          where: { id: supplyRequirementId, status: "OPEN" },
          data: { status: "PLANNED" },
        });
      }

      await tx.supplyPlanLine.create({
        data: {
          planId: plan.id,
          orderLineId: line.orderLineId,
          supplyRequirementId,
          supplierId: line.selectedQuote?.supplierId ?? null,
          quoteId: line.selectedQuote?.quoteId ?? null,
          productSkuId: line.productSkuId,
          productCodeSnapshot: line.productCodeSnapshot,
          skuCodeSnapshot: line.skuCodeSnapshot,
          serviceKeySnapshot: line.serviceKey,
          itemName: line.itemName,
          spec: line.spec,
          unit: line.unit,
          quantity: line.quantity,
          unitCost: line.selectedQuote?.unitCost ?? 0,
          amount: line.lineAmount,
          discountRate: line.selectedQuote?.discountRate ?? null,
          leadDays: line.selectedQuote?.leadDays ?? null,
          definitionHash: line.definitionHash || null,
          componentRole: line.role,
        },
      });
    }

    return plan.id;
  });
}

/**
 * 供应需求（SupplyRequirement）canonical service。
 *
 * 对应设计文档 §6.2、§6.3。订单行或 BOM 展开的采购需求，是 SupplyPlanLine 的上游。
 *
 * 状态机（§6.3）：
 *  - OPEN：尚未进入供应方案，可因 SKU/数量修改或"同步最新 BOM"重新展开；
 *  - PLANNED：已进入草稿/报价/议价方案，需求冻结；输入变化时旧方案 SUPERSEDED/CANCELLED，
 *    旧需求保留审计，生成新 revision；
 *  - LOCKED：已形成正式供应承诺，永不原地修改；订单修订只能生成增量/冲销需求；
 *  - CANCELLED：不参与新方案和成本生成，但保留历史。
 *
 * definitionHash（§6.3）：
 *  - 生成需求时计算 SKU+BOM+数量+单位 的哈希；
 *  - 锁定方案时事务内复核，不一致 → 409。
 *
 * 本模块是 canonical service，允许 Prisma。
 */
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import type { BusinessActor, InvocationContext } from "@/lib/application/actor";
import {
  ForbiddenError,
  ValidationError,
  NotFoundError,
  ConflictError,
} from "@/lib/application/errors";
import { assertAgentCanWriteOrder } from "@/lib/orders/application/technical-owner-gate";
import { PRODUCT_STATUS } from "@/lib/products/constants";
import { createHash } from "node:crypto";

type TransactionClient = Prisma.TransactionClient;

export const SUPPLY_REQUIREMENT_STATUS = {
  OPEN: "OPEN",
  PLANNED: "PLANNED",
  LOCKED: "LOCKED",
  CANCELLED: "CANCELLED",
} as const;
export type SupplyRequirementStatus = (typeof SUPPLY_REQUIREMENT_STATUS)[keyof typeof SUPPLY_REQUIREMENT_STATUS];

export const SUPPLY_REQUIREMENT_SOURCE = {
  DIRECT: "DIRECT",
  BOM: "BOM",
} as const;

export type ExpandedSupplyRequirement = {
  id: string;
  status: string;
  source: string;
  productSkuId: string;
  componentRole: string | null;
  definitionHash: string;
  quantity: number;
  unit: string;
};

function assertCanManage(actor: BusinessActor): void {
  if (actor.role !== "ADMIN" && actor.role !== "USER") {
    throw new ForbiddenError("仅内部员工可管理供应需求");
  }
}

/** BOM 组件路径：含 role，区分同 componentSkuId 多角色 */
export function buildBomComponentPath(componentSkuId: string, role: string): string {
  return `root>${componentSkuId}:${role}`;
}

/**
 * 计算供应需求定义哈希。
 * 输入：SKU id + BOM 组件快照（如有）+ 数量 + 单位 + 可选根订单行单位。
 * 同一输入永远产生同一哈希；任一变化哈希变化。
 *
 * BOM 需求的 `unit` 是组件 standardUnit；`rootOrderUnit` 是订单行单位，
 * 用于检测「仅订单单位变化、BOM 结构不变」的漂移（设计 §6.3）。
 */
export function computeDefinitionHash(input: {
  productSkuId: string;
  quantity: number;
  unit: string;
  /** 根订单行单位；BOM 需求必须传入，DIRECT 可省略（此时 unit 即为订单单位）。 */
  rootOrderUnit?: string;
  bomComponents?: Array<{ componentSkuId: string; quantity: number; role: string }>;
}): string {
  const payload: Record<string, unknown> = {
    sku: input.productSkuId,
    qty: Number(input.quantity),
    unit: input.unit,
    bom: (input.bomComponents ?? [])
      .map((c) => ({ id: c.componentSkuId, q: Number(c.quantity), r: c.role }))
      .sort((a, b) => a.id.localeCompare(b.id) || a.r.localeCompare(b.r)),
  };
  if (input.rootOrderUnit != null) {
    payload.rootOrderUnit = input.rootOrderUnit;
  }
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 32);
}

function requirementIdentityKey(productSkuId: string, componentRole: string | null): string {
  return `${productSkuId}::${componentRole ?? ""}`;
}

/**
 * 从订单行展开供应需求（设计 §6.4 buildSupplyPlanCandidates 第 2 步）。
 *
 * - 普通 SKU（无 BOM）：生成 1 条 DIRECT 需求；
 * - 组合 SKU（有 active BOM）：按组件生成多条 BOM 需求，INTERNAL 组件进入内部成本。
 *
 * 幂等：同 orderLineId 的完整 OPEN/PLANNED 需求组（按 productSkuId+componentRole+definitionHash）
 * 可被多个草稿方案共享复用；组不完整或 hash 不一致时抛 ConflictError，避免产生重复 revision=1。
 *
 * Agent channel 写时校验 technical owner。
 */
export async function expandSupplyRequirementsInTx(
  tx: TransactionClient,
  orderId: string,
  orderLineId: string,
  productSkuId: string,
  quantity: number,
  unit: string,
  opts: { actor?: BusinessActor; invocation?: InvocationContext } = {},
): Promise<ExpandedSupplyRequirement[]> {
  // Agent channel：technical owner gate（设计 §10.1）
  if (opts.actor && opts.invocation) {
    await assertAgentCanWriteOrder(opts.actor, opts.invocation, orderId, { tx });
  }

  // 校验 SKU active
  const sku = await tx.productSku.findUnique({
    where: { id: productSkuId },
    include: {
      product: { select: { productCode: true, name: true } },
      parentComponents: {
        where: { active: true },
        include: {
          componentSku: {
            include: { product: { select: { productCode: true } } },
          },
        },
      },
    },
  });
  if (!sku || sku.status !== PRODUCT_STATUS.ACTIVE) {
    throw new ValidationError("供应需求展开失败：SKU 不存在或非 ACTIVE");
  }

  type ExpectedReq = {
    productSkuId: string;
    componentRole: string | null;
    source: string;
    componentPath: string | null;
    quantity: number;
    unit: string;
    definitionHash: string;
    nameSnapshot: string;
    skuCodeSnapshot: string;
    productCodeSnapshot: string | null;
    rootSkuId: string;
  };

  const expected: ExpectedReq[] = [];

  if (sku.parentComponents.length === 0) {
    const hash = computeDefinitionHash({ productSkuId, quantity, unit });
    expected.push({
      productSkuId,
      componentRole: null,
      source: SUPPLY_REQUIREMENT_SOURCE.DIRECT,
      componentPath: null,
      quantity,
      unit,
      definitionHash: hash,
      nameSnapshot: sku.name,
      skuCodeSnapshot: sku.skuCode,
      productCodeSnapshot: sku.product.productCode,
      rootSkuId: productSkuId,
    });
  } else {
    const rootBomComponents = sku.parentComponents.map((c) => ({
      componentSkuId: c.componentSkuId,
      quantity: c.quantity,
      role: c.role,
    }));
    for (const comp of sku.parentComponents) {
      const compQty = comp.quantity * quantity;
      const compUnit = comp.componentSku.standardUnit;
      const hash = computeDefinitionHash({
        productSkuId,
        quantity: compQty,
        unit: compUnit,
        rootOrderUnit: unit,
        bomComponents: rootBomComponents,
      });
      expected.push({
        productSkuId: comp.componentSkuId,
        componentRole: comp.role,
        source: SUPPLY_REQUIREMENT_SOURCE.BOM,
        componentPath: buildBomComponentPath(comp.componentSkuId, comp.role),
        quantity: compQty,
        unit: compUnit,
        definitionHash: hash,
        nameSnapshot: comp.componentSku.name,
        skuCodeSnapshot: comp.componentSku.skuCode,
        productCodeSnapshot: comp.componentSku.product.productCode,
        rootSkuId: productSkuId,
      });
    }
  }

  // 幂等：复用完整的 OPEN/PLANNED 需求组（多草稿方案共享）
  const existing = await tx.supplyRequirement.findMany({
    where: {
      orderLineId,
      status: {
        in: [SUPPLY_REQUIREMENT_STATUS.OPEN, SUPPLY_REQUIREMENT_STATUS.PLANNED],
      },
    },
    select: {
      id: true,
      status: true,
      source: true,
      productSkuId: true,
      componentRole: true,
      definitionHash: true,
      quantity: true,
      unit: true,
    },
  });

  if (existing.length > 0) {
    if (existing.length !== expected.length) {
      throw new ConflictError(
        "订单行已有供应需求组与当前 BOM 组件数不一致，请先取消相关草稿方案后再重新生成",
      );
    }
    const reused: ExpandedSupplyRequirement[] = [];
    for (const exp of expected) {
      const match = existing.find(
        (e) =>
          e.productSkuId === exp.productSkuId &&
          (e.componentRole ?? null) === exp.componentRole &&
          e.definitionHash === exp.definitionHash,
      );
      if (!match) {
        throw new ConflictError(
          "订单行已有供应需求与当前 BOM/数量/单位不一致，请先取消相关草稿方案后刷新需求",
        );
      }
      reused.push(match);
    }
    return reused;
  }

  const created: ExpandedSupplyRequirement[] = [];
  for (const exp of expected) {
    const req = await tx.supplyRequirement.create({
      data: {
        orderId,
        orderLineId,
        productSkuId: exp.productSkuId,
        rootSkuId: exp.rootSkuId,
        source: exp.source,
        componentPath: exp.componentPath,
        componentRole: exp.componentRole,
        quantity: exp.quantity,
        unit: exp.unit,
        status: SUPPLY_REQUIREMENT_STATUS.OPEN,
        nameSnapshot: exp.nameSnapshot,
        skuCodeSnapshot: exp.skuCodeSnapshot,
        productCodeSnapshot: exp.productCodeSnapshot,
        revision: 1,
        definitionHash: exp.definitionHash,
      },
      select: {
        id: true,
        status: true,
        source: true,
        productSkuId: true,
        componentRole: true,
        definitionHash: true,
        quantity: true,
        unit: true,
      },
    });
    created.push(req);
  }

  return created;
}

/**
 * 刷新订单行供应需求组（§6.3 规则 3，P1 修正 review #5）。
 *
 * 以订单行为原子单位：事务内复核整组均为 OPEN → 取消整组 → 按当前订单行数量和当前 BOM
 * 完整展开 revision+1 新需求组。解决旧实现的三个问题：
 *  1. 旧实现只重建单条需求，BOM 增删组件后留下不完整需求组；
 *  2. 旧实现沿用旧 productSkuId/quantity/unit/snapshot，无法应用最新订单数量或 BOM 变化；
 *  3. 旧实现状态检查在事务外，存在 TOCTOU（并发创建方案可能先把需求改成 PLANNED）。
 *
 * PLANNED 需求需先失效未锁定方案；LOCKED 不允许简单重算。
 */
export async function refreshRequirementsForOrderLine(
  actor: BusinessActor,
  invocation: InvocationContext,
  orderLineId: string,
): Promise<{ cancelledIds: string[]; createdIds: string[] }> {
  assertCanManage(actor);

  return prisma.$transaction(async (tx) => {
    // 1. 读取整组 OPEN 需求（事务内，防 TOCTOU）
    const openReqs = await tx.supplyRequirement.findMany({
      where: {
        orderLineId,
        status: SUPPLY_REQUIREMENT_STATUS.OPEN,
      },
      select: {
        id: true,
        orderId: true,
        rootSkuId: true,
        productSkuId: true,
        componentRole: true,
        revision: true,
      },
    });

    if (openReqs.length === 0) {
      // 检查是否有非 OPEN 需求，给出有意义的错误
      const anyReq = await tx.supplyRequirement.findFirst({
        where: { orderLineId },
        select: { status: true },
      });
      if (!anyReq) {
        throw new NotFoundError("该订单行没有供应需求");
      }
      if (anyReq.status === SUPPLY_REQUIREMENT_STATUS.PLANNED) {
        throw new ConflictError("订单行存在 PLANNED 需求，刷新前必须先失效关联的未锁定供应方案");
      }
      if (anyReq.status === SUPPLY_REQUIREMENT_STATUS.LOCKED) {
        throw new ConflictError("订单行存在 LOCKED 需求，不可刷新，请通过订单修订生成增量/冲销需求");
      }
      throw new ValidationError("订单行没有可刷新的 OPEN 需求");
    }

    // 事务内复核：整组必须全部为 OPEN（防并发：事务外有 OPEN 但事务内已被改为 PLANNED）
    const nonOpenCount = await tx.supplyRequirement.count({
      where: {
        orderLineId,
        status: {
          in: [SUPPLY_REQUIREMENT_STATUS.PLANNED, SUPPLY_REQUIREMENT_STATUS.LOCKED],
        },
      },
    });
    if (nonOpenCount > 0) {
      throw new ConflictError(
        "订单行存在 PLANNED/LOCKED 需求（可能并发创建了供应方案），请先失效未锁定方案后再刷新",
      );
    }

    const orderId = openReqs[0].orderId;

    // Agent owner gate（事务内）
    await assertAgentCanWriteOrder(actor, invocation, orderId, { tx });

    // 2. 读取当前订单行数量、单位和绑定的根 SKU
    const orderLine = await tx.orderLine.findUnique({
      where: { id: orderLineId },
      select: {
        quantity: true,
        unit: true,
        serviceMapping: { select: { productSkuId: true } },
      },
    });
    if (!orderLine || orderLine.quantity == null) {
      throw new ValidationError("订单行不存在或数量为空");
    }
    const rootSkuId = orderLine.serviceMapping?.productSkuId ?? openReqs[0].rootSkuId ?? openReqs[0].productSkuId;
    if (!rootSkuId) {
      throw new ValidationError("无法确定订单行绑定的产品 SKU");
    }
    const orderUnit = orderLine.unit ?? "项";

    // 3. 取消整组旧需求（必须带 status=OPEN，防并发已标 PLANNED 仍被取消）
    const cancelledIds = openReqs.map((r) => r.id);
    const cancelResult = await tx.supplyRequirement.updateMany({
      where: {
        id: { in: cancelledIds },
        status: SUPPLY_REQUIREMENT_STATUS.OPEN,
      },
      data: { status: SUPPLY_REQUIREMENT_STATUS.CANCELLED },
    });
    if (cancelResult.count !== cancelledIds.length) {
      throw new ConflictError(
        "刷新期间需求状态已变化（可能并发创建了供应方案），请先失效未锁定方案后再刷新",
      );
    }

    // 4. 计算新 revision（取组内最大 revision + 1）
    const maxRevision = Math.max(...openReqs.map((r) => r.revision));
    const newRevision = maxRevision + 1;

    // 5. 按当前订单行数量和当前 BOM 完整展开新需求组
    const created = await expandSupplyRequirementsInTx(
      tx,
      orderId,
      orderLineId,
      rootSkuId,
      orderLine.quantity,
      orderUnit,
      { actor, invocation },
    );

    // 6. 更新新需求的 revision 和 supersedesRequirementId
    // expandSupplyRequirementsInTx 创建时 revision=1，需要修正为 newRevision
    // 并建立 supersedes 链（按 productSkuId + componentRole 精确匹配）
    const createdIds = created.map((c) => c.id);
    for (let i = 0; i < created.length; i++) {
      const c = created[i];
      // P2 修复：使用 requirementIdentityKey 按 productSkuId + componentRole 匹配，
      // 避免同 SKU 不同 role 的多条需求指向同一旧需求
      const oldMatch = openReqs.find(
        (r) => requirementIdentityKey(r.productSkuId, r.componentRole) === requirementIdentityKey(c.productSkuId, c.componentRole),
      );
      await tx.supplyRequirement.update({
        where: { id: c.id },
        data: {
          revision: newRevision,
          // P2：新增 BOM 组件没有旧 identity 对应项 → supersedes 为 null，不回退到 cancelledIds[0]
          supersedesRequirementId: oldMatch?.id ?? null,
        },
      });
    }

    return { cancelledIds, createdIds };
  });
}

/**
 * @deprecated 使用 {@link refreshRequirementsForOrderLine} 代替。
 * 旧实现只刷新单条需求，存在不完整需求组和 TOCTOU 问题。
 * 保留签名兼容，内部委托到整组刷新；返回值按传入 requirement 的 identity 精确匹配。
 */
export async function refreshOpenRequirementForActor(
  actor: BusinessActor,
  invocation: InvocationContext,
  requirementId: string,
): Promise<{ cancelled: string; created: string }> {
  assertCanManage(actor);
  const req = await prisma.supplyRequirement.findUnique({
    where: { id: requirementId },
    select: { orderLineId: true, productSkuId: true, componentRole: true },
  });
  if (!req) throw new NotFoundError("供应需求");

  const targetKey = requirementIdentityKey(req.productSkuId, req.componentRole);
  const result = await refreshRequirementsForOrderLine(actor, invocation, req.orderLineId);

  const [cancelledRows, createdRows] = await Promise.all([
    prisma.supplyRequirement.findMany({
      where: { id: { in: result.cancelledIds } },
      select: { id: true, productSkuId: true, componentRole: true },
    }),
    prisma.supplyRequirement.findMany({
      where: { id: { in: result.createdIds } },
      select: { id: true, productSkuId: true, componentRole: true },
    }),
  ]);

  const cancelledMatch = cancelledRows.find(
    (r) => requirementIdentityKey(r.productSkuId, r.componentRole) === targetKey,
  );
  const createdMatch = createdRows.find(
    (r) => requirementIdentityKey(r.productSkuId, r.componentRole) === targetKey,
  );

  return {
    cancelled: cancelledMatch?.id ?? requirementId,
    // 传入的需求 identity 在新 BOM 中已不存在（组件被删）时 created 为空串
    created: createdMatch?.id ?? "",
  };
}

/**
 * 锁定供应需求（§6.3 规则 6）：事务内复核 definitionHash，不一致 → 409。
 *
 * P1 修正：
 *  - 读取当前订单行数量/单位，以及当前 serviceMapping.productSkuId（根 SKU 绑定）；
 *  - 根 SKU 与冻结 requirement.rootSkuId 不一致 → fail-closed；
 *  - BOM 分支将当前订单行单位纳入 hash（rootOrderUnit），仅单位变化也能检出。
 *
 * 调用方在锁定供应方案的事务内调用。
 */
export async function lockRequirementInTx(
  tx: TransactionClient,
  requirementId: string,
  expectedDefinitionHash: string,
): Promise<void> {
  const req = await tx.supplyRequirement.findUnique({
    where: { id: requirementId },
    select: {
      id: true,
      status: true,
      definitionHash: true,
      productSkuId: true,
      rootSkuId: true,
      quantity: true,
      unit: true,
      source: true,
      componentRole: true,
      orderLineId: true,
    },
  });
  if (!req) throw new NotFoundError("供应需求");
  if (req.status !== SUPPLY_REQUIREMENT_STATUS.PLANNED && req.status !== SUPPLY_REQUIREMENT_STATUS.OPEN) {
    throw new ConflictError(`需求状态 ${req.status}，不可锁定`);
  }
  // 调用方传入的 hash 必须与需求中保存的 hash 一致（防调用方用过期方案）
  if (req.definitionHash !== expectedDefinitionHash) {
    throw new ConflictError("供应需求 definitionHash 与调用方传入不一致，请重新生成方案");
  }

  // 读取当前订单行数量/单位/根 SKU 绑定（不信任 requirement 冻结快照）
  const orderLine = await tx.orderLine.findUnique({
    where: { id: req.orderLineId },
    select: {
      quantity: true,
      unit: true,
      serviceMapping: { select: { productSkuId: true } },
    },
  });
  if (!orderLine || orderLine.quantity == null) {
    throw new ConflictError("供应需求关联的订单行不存在或数量为空，无法锁定");
  }
  const currentOrderQty = orderLine.quantity;
  const currentOrderUnit = orderLine.unit ?? "项";
  const currentRootSkuId = orderLine.serviceMapping?.productSkuId ?? null;
  const frozenRootSkuId = req.rootSkuId ?? req.productSkuId;
  if (!currentRootSkuId || currentRootSkuId !== frozenRootSkuId) {
    throw new ConflictError(
      "订单行产品绑定已变更或缺失，请刷新需求后重新生成方案",
    );
  }
  const rootSkuId = currentRootSkuId;

  const rootSku = await tx.productSku.findUnique({
    where: { id: rootSkuId },
    include: {
      parentComponents: {
        where: { active: true },
        include: {
          componentSku: { select: { standardUnit: true } },
        },
      },
    },
  });
  if (!rootSku) {
    throw new ConflictError("供应需求引用的根 SKU 已不存在，无法锁定");
  }

  let currentHash: string;
  if (rootSku.parentComponents.length === 0) {
    // DIRECT 需求：当前订单行数量 + 当前订单行单位（与创建时一致）
    currentHash = computeDefinitionHash({
      productSkuId: rootSkuId,
      quantity: currentOrderQty,
      unit: currentOrderUnit,
    });
  } else {
    // BOM 需求：当前 BOM 系数 × 当前订单数量 + 当前组件 standardUnit + 当前订单行单位
    const bomComponents = rootSku.parentComponents.map((c) => ({
      componentSkuId: c.componentSkuId,
      quantity: c.quantity,
      role: c.role,
    }));
    const matchingComp = rootSku.parentComponents.find(
      (c) => c.role === req.componentRole && c.componentSkuId === req.productSkuId,
    );
    if (!matchingComp) {
      throw new ConflictError(
        "供应需求对应的 BOM 组件已不存在或角色已变更，请刷新需求后重新生成方案",
      );
    }
    const compUnit = matchingComp.componentSku.standardUnit;
    const compQty = matchingComp.quantity * currentOrderQty;
    currentHash = computeDefinitionHash({
      productSkuId: rootSkuId,
      quantity: compQty,
      unit: compUnit,
      rootOrderUnit: currentOrderUnit,
      bomComponents,
    });
  }

  if (currentHash !== req.definitionHash) {
    throw new ConflictError(
      "供应需求 definitionHash 与当前 BOM/订单数量/订单单位/组件单位不一致，请刷新需求后重新生成方案",
    );
  }
  await tx.supplyRequirement.update({
    where: { id: requirementId },
    data: { status: SUPPLY_REQUIREMENT_STATUS.LOCKED },
  });
}

/**
 * 将 OPEN 需求标 PLANNED（进入草稿方案时）。
 */
export async function markRequirementPlannedInTx(
  tx: TransactionClient,
  requirementId: string,
): Promise<void> {
  await tx.supplyRequirement.updateMany({
    where: { id: requirementId, status: SUPPLY_REQUIREMENT_STATUS.OPEN },
    data: { status: SUPPLY_REQUIREMENT_STATUS.PLANNED },
  });
}

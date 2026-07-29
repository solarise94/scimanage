/**
 * Phase C: server-owned order draft service（修正 6/7）。
 *
 * 链路：prepare_order → GenUI PATCH draft → propose_order(draftRef) → 持久化 AgentProposal
 *      → confirm → internal orders.create_from_draft → canonical createOrderFromDraftForActor。
 *
 * 关键约束（已拍板）：
 *  - prepare_order(customerId) 创建 OrderDraft + 返回 GenUI 选项（serviceCatalogId 等）；
 *    不接收 title/remark/JSON lines。
 *  - GenUI PATCH 仅允许产品/项目类型/数量/单价（行级），带 expectedVersion 乐观锁；不是模型工具。
 *  - 标题服务端生成：单行=productDisplayNameSnapshot；多行=`${首行} 等 N 项`；无行→needs_selection。
 *  - propose_order 的 buildProposal 只读 draft（不落单）；真正落单只在 confirm 执行。
 *  - 草稿在 createOrderFromDraftForActor 最终写事务内标 CONSUMED（与订单原子）。
 *
 * OrderDraftLine 存 productKey（稳定 catalog/SKU）+ 展示快照，不存短期 serviceCatalogId。
 *
 * 本模块是 canonical service，允许 Prisma。
 */
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import type { BusinessActor } from "@/lib/application/actor";
import { ForbiddenError, ValidationError, NotFoundError } from "@/lib/application/errors";

const DRAFT_TTL_HOURS = 24;
const MAX_DRAFT_LINES = 50;
const MAX_QUANTITY = 1_000_000;
const MAX_UNIT_PRICE_YUAN = 10_000_000; // 1000 万元

/** GenUI 可选产品 option（来自可替换的 product-option provider）。 */
export interface ProductOption {
  /**
   * 真实 ProductSku id（Phase 1）。授权与合法性由 PATCH 时查表校验（须为 active sellable SKU）。
   * 兼容 legacy GenUI 字段名 serviceCatalogId。
   */
  serviceCatalogId: string;
  /** Phase 1：真实 productSkuId（与 serviceCatalogId 同值，供新 GenUI 使用）。 */
  productSkuId: string;
  /** legacy 稳定 key（Phase 1 起 = skuCode）。 */
  productKey: string;
  productCode: string;
  productName: string;
  skuCode: string;
  displayName: string;
}

/** GenUI 可选项目类型 option。 */
export interface ProjectTypeOption {
  projectTypeOptionId: string;
  displayName: string;
}

export interface PrepareOrderDraftInput {
  customerProfileId: string;
}

export interface PrepareOrderDraftResult {
  orderDraftId: string;
  version: number;
  productOptions: ProductOption[];
  projectTypeOptions: ProjectTypeOption[];
  needsSelection: boolean;
}

/**
 * 产品 option provider（P1-3 / P2 / Phase 1 产品目录）。
 *
 * Phase 1 起从 ProductSku 读取 active+sellable SKU，返回真实 productSkuId。
 * GenUI 卡片只能从此列表选；PATCH 时未命中 active sellable SKU 的 productSkuId 一律 400
 * （禁止自由文本 / productKey / 不在 active 集合的 id）。
 *
 * 合法性校验（须为 prepare_order 颁发的候选集成员）仍在 PATCH 内查表确认。
 *
 * 兼容期：仍提供 serviceCatalogId（=productSkuId 的别名，便于 GenUI 卡片渐进迁移），
 * productKey 保留为 legacy 字段（=skuCode）。
 *
 * 注：产品 catalog 当前为全局 active 集合，与具体 customer profile 无关；保留函数名以便未来
 * 按客户/租户收窄时扩展。
 */
export async function getProductOptionsForProfile(): Promise<ProductOption[]> {
  const skus = await prisma.productSku.findMany({
    where: { status: "ACTIVE", sellable: true },
    include: { product: { select: { id: true, productCode: true, name: true } } },
    orderBy: [{ product: { productCode: "asc" } }, { skuCode: "asc" }],
  });
  return skus.map((s) => ({
    serviceCatalogId: s.id, // 兼容 legacy GenUI 字段名；实为 productSkuId
    productSkuId: s.id,
    productKey: s.skuCode, // legacy 稳定 key
    productCode: s.product.productCode,
    productName: s.product.name,
    skuCode: s.skuCode,
    displayName: `${s.product.name} / ${s.name}`,
  }));
}

export async function getProjectTypeOptions(): Promise<ProjectTypeOption[]> {
  // 复用订单 category 常见值作为项目类型候选（封闭集合，不接受自由文本）。
  return [
    { projectTypeOptionId: "SERVICE", displayName: "技术服务" },
    { projectTypeOptionId: "REAGENT", displayName: "试剂耗材" },
    { projectTypeOptionId: "SEQUENCING", displayName: "测序" },
    { projectTypeOptionId: "OTHER", displayName: "其他" },
  ];
}

/**
 * 草稿 TTL 检查：过期则尽力标 EXPIRED 并抛错（fail-closed）。
 */
async function assertOrderDraftNotExpired(draft: {
  id: string;
  status: string;
  expiresAt: Date;
}): Promise<void> {
  if (draft.expiresAt.getTime() > Date.now()) return;
  if (draft.status === "DRAFT" || draft.status === "PROPOSED") {
    await prisma.orderDraft.updateMany({
      where: { id: draft.id, status: draft.status },
      data: { status: "EXPIRED" },
    });
  }
  throw new ValidationError("订单草稿已过期，请重新 prepare_order");
}

/**
 * prepare_order：创建 OrderDraft，返回 GenUI 选项。
 * 不落任何业务订单。
 *
 * P0-3b：actor 必须对该客户有 CRM 访问权（assertCrmProfileAccess）。
 * P1-2：agentRunId 持久化到草稿，使 GenUI PATCH 可校验 run 归属。
 */
export async function prepareOrderDraftForActor(
  actor: BusinessActor,
  input: PrepareOrderDraftInput,
  opts: { agentRunId?: string | null } = {},
): Promise<PrepareOrderDraftResult> {
  if (actor.role !== "ADMIN" && actor.role !== "USER") {
    throw new ForbiddenError("仅内部员工可创建订单草稿");
  }
  if (!input.customerProfileId) {
    throw new ValidationError("customerProfileId is required");
  }

  // P0-3b：CRM actor scope 校验——不能为任意客户创建草稿。
  // assertCrmProfileAccess 对 ADMIN/USER 直接放行（内部员工全量），对销售角色按 scope 校验。
  // 此处 actor 已限定 ADMIN/USER，scope 校验主要防止未来扩展到销售角色时的越权。
  const { assertCrmProfileAccess } = await import("@/lib/crm/permissions");
  try {
    await assertCrmProfileAccess(input.customerProfileId, actor.userId, actor.role);
  } catch {
    throw new NotFoundError("客户档案不存在或无权访问");
  }

  const profile = await prisma.crmCustomerProfile.findUnique({
    where: { id: input.customerProfileId },
    select: { id: true, name: true },
  });
  if (!profile) {
    throw new NotFoundError("客户档案");
  }

  const expiresAt = new Date(Date.now() + DRAFT_TTL_HOURS * 60 * 60 * 1000);
  const draft = await prisma.orderDraft.create({
    data: {
      ownerUserId: actor.userId,
      agentRunId: opts.agentRunId ?? null,
      customerProfileId: input.customerProfileId,
      version: 1,
      status: "DRAFT",
      expiresAt,
    },
  });

  const [productOptions, projectTypeOptions] = await Promise.all([
    getProductOptionsForProfile(),
    getProjectTypeOptions(),
  ]);

  return {
    orderDraftId: draft.id,
    version: draft.version,
    productOptions,
    projectTypeOptions,
    needsSelection: true, // 新草稿无行，必须先选产品
  };
}

export interface OrderDraftLinePatch {
  /** 行 ref（已存在行的 stable id；新建行传 "new"）。 */
  rowRef: string;
  /**
   * 真实 ProductSku id（Phase 1；来自 prepare_order 返回的 productOptions[].productSkuId）。
   * 兼容 legacy 字段名 serviceCatalogId（与 productSkuId 同值）。
   */
  productSkuId?: string;
  /** legacy 字段名（= productSkuId）。 */
  serviceCatalogId?: string;
  projectTypeOptionId: string;
  quantity: number;
  unitPriceYuan: number;
}

export interface PatchOrderDraftInput {
  orderDraftId: string;
  expectedVersion: number;
  rows: OrderDraftLinePatch[];
}

export interface PatchOrderDraftResult {
  orderDraftId: string;
  version: number;
  titleSnapshot: string | null;
  needsSelection: boolean;
}

/**
 * GenUI PATCH：行级乐观锁更新。仅允许产品/项目类型/数量/单价。
 * 标题服务端生成。不是模型工具。
 */
export async function patchOrderDraftForActor(
  actor: BusinessActor,
  input: PatchOrderDraftInput,
): Promise<PatchOrderDraftResult> {
  if (actor.role !== "ADMIN" && actor.role !== "USER") {
    throw new ForbiddenError("仅内部员工可修改订单草稿");
  }
  if (!Array.isArray(input.rows)) {
    throw new ValidationError("rows must be an array");
  }
  if (input.rows.length > MAX_DRAFT_LINES) {
    throw new ValidationError(`草稿行数上限 ${MAX_DRAFT_LINES}`);
  }

  // 校验 + 解析行（乐观锁在外层 updateMany 处理）
  const projectTypes = await getProjectTypeOptions();
  const validProjectTypeIds = new Set(projectTypes.map((p) => p.projectTypeOptionId));

  // P1-3：读取草稿的 customerProfileId，加载该客户可见的产品 catalog（actor 颁发的 option ref）。
  // 草稿 owner 必须是 actor（下面 updateMany 校验），此处先取草稿拿 customerProfileId。
  const draftForCatalog = await prisma.orderDraft.findUnique({
    where: { id: input.orderDraftId },
    select: { customerProfileId: true, ownerUserId: true, agentRunId: true, expiresAt: true, status: true },
  });
  if (!draftForCatalog) throw new NotFoundError("订单草稿");
  if (draftForCatalog.ownerUserId !== actor.userId) throw new ForbiddenError("无权修改他人草稿");
  await assertOrderDraftNotExpired({
    id: input.orderDraftId,
    status: draftForCatalog.status,
    expiresAt: draftForCatalog.expiresAt,
  });

  const productOptions = await getProductOptionsForProfile();
  // Phase 1：option 以 productSkuId 为 key（兼容 legacy serviceCatalogId 字段名）。
  // 公开面只接受 prepare_order 颁发的 productSkuId；禁止自由文本 productKey / 不在 active 集合的 id。
  const optionBySkuId = new Map<string, ProductOption>();
  for (const opt of productOptions) {
    optionBySkuId.set(opt.productSkuId, opt);
  }

  const parsedLines: Array<{
    rowRef: string;
    productKey: string;
    productSkuId: string;
    productCodeSnapshot: string;
    skuCodeSnapshot: string;
    productDisplayNameSnapshot: string;
    projectTypeKey: string;
    quantity: number;
    unitPriceCents: number;
    sortOrder: number;
  }> = [];

  for (let i = 0; i < input.rows.length; i++) {
    const row = input.rows[i];
    if (!validProjectTypeIds.has(row.projectTypeOptionId)) {
      throw new ValidationError(`无效项目类型: ${row.projectTypeOptionId}`);
    }
    if (!Number.isInteger(row.quantity) || row.quantity <= 0 || row.quantity > MAX_QUANTITY) {
      throw new ValidationError(`数量必须为正整数且 <= ${MAX_QUANTITY}`);
    }
    if (typeof row.unitPriceYuan !== "number" || row.unitPriceYuan < 0 || row.unitPriceYuan > MAX_UNIT_PRICE_YUAN) {
      throw new ValidationError(`单价必须为非负数且 <= ${MAX_UNIT_PRICE_YUAN}`);
    }
    // Phase 1：接受 productSkuId（或 legacy serviceCatalogId 字段名）；未命中候选集 → 400。
    const skuId = (row.productSkuId ?? row.serviceCatalogId ?? "").toString().trim();
    const matched = optionBySkuId.get(skuId);
    if (!matched) {
      throw new ValidationError(
        `产品选项无效（须为 prepare_order 返回的 productSkuId）：${skuId.slice(0, 40)}`,
      );
    }
    parsedLines.push({
      rowRef: row.rowRef,
      productKey: matched.productKey,
      productSkuId: matched.productSkuId,
      productCodeSnapshot: matched.productCode,
      skuCodeSnapshot: matched.skuCode,
      productDisplayNameSnapshot: matched.displayName,
      projectTypeKey: row.projectTypeOptionId,
      quantity: row.quantity,
      unitPriceCents: Math.round(row.unitPriceYuan * 100),
      sortOrder: i,
    });
  }

  // 事务：乐观锁校验 + 清旧行 + 写新行 + 重算 title + bump version。
  const result = await prisma.$transaction(async (tx) => {
    // 乐观锁：expectedVersion 必须匹配当前 version，且属主必须是 actor。
    const updated = await tx.orderDraft.updateMany({
      where: { id: input.orderDraftId, ownerUserId: actor.userId, version: input.expectedVersion, status: "DRAFT" },
      data: { version: { increment: 1 } },
    });
    if (updated.count === 0) {
      const fresh = await tx.orderDraft.findUnique({
        where: { id: input.orderDraftId },
        select: { version: true, ownerUserId: true, status: true },
      });
      if (!fresh) throw new NotFoundError("订单草稿");
      if (fresh.ownerUserId !== actor.userId) throw new ForbiddenError("无权修改他人草稿");
      if (fresh.status !== "DRAFT") throw new ValidationError("草稿已不可修改");
      // version 不匹配 → 409
      throw new ValidationError(`草稿版本不匹配（期望 ${input.expectedVersion}，当前 ${fresh.version}）`);
    }

    // 清旧行，写新行
    await tx.orderDraftLine.deleteMany({ where: { orderDraftId: input.orderDraftId } });
    if (parsedLines.length > 0) {
      await tx.orderDraftLine.createMany({
        data: parsedLines.map((l) => ({
          orderDraftId: input.orderDraftId,
          sortOrder: l.sortOrder,
          productKey: l.productKey,
          productSkuId: l.productSkuId,
          productCodeSnapshot: l.productCodeSnapshot,
          skuCodeSnapshot: l.skuCodeSnapshot,
          productDisplayNameSnapshot: l.productDisplayNameSnapshot,
          projectTypeKey: l.projectTypeKey,
          quantity: l.quantity,
          unitPriceCents: l.unitPriceCents,
        })),
      });
    }

    // 服务端生成 title：单行=产品名；多行=`${首行} 等 N 项`；无行=null（needsSelection）
    let titleSnapshot: string | null = null;
    if (parsedLines.length === 1) {
      titleSnapshot = parsedLines[0].productDisplayNameSnapshot;
    } else if (parsedLines.length > 1) {
      titleSnapshot = `${parsedLines[0].productDisplayNameSnapshot} 等 ${parsedLines.length} 项`;
    }
    await tx.orderDraft.update({
      where: { id: input.orderDraftId },
      data: { titleSnapshot },
    });

    return { version: input.expectedVersion + 1, titleSnapshot };
  });

  return {
    orderDraftId: input.orderDraftId,
    version: result.version,
    titleSnapshot: result.titleSnapshot,
    needsSelection: result.titleSnapshot == null,
  };
}

/**
 * 读取草稿（含行）——propose_order buildProposal 只读用，不落单。
 */
export async function getOrderDraftForActor(
  actor: BusinessActor,
  orderDraftId: string,
): Promise<{
  id: string;
  version: number;
  status: string;
  customerProfileId: string | null;
  titleSnapshot: string | null;
  lines: Array<{
    id: string;
    sortOrder: number;
    productKey: string;
    productSkuId: string | null;
    productCodeSnapshot: string | null;
    skuCodeSnapshot: string | null;
    productDisplayNameSnapshot: string | null;
    projectTypeKey: string;
    quantity: number;
    unitPriceCents: number;
  }>;
}> {
  const draft = await prisma.orderDraft.findUnique({
    where: { id: orderDraftId },
    include: { lines: { orderBy: { sortOrder: "asc" } } },
  });
  if (!draft) throw new NotFoundError("订单草稿");
  if (draft.ownerUserId !== actor.userId) throw new ForbiddenError("无权读取他人草稿");
  await assertOrderDraftNotExpired(draft);
  return draft;
}

/**
 * 标记草稿 CONSUMED（confirm 成功后调用，在 lifecycle handler 内）。
 */
export async function markOrderDraftConsumed(
  tx: Prisma.TransactionClient,
  orderDraftId: string,
): Promise<void> {
  await tx.orderDraft.update({
    where: { id: orderDraftId },
    data: { status: "CONSUMED" },
  });
}

/**
 * @deprecated 请用 createOrderFromDraftForActor（订单写入与 CONSUMED 必须同事务）。
 * 保留仅供迁移期诊断；新代码禁止调用。
 */
export async function consumeOrderDraftAfterCreate(orderDraftId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.orderDraft.updateMany({
      where: { id: orderDraftId, status: "PROPOSED" },
      data: { status: "CONSUMED" },
    });
  });
}

/** 标记草稿回 DRAFT（confirm 失败/拒绝时 revert）。 */
export async function revertOrderDraftToDraft(
  tx: Prisma.TransactionClient,
  orderDraftId: string,
): Promise<void> {
  await tx.orderDraft.update({
    where: { id: orderDraftId },
    data: { status: "DRAFT" },
  });
}

/**
 * 产品与服务目录 canonical application service —— 创建/更新/停用/合并。
 *
 * 对应设计文档 §4、§5、§10。Web、导入和 Agent 共用同一写路径，
 * 不允许各自实现编号算法或绕过 productSkuId 非空校验。
 *
 * 本模块是 canonical service，允许 Prisma。
 */
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import type { BusinessActor } from "@/lib/application/actor";
import { ForbiddenError, ValidationError, NotFoundError, ConflictError } from "@/lib/application/errors";
import {
  nextProductCode,
  nextSkuCode,
  isUniqueConflictOn,
} from "@/lib/business-sequence";
import {
  PRODUCT_KIND,
  PRODUCT_STATUS,
  isValidProductKind,
  isValidProductStatus,
  isValidProductDomain,
  isValidFulfillmentMode,
  normalizeAlias,
  PRODUCT_ALIAS_SOURCE,
  PRODUCT_CHANGE_ACTION,
} from "@/lib/products/constants";

const PRODUCT_NAME_MAX = 200;
const SPEC_MAX = 500;
const STANDARD_UNIT_MAX = 50;
const DESCRIPTION_MAX = 2000;
const ALIAS_MAX = 200;
const MAX_ALIASES_PER_PRODUCT = 50;

function assertCanManageProducts(actor: BusinessActor): void {
  if (actor.role !== "ADMIN" && actor.role !== "USER") {
    throw new ForbiddenError("仅内部员工可管理产品目录");
  }
}

function requireNonEmpty(v: unknown, label: string): string {
  if (typeof v !== "string" || !v.trim()) {
    throw new ValidationError(`${label}不能为空`);
  }
  return v.trim();
}

// ─── Create Product ───────────────────────────────────────────────

export interface CreateProductInput {
  name: string;
  kind?: string;
  domain?: string | null;
  description?: string | null;
  status?: string;
  aliases?: string[];
}

export interface CreateProductResult {
  product: {
    id: string;
    productCode: string;
    name: string;
    kind: string;
    domain: string | null;
    status: string;
    description: string | null;
    createdAt: Date;
    updatedAt: Date;
  };
  aliases: Array<{ id: string; alias: string; normalizedAlias: string; source: string }>;
}

export async function createProductForActor(
  actor: BusinessActor,
  input: CreateProductInput,
): Promise<CreateProductResult> {
  assertCanManageProducts(actor);

  const name = requireNonEmpty(input.name, "产品名称");
  if (name.length > PRODUCT_NAME_MAX) {
    throw new ValidationError(`产品名称最长 ${PRODUCT_NAME_MAX} 字`);
  }
  const kind = input.kind ?? PRODUCT_KIND.SERVICE;
  if (!isValidProductKind(kind)) {
    throw new ValidationError(`无效产品类型: ${kind}`);
  }
  const status = input.status ?? PRODUCT_STATUS.DRAFT;
  if (!isValidProductStatus(status)) {
    throw new ValidationError(`无效产品状态: ${status}`);
  }
  let domain: string | null = null;
  if (input.domain) {
    if (!isValidProductDomain(input.domain)) {
      throw new ValidationError(`无效业务域: ${input.domain}`);
    }
    domain = input.domain;
  }
  const description = input.description?.trim() || null;
  if (description && description.length > DESCRIPTION_MAX) {
    throw new ValidationError(`描述最长 ${DESCRIPTION_MAX} 字`);
  }

  // 别名规范化与去重
  const rawAliases = (input.aliases ?? [])
    .map((a) => a?.trim())
    .filter((a): a is string => !!a && a.length <= ALIAS_MAX);
  if (rawAliases.length > MAX_ALIASES_PER_PRODUCT) {
    throw new ValidationError(`单个产品别名数上限 ${MAX_ALIASES_PER_PRODUCT}`);
  }
  const aliasMap = new Map<string, string>(); // normalized → original
  for (const a of rawAliases) {
    const norm = normalizeAlias(a);
    if (!aliasMap.has(norm)) aliasMap.set(norm, a);
  }

  // 事务：领号 + 建产品 + 建别名 + 写变更日志
  const result = await prisma.$transaction(async (tx) => {
    const productCode = await nextProductCode(tx);
    const product = await tx.product.create({
      data: {
        productCode,
        name,
        kind,
        domain,
        status,
        description,
        createdById: actor.userId,
      },
    });

    const aliases: CreateProductResult["aliases"] = [];
    for (const [norm, original] of aliasMap) {
      const created = await tx.productAlias.create({
        data: {
          productId: product.id,
          alias: original,
          normalizedAlias: norm,
          source: PRODUCT_ALIAS_SOURCE.MANUAL,
        },
      });
      aliases.push({
        id: created.id,
        alias: created.alias,
        normalizedAlias: created.normalizedAlias,
        source: created.source,
      });
    }

    await tx.productChangeLog.create({
      data: {
        productId: product.id,
        action: PRODUCT_CHANGE_ACTION.PRODUCT_CREATED,
        note: `创建产品 ${productCode}（${name}）`,
        createdById: actor.userId,
      },
    });
    for (const a of aliases) {
      await tx.productChangeLog.create({
        data: {
          productId: product.id,
          action: PRODUCT_CHANGE_ACTION.ALIAS_ADDED,
          afterValue: a.alias,
          createdById: actor.userId,
        },
      });
    }

    return { product, aliases };
  }).catch((err: unknown) => {
    if (isUniqueConflictOn(err, "productCode")) {
      throw new ConflictError("产品编号冲突，请重试");
    }
    if (isUniqueConflictOn(err, "productId_normalizedAlias")) {
      throw new ConflictError("别名冲突（同产品下规范化别名必须唯一）");
    }
    throw err;
  });

  return result;
}

// ─── Update Product ───────────────────────────────────────────────

export interface UpdateProductInput {
  name?: string;
  kind?: string;
  domain?: string | null;
  description?: string | null;
  status?: string;
}

export async function updateProductForActor(
  actor: BusinessActor,
  productId: string,
  input: UpdateProductInput,
): Promise<{ product: CreateProductResult["product"] }> {
  assertCanManageProducts(actor);
  if (!productId) throw new ValidationError("productId is required");

  const existing = await prisma.product.findUnique({ where: { id: productId } });
  if (!existing) throw new NotFoundError("产品");

  const data: Prisma.ProductUpdateInput = {};
  const logs: Array<{ field: string; before: string; after: string }> = [];

  if (input.name !== undefined) {
    const name = requireNonEmpty(input.name, "产品名称");
    if (name.length > PRODUCT_NAME_MAX) throw new ValidationError(`产品名称最长 ${PRODUCT_NAME_MAX} 字`);
    if (name !== existing.name) {
      logs.push({ field: "name", before: existing.name, after: name });
      data.name = name;
    }
  }
  if (input.kind !== undefined) {
    if (!isValidProductKind(input.kind)) throw new ValidationError(`无效产品类型: ${input.kind}`);
    if (input.kind !== existing.kind) {
      logs.push({ field: "kind", before: existing.kind, after: input.kind });
      data.kind = input.kind;
    }
  }
  if (input.domain !== undefined) {
    let domain: string | null = null;
    if (input.domain) {
      if (!isValidProductDomain(input.domain)) throw new ValidationError(`无效业务域: ${input.domain}`);
      domain = input.domain;
    }
    if (domain !== existing.domain) {
      logs.push({ field: "domain", before: existing.domain ?? "(空)", after: domain ?? "(空)" });
      data.domain = domain;
    }
  }
  if (input.description !== undefined) {
    const description = input.description?.trim() || null;
    if (description && description.length > DESCRIPTION_MAX) {
      throw new ValidationError(`描述最长 ${DESCRIPTION_MAX} 字`);
    }
    if (description !== existing.description) {
      logs.push({ field: "description", before: existing.description ?? "(空)", after: description ?? "(空)" });
      data.description = description;
    }
  }
  if (input.status !== undefined) {
    if (!isValidProductStatus(input.status)) throw new ValidationError(`无效产品状态: ${input.status}`);
    if (input.status !== existing.status) {
      logs.push({ field: "status", before: existing.status, after: input.status });
      data.status = input.status;
    }
  }

  if (Object.keys(data).length === 0) {
    return { product: { ...existing } };
  }

  const updated = await prisma.$transaction(async (tx) => {
    const product = await tx.product.update({ where: { id: productId }, data });
    for (const log of logs) {
      await tx.productChangeLog.create({
        data: {
          productId,
          action: PRODUCT_CHANGE_ACTION.PRODUCT_UPDATED,
          field: log.field,
          beforeValue: log.before,
          afterValue: log.after,
          createdById: actor.userId,
        },
      });
    }
    return product;
  });

  return { product: updated };
}

// ─── Create SKU ───────────────────────────────────────────────────

export interface CreateSkuInput {
  productId: string;
  name: string;
  spec?: string | null;
  standardUnit: string;
  sellable?: boolean;
  purchasable?: boolean;
  fulfillmentMode?: string;
  defaultSalesPriceYuan?: number | null;
  status?: string;
}

export interface CreateSkuResult {
  sku: {
    id: string;
    skuCode: string;
    productId: string;
    name: string;
    spec: string | null;
    standardUnit: string;
    sellable: boolean;
    purchasable: boolean;
    fulfillmentMode: string;
    defaultSalesPrice: number | null;
    status: string;
    replacementSkuId: string | null;
    createdAt: Date;
    updatedAt: Date;
  };
}

export async function createSkuForActor(
  actor: BusinessActor,
  input: CreateSkuInput,
): Promise<CreateSkuResult> {
  assertCanManageProducts(actor);

  const productId = requireNonEmpty(input.productId, "productId");
  const name = requireNonEmpty(input.name, "SKU 名称");
  if (name.length > PRODUCT_NAME_MAX) throw new ValidationError(`SKU 名称最长 ${PRODUCT_NAME_MAX} 字`);
  const standardUnit = requireNonEmpty(input.standardUnit, "标准单位");
  if (standardUnit.length > STANDARD_UNIT_MAX) throw new ValidationError(`标准单位最长 ${STANDARD_UNIT_MAX} 字`);
  const spec = input.spec?.trim() || null;
  if (spec && spec.length > SPEC_MAX) throw new ValidationError(`规格最长 ${SPEC_MAX} 字`);

  const fulfillmentMode = input.fulfillmentMode ?? "EXTERNAL_OR_INTERNAL";
  if (!isValidFulfillmentMode(fulfillmentMode)) {
    throw new ValidationError(`无效履约模式: ${fulfillmentMode}`);
  }
  const status = input.status ?? PRODUCT_STATUS.DRAFT;
  if (!isValidProductStatus(status)) throw new ValidationError(`无效 SKU 状态: ${status}`);

  let defaultSalesPrice: number | null = null;
  if (input.defaultSalesPriceYuan != null) {
    if (typeof input.defaultSalesPriceYuan !== "number" || input.defaultSalesPriceYuan < 0) {
      throw new ValidationError("默认售价必须为非负数");
    }
    defaultSalesPrice = Math.round(input.defaultSalesPriceYuan * 100);
  }

  // 校验产品存在
  const product = await prisma.product.findUnique({ where: { id: productId }, select: { id: true } });
  if (!product) throw new NotFoundError("产品");

  const sku = await prisma.$transaction(async (tx) => {
    const skuCode = await nextSkuCode(tx);
    const created = await tx.productSku.create({
      data: {
        skuCode,
        productId,
        name,
        spec,
        standardUnit,
        sellable: input.sellable ?? true,
        purchasable: input.purchasable ?? true,
        fulfillmentMode,
        defaultSalesPrice,
        status,
        createdById: actor.userId,
      },
    });
    await tx.productChangeLog.create({
      data: {
        productId,
        skuId: created.id,
        action: PRODUCT_CHANGE_ACTION.SKU_CREATED,
        afterValue: `${skuCode}（${name}）`,
        createdById: actor.userId,
      },
    });
    return created;
  }).catch((err: unknown) => {
    if (isUniqueConflictOn(err, "skuCode")) {
      throw new ConflictError("SKU 编号冲突，请重试");
    }
    throw err;
  });

  return { sku };
}

// ─── Update / Retire / Merge SKU ──────────────────────────────────

export interface UpdateSkuInput {
  name?: string;
  spec?: string | null;
  standardUnit?: string;
  sellable?: boolean;
  purchasable?: boolean;
  fulfillmentMode?: string;
  defaultSalesPriceYuan?: number | null;
  status?: string;
}

export async function updateSkuForActor(
  actor: BusinessActor,
  skuId: string,
  input: UpdateSkuInput,
): Promise<{ sku: CreateSkuResult["sku"] }> {
  assertCanManageProducts(actor);
  if (!skuId) throw new ValidationError("skuId is required");

  const existing = await prisma.productSku.findUnique({ where: { id: skuId } });
  if (!existing) throw new NotFoundError("SKU");

  // P1 修正（review #5）：已停用/已合并 SKU 不可经通用 PATCH 修改（状态机收口）。
  // 停用→ 用 retireSkuForActor；合并→ 用 mergeSkuForActor（必须设 replacementSkuId）。
  // 这样防止 PATCH 把 RETIRED/MERGED 改回 ACTIVE 绕过约束，也防止 PATCH 直接写 MERGED
  // 而不设替代 SKU。
  if (existing.status === PRODUCT_STATUS.RETIRED || existing.status === PRODUCT_STATUS.MERGED) {
    throw new ValidationError(
      `SKU 当前状态为 ${existing.status}，不可经通用编辑修改；停用/合并请使用专用接口`,
    );
  }
  // 通用 PATCH 禁止直接改成 RETIRED/MERGED（必须走 retire/merge service）
  if (input.status === PRODUCT_STATUS.RETIRED || input.status === PRODUCT_STATUS.MERGED) {
    throw new ValidationError(
      `不可经通用编辑将 SKU 改为 ${input.status}；停用请用 retire 接口，合并请用 merge 接口`,
    );
  }

  const data: Prisma.ProductSkuUpdateInput = {};
  const logs: Array<{ field: string; before: string; after: string }> = [];

  if (input.name !== undefined) {
    const name = requireNonEmpty(input.name, "SKU 名称");
    if (name.length > PRODUCT_NAME_MAX) throw new ValidationError(`SKU 名称最长 ${PRODUCT_NAME_MAX} 字`);
    if (name !== existing.name) {
      logs.push({ field: "name", before: existing.name, after: name });
      data.name = name;
    }
  }
  if (input.spec !== undefined) {
    const spec = input.spec?.trim() || null;
    if (spec && spec.length > SPEC_MAX) throw new ValidationError(`规格最长 ${SPEC_MAX} 字`);
    if (spec !== existing.spec) {
      logs.push({ field: "spec", before: existing.spec ?? "(空)", after: spec ?? "(空)" });
      data.spec = spec;
    }
  }
  if (input.standardUnit !== undefined) {
    const standardUnit = requireNonEmpty(input.standardUnit, "标准单位");
    if (standardUnit.length > STANDARD_UNIT_MAX) throw new ValidationError(`标准单位最长 ${STANDARD_UNIT_MAX} 字`);
    if (standardUnit !== existing.standardUnit) {
      logs.push({ field: "standardUnit", before: existing.standardUnit, after: standardUnit });
      data.standardUnit = standardUnit;
    }
  }
  if (input.sellable !== undefined && input.sellable !== existing.sellable) {
    logs.push({ field: "sellable", before: String(existing.sellable), after: String(input.sellable) });
    data.sellable = input.sellable;
  }
  if (input.purchasable !== undefined && input.purchasable !== existing.purchasable) {
    logs.push({ field: "purchasable", before: String(existing.purchasable), after: String(input.purchasable) });
    data.purchasable = input.purchasable;
  }
  if (input.fulfillmentMode !== undefined) {
    if (!isValidFulfillmentMode(input.fulfillmentMode)) throw new ValidationError(`无效履约模式: ${input.fulfillmentMode}`);
    if (input.fulfillmentMode !== existing.fulfillmentMode) {
      logs.push({ field: "fulfillmentMode", before: existing.fulfillmentMode, after: input.fulfillmentMode });
      data.fulfillmentMode = input.fulfillmentMode;
    }
  }
  if (input.defaultSalesPriceYuan !== undefined) {
    let price: number | null = null;
    if (input.defaultSalesPriceYuan != null) {
      if (typeof input.defaultSalesPriceYuan !== "number" || input.defaultSalesPriceYuan < 0) {
        throw new ValidationError("默认售价必须为非负数");
      }
      price = Math.round(input.defaultSalesPriceYuan * 100);
    }
    if (price !== existing.defaultSalesPrice) {
      logs.push({ field: "defaultSalesPrice", before: String(existing.defaultSalesPrice), after: String(price) });
      data.defaultSalesPrice = price;
    }
  }
  if (input.status !== undefined) {
    if (!isValidProductStatus(input.status)) throw new ValidationError(`无效 SKU 状态: ${input.status}`);
    if (input.status !== existing.status) {
      logs.push({ field: "status", before: existing.status, after: input.status });
      data.status = input.status;
    }
  }

  if (Object.keys(data).length === 0) {
    return { sku: { ...existing } };
  }

  const updated = await prisma.$transaction(async (tx) => {
    const sku = await tx.productSku.update({ where: { id: skuId }, data });
    for (const log of logs) {
      await tx.productChangeLog.create({
        data: {
          productId: existing.productId,
          skuId,
          action: PRODUCT_CHANGE_ACTION.SKU_UPDATED,
          field: log.field,
          beforeValue: log.before,
          afterValue: log.after,
          createdById: actor.userId,
        },
      });
    }
    return sku;
  });

  return { sku: updated };
}

/**
 * 停用 SKU：RETIRED 保留历史引用，不可新增。
 * 不允许物理删除已被订单/报价/成本引用的 SKU（外键 Restrict 保护）。
 */
export async function retireSkuForActor(
  actor: BusinessActor,
  skuId: string,
): Promise<{ sku: CreateSkuResult["sku"] }> {
  assertCanManageProducts(actor);
  if (!skuId) throw new ValidationError("skuId is required");

  const existing = await prisma.productSku.findUnique({ where: { id: skuId } });
  if (!existing) throw new NotFoundError("SKU");
  if (existing.status === PRODUCT_STATUS.RETIRED) {
    throw new ValidationError("SKU 已是停用状态");
  }

  const sku = await prisma.$transaction(async (tx) => {
    const updated = await tx.productSku.update({
      where: { id: skuId },
      data: { status: PRODUCT_STATUS.RETIRED, sellable: false, purchasable: false },
    });
    await tx.productChangeLog.create({
      data: {
        productId: existing.productId,
        skuId,
        action: PRODUCT_CHANGE_ACTION.SKU_RETIRED,
        beforeValue: existing.status,
        afterValue: PRODUCT_STATUS.RETIRED,
        createdById: actor.userId,
      },
    });
    return updated;
  });

  return { sku };
}

/**
 * 合并 SKU：旧 SKU 标 MERGED 并指向替代 SKU。
 * 旧 SKU 历史可查，新业务只允许替代 SKU。
 */
export async function mergeSkuForActor(
  actor: BusinessActor,
  sourceSkuId: string,
  replacementSkuId: string,
): Promise<{ sourceSku: CreateSkuResult["sku"]; replacementSku: CreateSkuResult["sku"] }> {
  assertCanManageProducts(actor);
  if (!sourceSkuId) throw new ValidationError("sourceSkuId is required");
  if (!replacementSkuId) throw new ValidationError("replacementSkuId is required");
  if (sourceSkuId === replacementSkuId) {
    throw new ValidationError("不能合并到自身");
  }

  const [source, replacement] = await Promise.all([
    prisma.productSku.findUnique({ where: { id: sourceSkuId } }),
    prisma.productSku.findUnique({ where: { id: replacementSkuId } }),
  ]);
  if (!source) throw new NotFoundError("源 SKU");
  if (!replacement) throw new NotFoundError("替代 SKU");
  if (replacement.status !== PRODUCT_STATUS.ACTIVE) {
    throw new ValidationError("替代 SKU 必须为 ACTIVE 状态");
  }

  const updated = await prisma.$transaction(async (tx) => {
    const updatedSource = await tx.productSku.update({
      where: { id: sourceSkuId },
      data: {
        status: PRODUCT_STATUS.MERGED,
        replacementSkuId,
        sellable: false,
        purchasable: false,
      },
    });
    await tx.productChangeLog.create({
      data: {
        productId: source.productId,
        skuId: sourceSkuId,
        action: PRODUCT_CHANGE_ACTION.SKU_MERGED,
        afterValue: `${source.skuCode} → ${replacement.skuCode}`,
        note: `合并到 ${replacement.skuCode}`,
        createdById: actor.userId,
      },
    });
    return updatedSource;
  });

  return { sourceSku: updated, replacementSku: replacement };
}

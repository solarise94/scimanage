/**
 * 产品与服务目录查询 service（列表/详情/governance）。
 *
 * 对应设计文档 §9、§10。Web 与 Agent 共用同一读路径。
 * 本模块是 canonical service，允许 Prisma。
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { BusinessActor } from "@/lib/application/actor";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/application/errors";
import {
  PRODUCT_STATUS,
  isValidProductKind,
  isValidProductStatus,
  isValidProductDomain,
} from "@/lib/products/constants";

export const PRODUCT_LIST_INCLUDE = {
  skus: {
    select: {
      id: true,
      skuCode: true,
      name: true,
      spec: true,
      standardUnit: true,
      sellable: true,
      purchasable: true,
      status: true,
      defaultSalesPrice: true,
    },
  },
  aliases: { select: { id: true, alias: true, source: true } },
  _count: {
    select: {
      skus: true,
      aliases: true,
    },
  },
} satisfies Prisma.ProductInclude;

export type ProductListRecord = Prisma.ProductGetPayload<{ include: typeof PRODUCT_LIST_INCLUDE }>;

export const PRODUCT_DETAIL_INCLUDE = {
  ...PRODUCT_LIST_INCLUDE,
  skus: {
    select: {
      ...PRODUCT_LIST_INCLUDE.skus.select,
      id: true,
      fulfillmentMode: true,
      replacementSkuId: true,
      createdAt: true,
      updatedAt: true,
    },
  },
  changeLogs: {
    orderBy: { createdAt: "desc" as const },
    take: 50,
    select: {
      id: true,
      action: true,
      field: true,
      beforeValue: true,
      afterValue: true,
      note: true,
      skuId: true,
      createdAt: true,
      createdBy: { select: { id: true, name: true } },
    },
  },
} satisfies Prisma.ProductInclude;

export type ProductDetailRecord = Prisma.ProductGetPayload<{ include: typeof PRODUCT_DETAIL_INCLUDE }>;

export type ProductListFilters = {
  search?: string | null;
  kind?: string | null;
  domain?: string | null;
  status?: string | null;
  /** 只看有 active sellable SKU 的产品。 */
  sellableOnly?: boolean;
};

function assertCanRead(actor: BusinessActor): void {
  // P2 修正（review #6）：产品目录（含默认售价、别名、变更日志）仅内部员工可读。
  // 外部角色（REPRESENTATIVE/REGIONAL_MANAGER）不可直接请求 API 读取。
  if (actor.role !== "ADMIN" && actor.role !== "USER") {
    throw new ForbiddenError("仅内部员工可查看产品目录");
  }
}

export async function listProductsForActor(
  actor: BusinessActor,
  filters: ProductListFilters = {},
): Promise<ProductListRecord[]> {
  assertCanRead(actor);

  const where: Prisma.ProductWhereInput = {};
  const search = filters.search?.trim();
  if (search) {
    where.OR = [
      { name: { contains: search } },
      { productCode: { contains: search } },
      { description: { contains: search } },
      { aliases: { some: { normalizedAlias: { contains: search.toLowerCase() } } } },
      { skus: { some: { name: { contains: search } } } },
      { skus: { some: { skuCode: { contains: search } } } },
    ];
  }
  if (filters.kind) {
    if (!isValidProductKind(filters.kind)) throw new ValidationError(`无效产品类型: ${filters.kind}`);
    where.kind = filters.kind;
  }
  if (filters.domain) {
    if (!isValidProductDomain(filters.domain)) throw new ValidationError(`无效业务域: ${filters.domain}`);
    where.domain = filters.domain;
  }
  if (filters.status) {
    if (!isValidProductStatus(filters.status)) throw new ValidationError(`无效产品状态: ${filters.status}`);
    where.status = filters.status;
  } else {
    // 默认隐藏纯草稿？不——目录管理需要看到草稿。默认展示全部。
  }
  if (filters.sellableOnly) {
    where.skus = { some: { sellable: true, status: PRODUCT_STATUS.ACTIVE } };
  }

  return prisma.product.findMany({
    where,
    include: PRODUCT_LIST_INCLUDE,
    orderBy: [{ status: "asc" }, { productCode: "asc" }],
  });
}

export async function getProductForActor(
  actor: BusinessActor,
  productId: string,
): Promise<ProductDetailRecord> {
  assertCanRead(actor);
  if (!productId) throw new ValidationError("productId is required");
  const product = await prisma.product.findUnique({
    where: { id: productId },
    include: PRODUCT_DETAIL_INCLUDE,
  });
  if (!product) throw new NotFoundError("产品");
  return product;
}

export async function getProductByCodeForActor(
  actor: BusinessActor,
  productCode: string,
): Promise<ProductDetailRecord> {
  assertCanRead(actor);
  if (!productCode) throw new ValidationError("productCode is required");
  const product = await prisma.product.findUnique({
    where: { productCode },
    include: PRODUCT_DETAIL_INCLUDE,
  });
  if (!product) throw new NotFoundError("产品");
  return product;
}

/**
 * GenUI / Agent 订单草稿用的可销售 SKU option 列表。
 * 返回 active + sellable SKU（带 productCode/skuCode/name/spec/unit）。
 *
 * Phase 1 起草稿用 productSkuId 替代旧 serviceCatalogId。
 */
export interface SellableSkuOption {
  productSkuId: string;
  productSkuCode: string;
  productId: string;
  productCode: string;
  productName: string;
  skuName: string;
  displayName: string; // `${productName} / ${skuName}`
  spec: string | null;
  standardUnit: string;
  defaultSalesPrice: number | null; // 分
  sellable: boolean;
  purchasable: boolean;
}

export async function getSellableSkuOptionsForActor(actor: BusinessActor): Promise<SellableSkuOption[]> {
  assertCanRead(actor);
  const skus = await prisma.productSku.findMany({
    where: { status: PRODUCT_STATUS.ACTIVE, sellable: true },
    include: { product: { select: { id: true, productCode: true, name: true } } },
    orderBy: [{ product: { productCode: "asc" } }, { skuCode: "asc" }],
  });
  return skus.map((s) => ({
    productSkuId: s.id,
    productSkuCode: s.skuCode,
    productId: s.product.id,
    productCode: s.product.productCode,
    productName: s.product.name,
    skuName: s.name,
    displayName: `${s.product.name} / ${s.name}`,
    spec: s.spec,
    standardUnit: s.standardUnit,
    defaultSalesPrice: s.defaultSalesPrice,
    sellable: s.sellable,
    purchasable: s.purchasable,
  }));
}

/**
 * 可采购 SKU option 列表（用于报价表单）。
 * 返回 active + purchasable SKU。review #4：报价表单需要 purchasable 而非 sellable。
 */
export async function getPurchasableSkuOptionsForActor(actor: BusinessActor): Promise<SellableSkuOption[]> {
  assertCanRead(actor);
  const skus = await prisma.productSku.findMany({
    where: { status: PRODUCT_STATUS.ACTIVE, purchasable: true },
    include: { product: { select: { id: true, productCode: true, name: true } } },
    orderBy: [{ product: { productCode: "asc" } }, { skuCode: "asc" }],
  });
  return skus.map((s) => ({
    productSkuId: s.id,
    productSkuCode: s.skuCode,
    productId: s.product.id,
    productCode: s.product.productCode,
    productName: s.product.name,
    skuName: s.name,
    displayName: `${s.product.name} / ${s.name}`,
    spec: s.spec,
    standardUnit: s.standardUnit,
    defaultSalesPrice: s.defaultSalesPrice,
    sellable: s.sellable,
    purchasable: s.purchasable,
  }));
}

/**
 * 通过 productSkuId 取 active+sellable SKU（含 product 快照），用于订单行绑定。
 * 不存在或非 active+sellable 返回 null（调用方决定 404/400）。
 */
export async function getActiveSellableSku(productSkuId: string): Promise<{
  id: string;
  skuCode: string;
  name: string;
  spec: string | null;
  standardUnit: string;
  defaultSalesPrice: number | null;
  product: { id: string; productCode: string; name: string };
} | null> {
  const sku = await prisma.productSku.findUnique({
    where: { id: productSkuId },
    include: { product: { select: { id: true, productCode: true, name: true } } },
  });
  if (!sku) return null;
  if (sku.status !== PRODUCT_STATUS.ACTIVE || !sku.sellable) return null;
  return sku;
}

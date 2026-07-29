/**
 * 订单行目录绑定 canonical service。
 *
 * 对应设计文档 §5。在创建订单的同事务内，为每条 OrderLine 原子写入
 * OrderLineServiceMapping（productSkuId 唯一事实源）+ OrderLine 编号快照。
 *
 * 兼容期不变量：productSkuId IS NOT NULL OR serviceKey IS NOT NULL。
 * 所有 Web/Agent/导入写路径必须经此 service，禁止两个字段同时为空。
 *
 * 本模块是 canonical service，允许 Prisma。
 */
import type { Prisma } from "@prisma/client";
import { ValidationError } from "@/lib/application/errors";
import { getActiveSellableSku } from "@/lib/products/application/query-products";

type TransactionClient = Prisma.TransactionClient;

export interface OrderLineCatalogBindingInput {
  /** 真实 ProductSku id（new business 必填）。 */
  productSkuId: string;
  /** 订单行金额等已由 create-order 处理，这里只负责身份绑定。 */
}

export interface PreparedOrderLineBinding {
  /** OrderLine.itemName 展示快照（服务端从 SKU 生成，客户端不可伪造）。 */
  itemName: string;
  spec: string | null;
  unit: string | null;
  /** OrderLine 编号快照。 */
  productCodeSnapshot: string;
  skuCodeSnapshot: string;
  /** 绑定写入所需。 */
  productSkuId: string;
  /** 绑定来源（新业务=AGENT_DRAFT 或 MANUAL）。 */
  source: string;
}

/**
 * 在写事务内校验并准备订单行绑定数据。
 *
 * 调用方（create-order）在 prisma.$transaction 内调用，将返回的
 * itemName/spec/unit/productCodeSnapshot/skuCodeSnapshot 写入 OrderLine，
 * 然后用 productSkuId + source 在同一事务内创建 OrderLineServiceMapping。
 */
export async function prepareOrderLineBindingInTx(
  tx: TransactionClient,
  productSkuId: string,
  source = "AGENT_DRAFT",
): Promise<PreparedOrderLineBinding> {
  if (!productSkuId) {
    throw new ValidationError("productSkuId is required");
  }
  const sku = await getActiveSellableSku(productSkuId);
  if (!sku) {
    // 不存在与非 active+sellable 合并为同一错误（防存在性泄露 + 简单拒绝）
    throw new ValidationError("产品 SKU 不存在或不可销售");
  }

  return {
    // 展示快照：SKU 名称优先，便于历史追溯
    itemName: sku.name,
    spec: sku.spec,
    unit: sku.standardUnit,
    productCodeSnapshot: sku.product.productCode,
    skuCodeSnapshot: sku.skuCode,
    productSkuId: sku.id,
    source,
  };
}

/**
 * 在写事务内为已创建的 OrderLine 原子写入目录绑定。
 * 必须在 OrderLine.create 之后、同一事务内调用。
 */
export async function createOrderLineBindingInTx(
  tx: TransactionClient,
  orderLineId: string,
  binding: PreparedOrderLineBinding,
): Promise<void> {
  await tx.orderLineServiceMapping.create({
    data: {
      orderLineId,
      productSkuId: binding.productSkuId,
      source: binding.source,
      confidence: 1.0,
      confirmedAt: new Date(),
    },
  });
}

/**
 * 兼容期不变量守卫：检查一行映射是否满足 productSkuId 或 serviceKey 至少一个非空。
 * 用于 audit 脚本与 service 层写入后自检。
 */
export function satisfiesCompatibilityInvariant(row: {
  productSkuId: string | null;
  serviceKey: string | null;
}): boolean {
  return row.productSkuId != null || row.serviceKey != null;
}

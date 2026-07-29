/**
 * 未映射订单行治理队列查询 service。
 *
 * 对应设计文档 §5.4、§9.3。提供"哪些订单行还没有 productSkuId 绑定"的统一查询，
 * 供数据质量工作台与治理 API 使用。
 *
 * 本模块是 canonical service，允许 Prisma。
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { BusinessActor } from "@/lib/application/actor";
import { ForbiddenError } from "@/lib/application/errors";

export interface UnmappedOrderLine {
  orderLineId: string;
  orderId: string;
  orderNo: string;
  itemName: string;
  spec: string | null;
  unit: string | null;
  quantity: number | null;
  /** legacy serviceKey（若 OrderLineServiceMapping 有 serviceKey 无 productSkuId）。 */
  legacyServiceKey: string | null;
  /** 候选 SKU 数（按 itemName 精确/别名匹配估算）。 */
  candidateCount: number;
  candidateSkus: Array<{
    productSkuId: string;
    skuCode: string;
    skuName: string;
    productCode: string;
    productName: string;
    matchType: string; // NAME_EXACT | ALIAS | NONE
  }>;
}

const ORDER_LINE_INCLUDE = {
  order: { select: { id: true, orderNo: true, deleted: true } },
  serviceMapping: { select: { productSkuId: true, serviceKey: true } },
} satisfies Prisma.OrderLineInclude;

type OrderLineWithRelations = Prisma.OrderLineGetPayload<{ include: typeof ORDER_LINE_INCLUDE }>;

function assertCanRead(actor: BusinessActor): void {
  if (actor.role !== "ADMIN" && actor.role !== "USER") {
    throw new ForbiddenError("仅内部员工可查看治理队列");
  }
}

/**
 * 查询所有未映射（无 productSkuId 绑定）的订单行，并为每行估算候选 SKU。
 *
 * @param limit 最多返回行数（默认 200）
 */
export async function listUnmappedOrderLinesForActor(
  actor: BusinessActor,
  opts: { limit?: number; orderId?: string } = {},
): Promise<UnmappedOrderLine[]> {
  assertCanRead(actor);
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);

  // 找无 productSkuId 绑定的订单行：左连接 serviceMapping 为空 或 serviceMapping.productSkuId 为空。
  const where: Prisma.OrderLineWhereInput = {
    order: { deleted: false },
    OR: [
      { serviceMapping: null },
      { serviceMapping: { productSkuId: null } },
    ],
  };
  if (opts.orderId) where.orderId = opts.orderId;

  const lines: OrderLineWithRelations[] = await prisma.orderLine.findMany({
    where,
    include: ORDER_LINE_INCLUDE,
    orderBy: { order: { orderedAt: "desc" } },
    take: limit,
  });

  if (lines.length === 0) return [];

  // 批量估算候选：按 itemName 精确匹配 SKU.name 或 ProductAlias
  const itemNames = Array.from(
    new Set(lines.map((l) => l.itemName.trim()).filter(Boolean)),
  );
  const [skusByName, aliases] = await Promise.all([
    itemNames.length > 0
      ? prisma.productSku.findMany({
          where: { name: { in: itemNames }, status: "ACTIVE" },
          include: { product: { select: { productCode: true, name: true } } },
          take: 200,
        })
      : [],
    itemNames.length > 0
      ? prisma.productAlias.findMany({
          where: { normalizedAlias: { in: itemNames.map((n) => n.toLowerCase()) } },
          include: { product: { select: { productCode: true, name: true, skus: { where: { status: "ACTIVE" }, select: { id: true, skuCode: true, name: true } } } } },
          take: 200,
        })
      : [],
  ]);

  const skuByNameMap = new Map<string, typeof skusByName>();
  for (const s of skusByName) {
    const arr = skuByNameMap.get(s.name) ?? [];
    arr.push(s);
    skuByNameMap.set(s.name, arr);
  }
  const aliasMap = new Map<string, typeof aliases>();
  for (const a of aliases) {
    const arr = aliasMap.get(a.normalizedAlias) ?? [];
    arr.push(a);
    aliasMap.set(a.normalizedAlias, arr);
  }

  return lines.map((l) => {
    const name = l.itemName.trim();
    const byName = skuByNameMap.get(name) ?? [];
    const byAlias = aliasMap.get(name.toLowerCase()) ?? [];
    const candidateSkus: UnmappedOrderLine["candidateSkus"] = [];
    const seenSkuIds = new Set<string>();
    for (const s of byName) {
      if (!seenSkuIds.has(s.id)) {
        seenSkuIds.add(s.id);
        candidateSkus.push({
          productSkuId: s.id,
          skuCode: s.skuCode,
          skuName: s.name,
          productCode: s.product.productCode,
          productName: s.product.name,
          matchType: "NAME_EXACT",
        });
      }
    }
    for (const a of byAlias) {
      for (const s of a.product.skus) {
        if (!seenSkuIds.has(s.id)) {
          seenSkuIds.add(s.id);
          candidateSkus.push({
            productSkuId: s.id,
            skuCode: s.skuCode,
            skuName: s.name,
            productCode: a.product.productCode,
            productName: a.product.name,
            matchType: "ALIAS",
          });
        }
      }
    }
    return {
      orderLineId: l.id,
      orderId: l.orderId,
      orderNo: l.order.orderNo,
      itemName: l.itemName,
      spec: l.spec,
      unit: l.unit,
      quantity: l.quantity,
      legacyServiceKey: l.serviceMapping?.serviceKey ?? null,
      candidateCount: candidateSkus.length,
      candidateSkus: candidateSkus.slice(0, 5),
    };
  });
}

/**
 * 批量绑定订单行到 SKU（人工确认映射）。
 * 兼容期不变量守卫：每行必须写 productSkuId（新业务）。
 */
export async function bindOrderLinesForActor(
  actor: BusinessActor,
  bindings: Array<{ orderLineId: string; productSkuId: string; source?: string }>,
): Promise<{ bound: number; skipped: number }> {
  assertCanRead(actor);
  if (bindings.length === 0) return { bound: 0, skipped: 0 };
  if (bindings.length > 500) {
    throw new ForbiddenError("单次批量绑定上限 500 行");
  }

  // 校验所有 SKU 存在且 active
  const skuIds = Array.from(new Set(bindings.map((b) => b.productSkuId)));
  const skus = await prisma.productSku.findMany({
    where: { id: { in: skuIds }, status: "ACTIVE" },
    select: { id: true, skuCode: true, name: true, spec: true, standardUnit: true, product: { select: { productCode: true } } },
  });
  const skuMap = new Map(skus.map((s) => [s.id, s]));
  const validBindings = bindings.filter((b) => skuMap.has(b.productSkuId));

  let bound = 0;
  let skipped = 0;
  await prisma.$transaction(async (tx) => {
    for (const b of validBindings) {
      const sku = skuMap.get(b.productSkuId)!;
      // upsert OrderLineServiceMapping（orderLineId @unique）
      const existing = await tx.orderLineServiceMapping.findUnique({
        where: { orderLineId: b.orderLineId },
      });
      if (existing) {
        if (existing.productSkuId) {
          skipped++;
          continue;
        }
        await tx.orderLineServiceMapping.update({
          where: { orderLineId: b.orderLineId },
          data: {
            productSkuId: b.productSkuId,
            source: b.source ?? "MANUAL",
            confidence: 1.0,
            confirmedById: actor.userId,
            confirmedAt: new Date(),
          },
        });
      } else {
        await tx.orderLineServiceMapping.create({
          data: {
            orderLineId: b.orderLineId,
            productSkuId: b.productSkuId,
            source: b.source ?? "MANUAL",
            confidence: 1.0,
            confirmedById: actor.userId,
            confirmedAt: new Date(),
          },
        });
      }
      // 同步更新 OrderLine 编号快照
      await tx.orderLine.update({
        where: { id: b.orderLineId },
        data: {
          productCodeSnapshot: sku.product.productCode,
          skuCodeSnapshot: sku.skuCode,
        },
      });
      bound++;
    }
    skipped += bindings.length - validBindings.length;
  });

  return { bound, skipped };
}

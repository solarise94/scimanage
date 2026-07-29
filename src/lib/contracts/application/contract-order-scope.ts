/**
 * T8.1a — 合同 ↔ 订单 scope 分类（共享基础，后续 T8.1b/T8.2/T8.4 依赖）。
 *
 * 「全部覆盖订单可见」口径：full / partial / none。
 * - check_coverage：只按 actor scope 内订单查询（scope 天然安全）；
 * - list/detail/download：合同的全部覆盖订单都在 scope 内才可见（partial/none fail-closed）；
 * - generate：要求全部订单 full。
 *
 * 形态镜像 src/lib/finance/application/invoice-order-scope.ts（T6.1）而非跨域 import；
 * 差异：可见集合额外 AND deleted:false（与既有合同列表「scopeWhere + 未删除」
 * 口径一致，见 contracts list 历史实现；finance 镜像未过滤 Order.deleted）。
 * 两处工具 lift 到 orders/application 并统一 deleted 口径计划在 T9 处理。
 */
import type { BusinessActor } from "@/lib/application/actor";
import { prisma } from "@/lib/prisma";
import { getOrderScopeWhere } from "@/lib/orders/permissions";

export type ContractScopeClassification = "full" | "partial" | "none";

/** SQLite 变量上限约 999；IN 分块留余量。 */
const CONTRACT_SCOPE_ID_CHUNK = 500;

/**
 * 加载调用者可见订单 ID 集合。
 * - ADMIN（无 scope 限制）→ null（语义：全量可见）；
 * - 其他角色 → 可见订单集合；空集合写入 "__NO_MATCH__" 哨兵，
 *   使 `Set.has(任意真实 id)` 恒为 false，避免下游把空集合误判为「无限制」。
 *
 * 「可见」统一定义为未删除订单（scopeWhere AND deleted:false，与既有合同列表
 * 口径一致），保证 list/detail 的 coverage 判定不会把软删除订单算作可见。
 */
export async function loadContractScopedOrderIdSet(
  actor: BusinessActor,
): Promise<Set<string> | null> {
  const orderScope = await getOrderScopeWhere(actor.userId, actor.role, prisma, actor.department);
  if (!orderScope) return null;

  const scopedOrders = await prisma.order.findMany({
    where: { AND: [orderScope, { deleted: false }] },
    select: { id: true },
  });
  const set = new Set(scopedOrders.map((o) => o.id));
  if (set.size === 0) {
    set.add("__NO_MATCH__");
  }
  return set;
}

/** 一组覆盖订单相对 scope 集合的可见性分类；空数组 → none。 */
export function classifyContractCoverageScope(
  coveredOrderIds: string[],
  scopedOrderIdSet: ReadonlySet<string> | null,
): ContractScopeClassification {
  if (coveredOrderIds.length === 0) return "none";
  if (scopedOrderIdSet === null) return "full";

  let inScope = 0;
  for (const id of coveredOrderIds) {
    if (scopedOrderIdSet.has(id)) inScope++;
  }
  if (inScope === 0) return "none";
  if (inScope === coveredOrderIds.length) return "full";
  return "partial";
}

/**
 * 列表口径（contracts.list / 非 ADMIN 路径）：合同须至少覆盖一笔订单，
 * 且全部覆盖订单都在可见集合内（严于「任一订单」口径）。
 * ADMIN（set === null）不做订单级过滤（零覆盖合同对 ADMIN 保持可见，C9 统一口径）。
 */
export function isContractFullyVisible(
  orderCoverage: { orderId: string }[],
  scopedOrderIdSet: ReadonlySet<string> | null,
): boolean {
  if (scopedOrderIdSet === null) return true;
  return (
    orderCoverage.length > 0
    && orderCoverage.every((coverage) => scopedOrderIdSet.has(coverage.orderId))
  );
}

/** 合同覆盖的全部订单 ID（detail / download 的全覆盖 scope 断言用）。 */
export async function loadContractCoverageOrderIds(contractId: string): Promise<string[]> {
  const rows = await prisma.orderContractCoverage.findMany({
    where: { contractId },
    select: { orderId: true },
  });
  return rows.map((row) => row.orderId);
}

export function chunkContractScopeIds(ids: string[], size = CONTRACT_SCOPE_ID_CHUNK): string[][] {
  if (ids.length === 0) return [];
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += size) {
    chunks.push(ids.slice(i, i + size));
  }
  return chunks;
}

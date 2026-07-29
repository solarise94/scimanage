/**
 * T8.1a — actor-aware 订单合同覆盖检查。
 *
 * Shared by Agent contracts.check_coverage（Web 当前无对等入口）。
 * 只返回调用者订单 scope 内的订单（scope 在查询条件内天然安全，
 * scope 外订单的 ID/编号/金额/合同状态一概不出现）。
 *
 * §2.5.1 hasContract 口径（isValidCoverageContract）：
 * - 排除生成中断的 PENDING_FILE 记录；
 * - 排除交货单（DELIVERY_NOTE）类别模板的合同（模板已删除时 category 为 null，仍计入）；
 * - 有一份有效合同即为已覆盖；已覆盖不阻止再次生成（仅提示，见 prepare 阶段）。
 */
import type { BusinessActor } from "@/lib/application/actor";
import { ForbiddenError } from "@/lib/application/errors";
import { prisma } from "@/lib/prisma";
import { CONTRACT_CATEGORY } from "@/lib/contracts/constants";
import { getOrderScopeWhere, isOrderAccessBlocked } from "@/lib/orders/permissions";

/** check_coverage 扫描上限，防止无界全表扫描拖垮上下文/数据库。 */
export const CHECK_COVERAGE_SCAN_MAX = 200;

export type CoverageContractRef = {
  contractId: string;
  contractNo: string;
  status: string;
};

export type CheckContractCoverageInput = {
  orderIds?: string[];
  customerId?: string;
  dateRange?: { from?: string; to?: string };
  uncoveredOnly?: boolean;
};

export type CheckContractCoverageOrderItem = {
  orderId: string;
  orderNo: string;
  customerName: string | null;
  totalAmountCents: number;
  hasContract: boolean;
  contracts: CoverageContractRef[];
};

export type CheckContractCoverageResult = {
  orders: CheckContractCoverageOrderItem[];
  uncoveredCount: number;
  totalCount: number;
};

/** §2.5.1 hasContract 判定谓词：not PENDING_FILE 且模板类别 not DELIVERY_NOTE。 */
export function isValidCoverageContract(c: {
  status: string;
  templateCategory: string | null;
}): boolean {
  if (c.status === "PENDING_FILE") return false;
  if (c.templateCategory === CONTRACT_CATEGORY.DELIVERY_NOTE) return false;
  return true;
}

/**
 * 有效覆盖合同按订单分组（check_coverage 与 prepare 阶段重复覆盖提示共用）。
 * 注意：列表口径（contracts.list）只排除 PENDING_FILE、保留 DELIVERY_NOTE，
 * 不得复用本谓词（T8.1b 列表查询保持独立过滤）。
 */
export async function loadValidCoverageByOrderId(
  orderIds: string[],
): Promise<Map<string, CoverageContractRef[]>> {
  if (orderIds.length === 0) return new Map();
  const rows = await prisma.orderContractCoverage.findMany({
    where: { orderId: { in: orderIds } },
    select: {
      orderId: true,
      contract: {
        select: {
          id: true,
          contractNo: true,
          status: true,
          template: { select: { category: true } },
        },
      },
    },
  });
  const map = new Map<string, CoverageContractRef[]>();
  for (const row of rows) {
    if (!isValidCoverageContract({
      status: row.contract.status,
      templateCategory: row.contract.template?.category ?? null,
    })) {
      continue;
    }
    const list = map.get(row.orderId) ?? [];
    list.push({
      contractId: row.contract.id,
      contractNo: row.contract.contractNo,
      status: row.contract.status,
    });
    map.set(row.orderId, list);
  }
  return map;
}

/**
 * 检查调用者可见订单的合同覆盖情况。
 * AND-composition：scope 条件与 orderIds/customerId/dateRange 过滤合并，禁止覆盖 where。
 * uncoveredCount/totalCount 在 uncoveredOnly 过滤前计算（口径不随过滤变化）。
 */
export async function checkContractCoverageForActor(
  actor: BusinessActor,
  input: CheckContractCoverageInput,
): Promise<CheckContractCoverageResult> {
  if (isOrderAccessBlocked(actor.role)) {
    throw new ForbiddenError();
  }

  const scopeWhere = await getOrderScopeWhere(actor.userId, actor.role, prisma, actor.department);

  const andConditions: Record<string, unknown>[] = [{ deleted: false }];
  if (scopeWhere) andConditions.push(scopeWhere);
  if (input.orderIds && input.orderIds.length > 0) {
    andConditions.push({ id: { in: input.orderIds } });
  }
  if (input.customerId) {
    andConditions.push({ profileId: input.customerId });
  }
  if (input.dateRange?.from || input.dateRange?.to) {
    const range: { gte?: Date; lte?: Date } = {};
    if (input.dateRange.from) range.gte = new Date(input.dateRange.from);
    if (input.dateRange.to) range.lte = new Date(input.dateRange.to);
    andConditions.push({ orderedAt: range });
  }

  const orders = await prisma.order.findMany({
    where: { AND: andConditions },
    orderBy: [{ orderedAt: "desc" }, { createdAt: "desc" }],
    take: CHECK_COVERAGE_SCAN_MAX,
    select: {
      id: true,
      orderNo: true,
      totalAmount: true,
      buyerNameSnapshot: true,
      buyerOrgNameSnapshot: true,
      profile: { select: { name: true } },
    },
  });

  const coverageMap = await loadValidCoverageByOrderId(orders.map((o) => o.id));

  let items: CheckContractCoverageOrderItem[] = orders.map((order) => {
    const contracts = coverageMap.get(order.id) ?? [];
    return {
      orderId: order.id,
      orderNo: order.orderNo,
      customerName: order.profile?.name ?? order.buyerOrgNameSnapshot ?? order.buyerNameSnapshot ?? null,
      totalAmountCents: order.totalAmount,
      hasContract: contracts.length > 0,
      contracts,
    };
  });

  const uncoveredCount = items.filter((item) => !item.hasContract).length;
  const totalCount = items.length;

  if (input.uncoveredOnly) {
    items = items.filter((item) => !item.hasContract);
  }

  return { orders: items, uncoveredCount, totalCount };
}

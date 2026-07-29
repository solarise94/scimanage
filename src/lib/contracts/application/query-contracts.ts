/**
 * T8.1b — actor-aware 合同列表查询。
 *
 * Shared by GET /api/contracts 与 Agent contracts.list：
 * - 非 ADMIN：候选来自「coverage ∩ 可见订单集合」，逐合同要求全部覆盖订单可见
 *   （isContractFullyVisible），内存排序分页，total 为过滤后的真实总数
 *   （绝不先数据库分页再过滤）；
 * - ADMIN：全量可见，保持 DB skip/take + count（性能路径）；
 * - 始终排除 PENDING_FILE（状态机中间态）；DELIVERY_NOTE 合同在列表中保留
 *   （与 check_coverage 的 hasContract 口径不同，勿混用谓词）。
 * - 无订单访问权的角色 → ForbiddenError（与 Agent 既有 execute 守卫一致）。
 */
import type { Prisma } from "@prisma/client";
import type { BusinessActor } from "@/lib/application/actor";
import { ForbiddenError } from "@/lib/application/errors";
import { prisma } from "@/lib/prisma";
import { isOrderAccessBlocked } from "@/lib/orders/permissions";
import {
  chunkContractScopeIds,
  isContractFullyVisible,
  loadContractScopedOrderIdSet,
} from "@/lib/contracts/application/contract-order-scope";

const CONTRACT_LIST_INCLUDE = {
  createdBy: { select: { id: true, name: true } },
  orderCoverage: {
    include: { order: { select: { id: true, orderNo: true, title: true } } },
  },
  attachments: {
    where: { source: "GENERATED" },
    select: { id: true, fileName: true, fileUrl: true },
  },
  template: { select: { category: true } },
} satisfies Prisma.ContractDocumentInclude;

export type ContractListRecord = Prisma.ContractDocumentGetPayload<{
  include: typeof CONTRACT_LIST_INCLUDE;
}>;

export type QueryContractsInput = {
  orderId?: string | null;
  customerId?: string | null;
  category?: string | null;
  status?: string | null;
  /** 页码，非法值回退默认 1。 */
  page?: number;
  /** 每页条数，clamp 到 [1, 50]，默认 20。 */
  pageSize?: number;
};

export type QueryContractsResult = {
  contracts: ContractListRecord[];
  total: number;
  page: number;
  pageSize: number;
};

function normalizePage(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 1;
  return Math.max(1, Math.floor(value));
}

function normalizePageSize(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 20;
  return Math.min(50, Math.max(1, Math.floor(value)));
}

/**
 * 非 ADMIN 全可见分页核心：候选 = coverage ∩ visibleOrderIds，逐合同
 * isContractFullyVisible 过滤，createdAt desc 内存排序后切片。
 * total 为过滤后真实总数。SQLite IN 分块（500）防变量上限。
 */
export async function listContractsFullyInScope(params: {
  where: Prisma.ContractDocumentWhereInput;
  visibleOrderIds: ReadonlySet<string>;
  page: number;
  pageSize: number;
}): Promise<{ contracts: ContractListRecord[]; total: number; page: number }> {
  const candidateIds = new Set<string>();
  for (const chunk of chunkContractScopeIds([...params.visibleOrderIds])) {
    const rows = await prisma.orderContractCoverage.findMany({
      where: { orderId: { in: chunk } },
      select: { contractId: true },
      distinct: ["contractId"],
    });
    for (const row of rows) candidateIds.add(row.contractId);
  }
  if (candidateIds.size === 0) {
    return { contracts: [], total: 0, page: params.page };
  }

  const matching: ContractListRecord[] = [];
  for (const chunk of chunkContractScopeIds([...candidateIds])) {
    const rows = await prisma.contractDocument.findMany({
      where: { AND: [params.where, { id: { in: chunk } }] },
      include: CONTRACT_LIST_INCLUDE,
    });
    for (const row of rows) {
      if (isContractFullyVisible(row.orderCoverage, params.visibleOrderIds)) {
        matching.push(row);
      }
    }
  }

  matching.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const total = matching.length;
  const pageItems = matching.slice(
    (params.page - 1) * params.pageSize,
    params.page * params.pageSize,
  );
  return { contracts: pageItems, total, page: params.page };
}

/**
 * orderId 入口门分类（复刻 GET /api/contracts 历史 envelope 行为）：
 * - 有 scope 角色：orderId 必须在可见集合内，否则 "empty"；
 * - ADMIN：订单必须存在且未删除，否则 "empty"。
 * Web route 用 "empty" 产出历史空 envelope `{contracts:[],total:0}`（无 page/pageSize）。
 */
export async function classifyContractOrderGateForActor(
  actor: BusinessActor,
  orderId: string,
): Promise<"pass" | "empty"> {
  const scopedSet = await loadContractScopedOrderIdSet(actor);
  if (scopedSet !== null) {
    return scopedSet.has(orderId) ? "pass" : "empty";
  }
  const order = await prisma.order.findUnique({
    where: { id: orderId, deleted: false },
    select: { id: true },
  });
  return order ? "pass" : "empty";
}

export async function queryContractsForActor(
  actor: BusinessActor,
  input: QueryContractsInput,
): Promise<QueryContractsResult> {
  if (isOrderAccessBlocked(actor.role)) {
    throw new ForbiddenError();
  }

  const page = normalizePage(input.page);
  const pageSize = normalizePageSize(input.pageSize);

  const andConditions: Prisma.ContractDocumentWhereInput[] = [
    { status: { not: "PENDING_FILE" } },
  ];
  if (input.status) andConditions.push({ status: input.status });
  if (input.category) andConditions.push({ template: { category: input.category } });
  if (input.orderId) {
    andConditions.push({ orderCoverage: { some: { orderId: input.orderId } } });
  }
  if (input.customerId) {
    andConditions.push({ orderCoverage: { some: { order: { profileId: input.customerId } } } });
  }
  const where: Prisma.ContractDocumentWhereInput = { AND: andConditions };

  const scopedSet = await loadContractScopedOrderIdSet(actor);

  if (scopedSet === null) {
    // ADMIN：全量可见，DB 分页（保持既有性能路径）。
    const [rows, total] = await Promise.all([
      prisma.contractDocument.findMany({
        where,
        include: CONTRACT_LIST_INCLUDE,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.contractDocument.count({ where }),
    ]);
    return { contracts: rows, total, page, pageSize };
  }

  const { contracts, total } = await listContractsFullyInScope({
    where,
    visibleOrderIds: scopedSet,
    page,
    pageSize,
  });
  return { contracts, total, page, pageSize };
}

/** Agent contracts.list 稳定输出形状（与既有 mapContractListItem 逐键一致）。 */
export function shapeContractListForAgent(row: ContractListRecord) {
  return {
    id: row.id,
    contractNo: row.contractNo,
    status: row.status,
    category: row.template?.category ?? null,
    totalAmountCents: row.totalAmount,
    buyerOrgName: row.buyerOrgName,
    createdAt: row.createdAt.toISOString(),
    coveredOrderCount: row.orderCoverage.length,
  };
}

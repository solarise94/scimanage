/**
 * T8.1b — actor-aware 合同详情查询。
 *
 * Shared by GET /api/contracts/[id] 与 Agent contracts.get_detail：
 * - fail-closed 全覆盖 scope：调用者必须对合同覆盖的全部订单可见；
 *   partial 与 none 一律 NotFoundError（不做裁剪，也不以 403 泄露存在性）；
 * - 零覆盖合同空真可见（C9 统一口径：Web/Agent 一致展示）；
 * - 返回完整领域记录（template 全字段 / createdBy / orderCoverage+order /
 *   全部 source 的 attachments），Web route 原样包 `{contract}` envelope，
 *   Agent adapter 经 shapeContractDetailForAgent 产出稳定 DTO。
 * - assertContractCoverageReadableForActor 同时供 T8.4 下载 route 复用。
 */
import type { Prisma } from "@prisma/client";
import type { BusinessActor } from "@/lib/application/actor";
import { NotFoundError } from "@/lib/application/errors";
import { prisma } from "@/lib/prisma";
import { getOrderScopeWhere } from "@/lib/orders/permissions";

const CONTRACT_DETAIL_INCLUDE = {
  template: true,
  createdBy: { select: { id: true, name: true } },
  orderCoverage: {
    include: { order: { select: { id: true, orderNo: true, title: true, status: true } } },
  },
  attachments: {
    select: {
      id: true,
      fileName: true,
      fileUrl: true,
      fileSize: true,
      mimeType: true,
      source: true,
      createdAt: true,
    },
  },
} satisfies Prisma.ContractDocumentInclude;

export type ContractDetailRecord = Prisma.ContractDocumentGetPayload<{
  include: typeof CONTRACT_DETAIL_INCLUDE;
}>;

/**
 * 断言调用者对一组覆盖订单全部可见。
 * - 零覆盖合同：仅 ADMIN 可读（列表也不向非 ADMIN 展示零覆盖合同，口径一致；
 *   非 ADMIN fail-closed -> NotFound，不泄露存在性）；
 * - 非空覆盖：全部订单须在 actor scope 内（partial/none -> NotFound）。
 * ADMIN（scopeWhere=null）直接通过；未知角色 scopeWhere 为 __NO_MATCH__，
 * 天然 fail-closed。
 */
export async function assertContractCoverageReadableForActor(
  actor: BusinessActor,
  orderIds: string[],
): Promise<void> {
  if (orderIds.length === 0) {
    if (actor.role !== "ADMIN") {
      throw new NotFoundError();
    }
    return;
  }
  const scopeWhere = await getOrderScopeWhere(actor.userId, actor.role, prisma, actor.department);
  if (!scopeWhere) return;
  const accessibleCount = await prisma.order.count({
    where: { AND: [scopeWhere, { id: { in: orderIds } }, { deleted: false }] },
  });
  if (accessibleCount !== orderIds.length) {
    throw new NotFoundError();
  }
}

export async function getContractDetailForActor(
  actor: BusinessActor,
  contractId: string,
): Promise<ContractDetailRecord> {
  const contract = await prisma.contractDocument.findUnique({
    where: { id: contractId },
    include: CONTRACT_DETAIL_INCLUDE,
  });
  if (!contract) {
    throw new NotFoundError();
  }
  await assertContractCoverageReadableForActor(
    actor,
    contract.orderCoverage.map((coverage) => coverage.orderId),
  );
  return contract;
}

/** Agent contracts.get_detail 稳定输出形状（与既有实现逐键一致）。 */
export function shapeContractDetailForAgent(contract: ContractDetailRecord) {
  return {
    contractNo: contract.contractNo,
    status: contract.status,
    category: contract.template?.category ?? null,
    totalAmountCents: contract.totalAmount,
    seller: {
      name: contract.sellerName,
      taxId: contract.sellerTaxId ?? "",
      bankName: contract.sellerBankName ?? "",
      bankAccount: contract.sellerBankAccount ?? "",
      address: contract.sellerAddress ?? "",
      phone: contract.sellerPhone ?? "",
      legalRepresentative: contract.sellerLegalRepresentative ?? "",
    },
    buyer: {
      buyerName: contract.buyerName,
      buyerOrgName: contract.buyerOrgName,
      taxId: contract.buyerTaxId ?? "",
      address: contract.buyerAddress ?? "",
      phone: contract.buyerPhone ?? "",
      email: contract.buyerEmail ?? "",
    },
    coveredOrders: contract.orderCoverage.map((coverage) => ({
      orderId: coverage.orderId,
      orderNo: coverage.order.orderNo,
      title: coverage.order.title,
    })),
    downloadUrl: contract.status === "GENERATED" ? `/api/contracts/${contract.id}/download` : null,
    createdAt: contract.createdAt.toISOString(),
    creatorName: contract.createdBy?.name ?? null,
  };
}

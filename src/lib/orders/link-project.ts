import { Prisma } from "@prisma/client";

export class OrderProjectCustomerConflictError extends Error {
  constructor(
    public orderProfileId: string,
    public projectProfileId: string,
  ) {
    super("订单客户与项目客户不一致");
    this.name = "OrderProjectCustomerConflictError";
  }
}

export class OrderProjectMissingProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrderProjectMissingProfileError";
  }
}

type TransactionClient = Omit<Prisma.TransactionClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends">;

export interface LinkOptions {
  treatment?: string;
  allocatedAmount?: number | null;
  isPrimary?: boolean;
  note?: string | null;
}

export interface RepAssignedSnapshot {
  projectId: string;
  projectName: string;
  representativeId: string;
  representativeName: string;
  representativeEmail: string;
}

export interface LinkResult {
  link: Awaited<ReturnType<TransactionClient["orderProjectLink"]["create"]>>;
  orderUpdateData?: Record<string, unknown>;
  projectUpdateData?: Record<string, unknown>;
  /** snapshot of the representative newly/changed assigned to the project during this link */
  repAssignedToProject: RepAssignedSnapshot | null;
}

/**
 * Link an order to a project with profile conflict check.
 *
 * W5.5：一致性主键为 profileId；Order 与 Project 均须已有 profileId（缺任一 fail-closed），
 * 不再自动回填遗留数据。双方不同 → 冲突；相同 → 建 link。
 */
export async function linkOrderToProject(
  tx: TransactionClient,
  orderId: string,
  projectId: string,
  userId: string,
  options: LinkOptions = {},
): Promise<LinkResult> {
  const [orderInfo, projectInfo] = await Promise.all([
    tx.order.findUnique({
      where: { id: orderId },
      select: {
        profileId: true,
        orderNo: true,
        totalAmount: true,
        financeAmountOverride: true,
      },
    }),
    tx.project.findUnique({
      where: { id: projectId },
      select: {
        name: true,
        profileId: true,
        representativeId: true,
        orderNumber: true,
        budgetAmount: true,
        budgetAmountSource: true,
        budgetCost: true,
      },
    }),
  ]);

  const orderProfileId = orderInfo?.profileId ?? null;
  const projectProfileId = projectInfo?.profileId ?? null;

  if (!orderProfileId || !projectProfileId) {
    throw new OrderProjectMissingProfileError(
      !orderProfileId && !projectProfileId
        ? "迁移数据异常：订单与项目均缺少 profileId，无法绑定。请先完成客户资料迁移。"
        : !orderProfileId
          ? "迁移数据异常：订单缺少 profileId，无法绑定。请先完成客户资料迁移。"
          : "迁移数据异常：项目缺少 profileId，无法绑定。请先完成客户资料迁移。",
    );
  }

  if (orderProfileId !== projectProfileId) {
    throw new OrderProjectCustomerConflictError(orderProfileId, projectProfileId);
  }

  const result: LinkResult = { link: {} as LinkResult["link"], repAssignedToProject: null };

  // Backfill project fields from order (only if project doesn't already have them)
  if (orderInfo) {
    const projectUpdates: Record<string, unknown> = {};
    if (!projectInfo?.orderNumber && orderInfo.orderNo) {
      projectUpdates.orderNumber = orderInfo.orderNo;
    }
    const treatment = options.treatment || "PROJECT_INCLUDED";
    if (
      treatment === "PROJECT_INCLUDED" &&
      projectInfo?.budgetAmount == null &&
      projectInfo?.budgetAmountSource == null
    ) {
      const orderAmount = orderInfo.financeAmountOverride ?? orderInfo.totalAmount;
      const effectiveAmount = options.allocatedAmount ?? orderAmount;
      if (effectiveAmount != null) {
        projectUpdates.budgetAmount = effectiveAmount;
        projectUpdates.budgetAmountSource = "ORDER_LINK";
      }
    }
    if (Object.keys(projectUpdates).length > 0) {
      await tx.project.update({ where: { id: projectId }, data: projectUpdates });
      result.projectUpdateData = projectUpdates;
    }
  }

  result.link = await tx.orderProjectLink.create({
    data: {
      orderId,
      projectId,
      relationType: "LINKED",
      treatment: options.treatment || "PROJECT_INCLUDED",
      allocatedAmount: options.allocatedAmount ?? null,
      isPrimary: options.isPrimary === true,
      note: options.note?.trim() || null,
      createdById: userId,
    },
    include: {
      project: { select: { id: true, name: true, status: true } },
    },
  });

  return result;
}

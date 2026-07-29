/**
 * Canonical actor-aware project invoice request planner (T6.3).
 *
 * Shared by Agent `finance.plan_project_invoice_requests`. Read-only: parses
 * project-linked orders, classifies eligibility, and builds deterministic plans.
 * Out-of-scope orders are excluded without leaking in-scope plan details.
 */
import type { BusinessActor } from "@/lib/application/actor";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "@/lib/application/errors";
import { getOrderInvoiceOccupancy } from "@/lib/finance/order-invoice-amounts";
import type { InvoiceRequestItemInput } from "@/lib/finance/order-invoice-request-write";
import { getOrderEffectiveTreatment } from "@/lib/finance/progress";
import { prisma } from "@/lib/prisma";
import {
  classifySingleOrderScope,
  loadScopedOrderIdSetForActor,
} from "@/lib/finance/application/invoice-order-scope";
import { assertAdminInvoiceRequestWrite } from "@/lib/finance/application/invoice-request-shared";

export type PlanProjectInvoiceRequestsInput = {
  projectId: string;
  orderIds?: string[];
  invoiceType?: "NORMAL" | "SPECIAL";
  sellerProfileId?: string;
  splitMode?: "AUTO" | "ONE_PER_ORDER" | "COMBINE_COMPATIBLE";
  requestedTotalAmountCents?: number;
  allocations?: Array<{ orderId: string; amountCents: number }>;
  contentSummary?: string;
  remark?: string;
};

export type PlanOrderClassification =
  | "ELIGIBLE"
  | "NO_CAPACITY"
  | "PROJECT_INCLUDED"
  | "EXCLUDED"
  | "MISSING_BUYER"
  | "INVALID_BUYER"
  | "ORDER_STATUS_BLOCKED"
  | "OUT_OF_SCOPE";

export type ExcludedOrderInfo = {
  orderId: string;
  orderNo: string;
  reasonCode: PlanOrderClassification;
  message: string;
};

export type InvoiceRequestPlan = {
  planKey: string;
  mainOrderId: string;
  orderNos: string[];
  buyerOrganizationId: string;
  buyerOrganizationName: string;
  sellerProfileId: string | null;
  sellerName: string | null;
  invoiceType: "NORMAL" | "SPECIAL" | null;
  coverageAllocations: Array<{ orderId: string; orderNo: string; amountCents: number }>;
  items: InvoiceRequestItemInput[];
  totalAmountCents: number;
  contentSummary: string | null;
  missingFields: string[];
  warnings: string[];
};

export type PlanQuestion = {
  code: string;
  prompt: string;
  planKey?: string;
};

export type ProjectOrderInvoiceRequestPlanOutput = {
  project: { id: string; projectNo: string | null; name: string };
  status: "READY" | "NEEDS_INPUT" | "NO_ELIGIBLE_ORDERS";
  excludedOrders: ExcludedOrderInfo[];
  plans: InvoiceRequestPlan[];
  questions: PlanQuestion[];
};

/** @deprecated Use ApplicationError from agent adapter; kept for legacy imports. */
export class PlannerError extends Error {
  code: string;
  httpStatus: number;
  constructor(code: string, message: string, httpStatus: number) {
    super(message);
    this.name = "PlannerError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export async function planProjectInvoiceRequestsForActor(
  actor: BusinessActor,
  input: PlanProjectInvoiceRequestsInput,
): Promise<ProjectOrderInvoiceRequestPlanOutput> {
  assertAdminInvoiceRequestWrite(actor);

  const project = await prisma.project.findUnique({
    where: { id: input.projectId },
    select: { id: true, projectNo: true, name: true, deleted: true },
  });
  if (!project || project.deleted) {
    throw new NotFoundError("项目不存在或已删除");
  }

  const links = await prisma.orderProjectLink.findMany({
    where: { projectId: input.projectId },
    select: { orderId: true },
  });
  let linkedOrderIds = links.map((link) => link.orderId);

  if (input.orderIds && input.orderIds.length > 0) {
    const linked = new Set(linkedOrderIds);
    linkedOrderIds = input.orderIds.filter((id) => linked.has(id));
    const injected = input.orderIds.filter((id) => !linked.has(id));
    if (injected.length > 0) {
      throw new ValidationError(`以下订单不属于该项目：${injected.slice(0, 3).join(", ")}`);
    }
  }

  if (linkedOrderIds.length === 0) {
    return {
      project: { id: project.id, projectNo: project.projectNo, name: project.name },
      status: "NO_ELIGIBLE_ORDERS",
      excludedOrders: [],
      plans: [],
      questions: [{ code: "NO_ORDERS", prompt: "该项目没有关联订单，请先完成订单关联。" }],
    };
  }

  const scopedOrderIdSet = await loadScopedOrderIdSetForActor(actor);

  const orders = await prisma.order.findMany({
    where: { id: { in: linkedOrderIds }, deleted: false },
    select: {
      id: true,
      orderNo: true,
      title: true,
      totalAmount: true,
      financeTreatment: true,
      financeAmountOverride: true,
      status: true,
      buyerOrganizationId: true,
      buyerOrganization: {
        select: { id: true, canonicalName: true, isInvoiceSubject: true, deleted: true },
      },
      _count: { select: { projectLinks: true } },
      lines: { select: { itemName: true, amount: true }, take: 10 },
    },
  });

  const orderMap = new Map(orders.map((order) => [order.id, order]));
  const excludedOrders: ExcludedOrderInfo[] = [];

  type EligibleOrder = {
    id: string;
    orderNo: string;
    title: string;
    buyerOrganizationId: string;
    buyerOrganizationName: string;
    remaining: number;
    items: InvoiceRequestItemInput[];
  };
  const eligibleOrders: EligibleOrder[] = [];

  for (const orderId of linkedOrderIds) {
    const order = orderMap.get(orderId);
    if (!order) {
      excludedOrders.push({
        orderId,
        orderNo: "?",
        reasonCode: "OUT_OF_SCOPE",
        message: "订单不存在或已删除",
      });
      continue;
    }

    if (classifySingleOrderScope(orderId, scopedOrderIdSet) !== "full") {
      excludedOrders.push({
        orderId,
        orderNo: order.orderNo || "?",
        reasonCode: "OUT_OF_SCOPE",
        message: "无权查看该订单",
      });
      continue;
    }

    if (order.status === "DRAFT") {
      excludedOrders.push({
        orderId,
        orderNo: order.orderNo || "?",
        reasonCode: "ORDER_STATUS_BLOCKED",
        message: "订单状态为草稿，不允许开票",
      });
      continue;
    }

    const effectiveTreatment = getOrderEffectiveTreatment(
      order.financeTreatment,
      order._count.projectLinks > 0,
    );
    if (effectiveTreatment === "EXCLUDED") {
      excludedOrders.push({
        orderId,
        orderNo: order.orderNo || "?",
        reasonCode: "EXCLUDED",
        message: "订单财务处理方式为 EXCLUDED",
      });
      continue;
    }
    if (effectiveTreatment === "PROJECT_INCLUDED") {
      excludedOrders.push({
        orderId,
        orderNo: order.orderNo || "?",
        reasonCode: "PROJECT_INCLUDED",
        message:
          "订单使用项目财务口径（PROJECT_INCLUDED），不能走订单开票。如需改走订单开票，请先在订单设置中将财务处理方式调整为 STANDALONE。",
      });
      continue;
    }

    if (!order.buyerOrganizationId) {
      excludedOrders.push({
        orderId,
        orderNo: order.orderNo || "?",
        reasonCode: "MISSING_BUYER",
        message: "订单缺少结构化购方机构",
      });
      continue;
    }
    const buyerOrg = order.buyerOrganization;
    if (!buyerOrg || buyerOrg.deleted) {
      excludedOrders.push({
        orderId,
        orderNo: order.orderNo || "?",
        reasonCode: "INVALID_BUYER",
        message: "购方机构不存在或已删除",
      });
      continue;
    }
    if (!buyerOrg.isInvoiceSubject) {
      excludedOrders.push({
        orderId,
        orderNo: order.orderNo || "?",
        reasonCode: "INVALID_BUYER",
        message: "购方机构未完成税务验真（isInvoiceSubject=false）",
      });
      continue;
    }

    const occupancy = await getOrderInvoiceOccupancy(orderId, { activeOnly: true });
    if (occupancy.remaining <= 0) {
      excludedOrders.push({
        orderId,
        orderNo: order.orderNo || "?",
        reasonCode: "NO_CAPACITY",
        message: `剩余可开票额度为 0（容量 ${occupancy.capacity / 100} 元，已占 ${occupancy.occupied / 100} 元）`,
      });
      continue;
    }

    const suggestedItems: InvoiceRequestItemInput[] = order.lines
      .filter((line) => line.itemName?.trim())
      .map((line) => ({
        itemName: line.itemName.trim(),
        amountCents: line.amount ?? 0,
      }));

    eligibleOrders.push({
      id: orderId,
      orderNo: order.orderNo || "?",
      title: order.title || "",
      buyerOrganizationId: order.buyerOrganizationId,
      buyerOrganizationName: buyerOrg.canonicalName || "",
      remaining: occupancy.remaining,
      items:
        suggestedItems.length > 0
          ? suggestedItems
          : [{ itemName: order.title || "技术服务", amountCents: occupancy.remaining }],
    });
  }

  if (eligibleOrders.length === 0) {
    return {
      project: { id: project.id, projectNo: project.projectNo, name: project.name },
      status: "NO_ELIGIBLE_ORDERS",
      excludedOrders,
      plans: [],
      questions: [],
    };
  }

  const questions: PlanQuestion[] = [];
  let allocationMap: Map<string, number>;

  if (input.allocations && input.allocations.length > 0) {
    allocationMap = new Map();
    for (const allocation of input.allocations) {
      allocationMap.set(
        allocation.orderId,
        (allocationMap.get(allocation.orderId) || 0) + allocation.amountCents,
      );
    }
    for (const [orderId, amount] of allocationMap.entries()) {
      const eligible = eligibleOrders.find((order) => order.id === orderId);
      if (!eligible) {
        throw new ValidationError(`订单 ${orderId.slice(-6)} 不在可开票范围内`);
      }
      if (amount > eligible.remaining) {
        throw new ConflictError(
          `订单 ${eligible.orderNo} 分配金额 ${(amount / 100).toFixed(2)} 元超过剩余可开票额度 ${(eligible.remaining / 100).toFixed(2)} 元`,
        );
      }
    }
    if (input.requestedTotalAmountCents != null) {
      const allocTotal = [...allocationMap.values()].reduce((sum, value) => sum + value, 0);
      if (allocTotal !== input.requestedTotalAmountCents) {
        throw new ValidationError(
          `allocations 合计 ${(allocTotal / 100).toFixed(2)} 元与 requestedTotalAmountCents ${(input.requestedTotalAmountCents / 100).toFixed(2)} 元不一致`,
        );
      }
    }
  } else if (input.requestedTotalAmountCents != null && eligibleOrders.length === 1) {
    if (input.requestedTotalAmountCents > eligibleOrders[0].remaining) {
      throw new ConflictError(
        `请求开票金额 ${(input.requestedTotalAmountCents / 100).toFixed(2)} 元超过订单 ${eligibleOrders[0].orderNo} 的剩余可开票额度 ${(eligibleOrders[0].remaining / 100).toFixed(2)} 元`,
      );
    }
    allocationMap = new Map([[eligibleOrders[0].id, input.requestedTotalAmountCents]]);
  } else if (input.requestedTotalAmountCents != null && eligibleOrders.length > 1) {
    return {
      project: { id: project.id, projectNo: project.projectNo, name: project.name },
      status: "NEEDS_INPUT",
      excludedOrders,
      plans: [],
      questions: [
        {
          code: "NEEDS_ALLOCATION",
          prompt: `存在 ${eligibleOrders.length} 笔可开票订单（剩余额度合计 ${eligibleOrders.reduce((sum, order) => sum + order.remaining, 0) / 100} 元），请明确每笔订单的开票金额分配。`,
        },
      ],
    };
  } else {
    allocationMap = new Map(eligibleOrders.map((order) => [order.id, order.remaining]));
  }

  const splitMode = input.splitMode || "AUTO";
  const effectiveSplitMode = splitMode === "AUTO" ? "ONE_PER_ORDER" : splitMode;

  let resolvedSellerProfileId: string | null = input.sellerProfileId || null;
  let resolvedSellerName: string | null = null;
  if (resolvedSellerProfileId) {
    const profile = await prisma.billingProfile.findUnique({ where: { id: resolvedSellerProfileId } });
    if (profile && !profile.archived) {
      resolvedSellerName = profile.name;
    } else {
      resolvedSellerProfileId = null;
    }
  }
  if (!resolvedSellerProfileId) {
    const defaultProfiles = await prisma.billingProfile.findMany({
      where: { isDefault: true, archived: false },
      select: { id: true, name: true },
    });
    if (defaultProfiles.length === 1) {
      resolvedSellerProfileId = defaultProfiles[0].id;
      resolvedSellerName = defaultProfiles[0].name;
    }
  }

  const resolvedInvoiceType: "NORMAL" | "SPECIAL" | null = input.invoiceType || null;

  type GroupKey = string;
  const groups = new Map<GroupKey, EligibleOrder[]>();

  for (const order of eligibleOrders) {
    if (!allocationMap.has(order.id)) continue;

    if (effectiveSplitMode === "ONE_PER_ORDER") {
      groups.set(order.id, [order]);
    } else {
      const key = `${order.buyerOrganizationId}|${resolvedSellerProfileId || "?"}|${resolvedInvoiceType || "?"}`;
      const existing = groups.get(key) || [];
      existing.push(order);
      groups.set(key, existing);
    }
  }

  const plans: InvoiceRequestPlan[] = [];
  let planIndex = 0;

  for (const [, groupOrders] of groups) {
    planIndex++;
    const planKey = `plan-${planIndex}`;
    const mainOrder = groupOrders[0];
    const missingFields: string[] = [];
    const warnings: string[] = [];

    const coverageAllocations = groupOrders.map((order) => ({
      orderId: order.id,
      orderNo: order.orderNo,
      amountCents: allocationMap.get(order.id) || 0,
    }));
    const totalAmountCents = coverageAllocations.reduce((sum, row) => sum + row.amountCents, 0);

    let items: InvoiceRequestItemInput[];
    if (groupOrders.length === 1 && mainOrder.items.length > 0) {
      const originalTotal = mainOrder.items.reduce((sum, item) => sum + item.amountCents, 0);
      if (originalTotal > 0 && originalTotal !== totalAmountCents) {
        items = [{ itemName: mainOrder.items[0].itemName, amountCents: totalAmountCents }];
      } else {
        items = mainOrder.items;
      }
    } else {
      items = [{ itemName: input.contentSummary || "技术服务费", amountCents: totalAmountCents }];
    }

    if (!resolvedSellerProfileId && !resolvedSellerName) {
      missingFields.push("sellerProfileId");
    }
    if (!resolvedInvoiceType) {
      missingFields.push("invoiceType");
    }

    plans.push({
      planKey,
      mainOrderId: mainOrder.id,
      orderNos: groupOrders.map((order) => order.orderNo),
      buyerOrganizationId: mainOrder.buyerOrganizationId,
      buyerOrganizationName: mainOrder.buyerOrganizationName,
      sellerProfileId: resolvedSellerProfileId,
      sellerName: resolvedSellerName,
      invoiceType: resolvedInvoiceType,
      coverageAllocations,
      items,
      totalAmountCents,
      contentSummary: input.contentSummary || null,
      missingFields,
      warnings,
    });
  }

  if (!resolvedSellerProfileId && !resolvedSellerName) {
    const profiles = await prisma.billingProfile.findMany({
      where: { archived: false },
      select: { id: true, name: true, isDefault: true },
    });
    if (profiles.length === 0) {
      questions.push({
        code: "SELLER_PROFILE_REQUIRED",
        prompt: "系统中没有可用的销方主体（BillingProfile），请先在设置中创建。",
      });
    } else if (profiles.length > 1) {
      questions.push({
        code: "SELLER_PROFILE_REQUIRED",
        prompt: `存在 ${profiles.length} 个销方主体（${profiles.map((profile) => profile.name).join("、")}），请选择。`,
      });
    }
  }
  if (!resolvedInvoiceType) {
    questions.push({
      code: "INVOICE_TYPE_REQUIRED",
      prompt: "请指定票种：普票（NORMAL）还是专票（SPECIAL）？",
    });
  }

  const status = questions.length > 0 ? "NEEDS_INPUT" : "READY";

  return {
    project: { id: project.id, projectNo: project.projectNo, name: project.name },
    status,
    excludedOrders,
    plans,
    questions,
  };
}

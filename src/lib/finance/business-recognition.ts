/**
 * 业务确认额（recognition amount）计算
 *
 * 代表绩效金额口径：
 * - 产品订单：下单日期确认 100%。
 * - standalone 服务订单：下单/确认日期确认 30%；进入 DELIVERED 时确认 70%。
 * - PROJECT_INCLUDED 服务：项目 startDate 确认 30%；项目结项（COMPLETED）确认 70%。
 * - PROJECT_INCLUDED 产品：项目 startDate 确认 100%。
 *
 * 输入只认 `profileIds`（CrmCustomerProfile.id）；订单/项目查询只认 `profileId`。
 *
 * 金额单位：分（Int），与 Order.totalAmount / Project.budgetAmount 一致。
 */

import { prisma } from "@/lib/prisma";
import {
  ORDER_STATUS,
  ORDER_CATEGORY,
  ORDER_SOURCE,
} from "@/lib/orders/constants";
import {
  getOrderDate,
  getOrderEffectiveTreatment,
  getProjectStartDate,
  isProductProject,
} from "@/lib/finance/progress";
import { computeOrderFinanceAmount } from "@/lib/finance/progress";
import { ratioCents } from "@/lib/finance/money";
import { getEffectiveOrderWhere } from "@/lib/orders/permissions";

export type BusinessRecognitionPhase =
  | "PRODUCT_100"
  | "SERVICE_START_30"
  | "SERVICE_DELIVERY_70";

export type BusinessRecognitionSubject = "PRODUCT" | "SERVICE" | "EXCLUDED";

export type BusinessRecognitionEvent = {
  /** 经营主体：CrmCustomerProfile.id */
  profileId: string;
  /** 关联订单 ID（standalone 口径） */
  orderId: string | null;
  /** 关联项目 ID（PROJECT_INCLUDED 口径） */
  projectId: string | null;
  /** 确认日期 */
  recognizedAt: Date;
  /** 确认阶段 */
  phase: BusinessRecognitionPhase;
  /** 确认金额，单位分 */
  amountCents: number;
};

export type OrderProjectLinkDetail = {
  projectId: string;
  treatment: string;
  isPrimary: boolean;
};

/**
 * Build orderId → project link details map.
 *
 * Differs from buildOrderProjectLinkMap in order-project-links.ts which only
 * returns a boolean "has links". Recognition needs the actual projectId(s) to
 * derive PROJECT_INCLUDED completion dates.
 */
export async function buildOrderProjectLinkDetailMap(
  orderIds: string[],
): Promise<Map<string, OrderProjectLinkDetail[]>> {
  if (orderIds.length === 0) return new Map();
  const links = await prisma.orderProjectLink.findMany({
    where: { orderId: { in: orderIds } },
    select: { orderId: true, projectId: true, treatment: true, isPrimary: true },
  });
  const map = new Map<string, OrderProjectLinkDetail[]>();
  for (const l of links) {
    const arr = map.get(l.orderId) ?? [];
    arr.push({ projectId: l.projectId, treatment: l.treatment, isPrimary: l.isPrimary });
    map.set(l.orderId, arr);
  }
  return map;
}

/**
 * Get the first time each order entered DELIVERED status.
 * Returns Map<orderId, deliveredAt>. Orders without a DELIVERED history are absent.
 */
export async function getOrderDeliveredAtMap(
  orderIds: string[],
): Promise<Map<string, Date>> {
  if (orderIds.length === 0) return new Map();
  const histories = await prisma.orderStatusHistory.findMany({
    where: { orderId: { in: orderIds }, newStatus: ORDER_STATUS.DELIVERED },
    select: { orderId: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
  const map = new Map<string, Date>();
  for (const h of histories) {
    if (!map.has(h.orderId)) map.set(h.orderId, h.createdAt);
  }
  return map;
}

/**
 * Batch load project completion dates from StatusHistory COMPLETED rows.
 * Falls back to project.endDate in the recognition function if no history row.
 */
export async function getProjectCompletionDateMap(
  projectIds: string[],
): Promise<Map<string, Date>> {
  if (projectIds.length === 0) return new Map();
  const histories = await prisma.statusHistory.findMany({
    where: { projectId: { in: projectIds }, newStatus: "COMPLETED" },
    select: { projectId: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });
  const map = new Map<string, Date>();
  for (const h of histories) {
    if (!map.has(h.projectId)) map.set(h.projectId, h.createdAt);
  }
  return map;
}

/**
 * Classify an order category into the recognition subject used for standalone orders.
 * Only PRODUCT and SERVICE produce recognition events; everything else is excluded.
 */
export function classifyRecognitionSubject(
  category: string | null | undefined,
): BusinessRecognitionSubject {
  if (category === ORDER_CATEGORY.PRODUCT) return "PRODUCT";
  if (category === ORDER_CATEGORY.SERVICE) return "SERVICE";
  return "EXCLUDED";
}

/**
 * Compute business recognition events for CRM profiles（只认 profileIds）。
 */
export async function getBusinessRecognitionEvents({
  profileIds,
  periodStart,
  periodEnd,
}: {
  profileIds?: string[];
  periodStart: Date;
  periodEnd: Date;
}): Promise<BusinessRecognitionEvent[]> {
  const requestedProfileIds = [...new Set((profileIds ?? []).filter(Boolean))];
  if (requestedProfileIds.length === 0) return [];

  const profiles = await prisma.crmCustomerProfile.findMany({
    where: {
      archived: false,
      deleted: false,
      id: { in: requestedProfileIds },
    },
    select: { id: true },
  });

  if (profiles.length === 0) return [];

  const allProfileIds = profiles.map((p) => p.id);

  // 业务确认额订单口径对齐 getEffectiveOrderWhere（与订单页 KPI/聚合一致）：
  //   CONFIRMED + DELIVERED（活跃确认态）∪ CLOSED 且 accrualReversalOfId 非空（计提冲回影子订单）。
  // 普通关闭的 CLOSED 订单不再生成确认事件——它们是终态、已无应收，计入会虚增
  // 代表业务额（典型场景：服务单关闭后仍按 30%/70% 计入代表列表/报告/客单价趋势）。
  // 同时排除 ACCRUAL_REVERSAL 来源（财务冲正影子单，非业务订单，不应进代表业绩）。
  const orderEffectiveWhere = getEffectiveOrderWhere({
    profileId: { in: allProfileIds },
    deleted: false,
    archived: false,
  });

  const [orders, projects] = await Promise.all([
    prisma.order.findMany({
      where: {
        AND: [orderEffectiveWhere, { source: { not: ORDER_SOURCE.ACCRUAL_REVERSAL } }],
      },
      select: {
        id: true,
        profileId: true,
        totalAmount: true,
        financeAmountOverride: true,
        category: true,
        financeTreatment: true,
        orderedAt: true,
        confirmedAt: true,
        createdAt: true,
      },
    }),
    prisma.project.findMany({
      where: {
        profileId: { in: allProfileIds },
        deleted: false,
      },
      select: {
        id: true,
        profileId: true,
        budgetAmount: true,
        projectType: true,
        startDate: true,
        createdAt: true,
        endDate: true,
        status: true,
      },
    }),
  ]);

  const profileIdSet = new Set(allProfileIds);
  const resolveProfileId = (profileId: string | null): string | null =>
    profileId && profileIdSet.has(profileId) ? profileId : null;

  const orderIds = orders.map((o) => o.id);
  const projectIds = projects.map((p) => p.id);

  const [orderLinkMap, deliveredAtMap, completionDateMap] = await Promise.all([
    buildOrderProjectLinkDetailMap(orderIds),
    getOrderDeliveredAtMap(orderIds),
    getProjectCompletionDateMap(projectIds),
  ]);

  const events: BusinessRecognitionEvent[] = [];

  const pushEvent = (
    profileId: string,
    partial: Omit<BusinessRecognitionEvent, "profileId">,
  ) => {
    events.push({
      profileId,
      ...partial,
    });
  };

  // ── Standalone orders ──────────────────────────────────────────
  for (const order of orders) {
    const profileId = resolveProfileId(order.profileId);
    if (!profileId) continue;
    const links = orderLinkMap.get(order.id) ?? [];
    const treatment = getOrderEffectiveTreatment(order.financeTreatment, links.length > 0);
    if (treatment === "EXCLUDED" || treatment === "PROJECT_INCLUDED") continue;

    const subject = classifyRecognitionSubject(order.category);
    if (subject === "EXCLUDED") continue;

    const orderDate = getOrderDate(order);
    const amount = computeOrderFinanceAmount(order);

    if (subject === "PRODUCT") {
      if (orderDate >= periodStart && orderDate <= periodEnd) {
        pushEvent(profileId, {
          orderId: order.id,
          projectId: null,
          recognizedAt: orderDate,
          phase: "PRODUCT_100",
          amountCents: amount,
        });
      }
    } else {
      if (orderDate >= periodStart && orderDate <= periodEnd) {
        pushEvent(profileId, {
          orderId: order.id,
          projectId: null,
          recognizedAt: orderDate,
          phase: "SERVICE_START_30",
          amountCents: ratioCents(amount, 3, 10),
        });
      }
      const deliveredAt = deliveredAtMap.get(order.id);
      if (deliveredAt && deliveredAt >= periodStart && deliveredAt <= periodEnd) {
        pushEvent(profileId, {
          orderId: order.id,
          projectId: null,
          recognizedAt: deliveredAt,
          phase: "SERVICE_DELIVERY_70",
          amountCents: ratioCents(amount, 7, 10),
        });
      }
    }
  }

  // ── Projects (PROJECT_INCLUDED) ────────────────────────────────
  for (const project of projects) {
    const profileId = resolveProfileId(project.profileId);
    if (!profileId) continue;
    const completionDate =
      completionDateMap.get(project.id) ?? (project.endDate ? new Date(project.endDate) : null);
    const startDate = getProjectStartDate(project);
    const budget = project.budgetAmount ?? 0;

    if (isProductProject(project.projectType)) {
      if (startDate >= periodStart && startDate <= periodEnd) {
        pushEvent(profileId, {
          orderId: null,
          projectId: project.id,
          recognizedAt: startDate,
          phase: "PRODUCT_100",
          amountCents: budget,
        });
      }
    } else {
      if (startDate >= periodStart && startDate <= periodEnd) {
        pushEvent(profileId, {
          orderId: null,
          projectId: project.id,
          recognizedAt: startDate,
          phase: "SERVICE_START_30",
          amountCents: ratioCents(budget, 3, 10),
        });
      }
      if (completionDate && completionDate >= periodStart && completionDate <= periodEnd) {
        pushEvent(profileId, {
          orderId: null,
          projectId: project.id,
          recognizedAt: completionDate,
          phase: "SERVICE_DELIVERY_70",
          amountCents: ratioCents(budget, 7, 10),
        });
      }
    }
  }

  return events;
}

/**
 * Aggregate recognition events by profileId.
 */
export function aggregateRecognitionEventsByProfile(
  events: BusinessRecognitionEvent[],
): Map<string, { newBusinessCents: number; deliveryBusinessCents: number; confirmedBusinessCents: number }> {
  const map = new Map<string, { newBusinessCents: number; deliveryBusinessCents: number; confirmedBusinessCents: number }>();
  for (const e of events) {
    const current = map.get(e.profileId) ?? {
      newBusinessCents: 0,
      deliveryBusinessCents: 0,
      confirmedBusinessCents: 0,
    };
    if (e.phase === "PRODUCT_100" || e.phase === "SERVICE_START_30") {
      current.newBusinessCents += e.amountCents;
    }
    if (e.phase === "SERVICE_DELIVERY_70") {
      current.deliveryBusinessCents += e.amountCents;
    }
    current.confirmedBusinessCents += e.amountCents;
    map.set(e.profileId, current);
  }
  return map;
}

/**
 * Aggregate recognition events into period totals.
 */
export function sumRecognitionEvents(events: BusinessRecognitionEvent[]) {
  return events.reduce(
    (acc, e) => {
      if (e.phase === "PRODUCT_100" || e.phase === "SERVICE_START_30") {
        acc.newBusinessCents += e.amountCents;
      }
      if (e.phase === "SERVICE_DELIVERY_70") {
        acc.deliveryBusinessCents += e.amountCents;
      }
      acc.confirmedBusinessCents += e.amountCents;
      return acc;
    },
    { newBusinessCents: 0, deliveryBusinessCents: 0, confirmedBusinessCents: 0 },
  );
}

/**
 * CostSnapshot 重算。
 *
 * 设计文档 §成本汇总与去重规则：
 * - 订单级：只聚合 orderId = subjectId 的 CostEntry，排除软删除订单。
 * - 项目级：聚合 projectId 直记成本 + OrderProjectLink 关联的订单成本，去重。
 * - 客户级：聚合 customerId 直记 + 该客户订单成本 + 该客户项目成本，按 CostEntry.id 去重。
 *
 * 与 financeTreatment 对齐（镜像收入侧）：
 * - STANDALONE：订单成本只归订单，项目级不主动吸收。
 * - PROJECT_INCLUDED：可 rollup 到项目，但按 OrderProjectLink 分摊，不重复计入。
 * - AUTO：有项目关联且 PROJECT_INCLUDED 时按项目口径，否则独立。
 * - EXCLUDED：不进入经营利润成本摘要。
 */
import { prisma } from "@/lib/prisma";
import { COST_SUBJECT_TYPE } from "./constants";
import {
  pickEffectiveCosts,
  aggregateEffectiveCosts,
  type AggregatableCost,
} from "./effective-cost";
import type { RecomputeCostSnapshotParams } from "./types";

/**
 * 收集订单级 CostEntry 行。
 * 排除软删除订单。
 */
async function collectOrderEntries(
  orderId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx?: any,
): Promise<AggregatableCost[]> {
  const db = tx ?? prisma;
  const order = await db.order.findUnique({
    where: { id: orderId },
    select: { deleted: true },
  });
  if (!order || order.deleted) return [];

  const entries = await db.costEntry.findMany({
    where: { subjectType: "ORDER", orderId, status: { not: "CANCELLED" } },
    select: {
      id: true,
      bucket: true,
      status: true,
      amount: true,
      effectiveGroupKey: true,
      sourceType: true,
      sourceKey: true,
    },
  });
  return entries;
}

/**
 * 收集项目级 CostEntry 行（项目直记 + PROJECT_INCLUDED 订单成本分摊）。
 */
async function collectProjectEntries(
  projectId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx?: any,
): Promise<AggregatableCost[]> {
  const db = tx ?? prisma;
  const project = await db.project.findUnique({
    where: { id: projectId },
    select: { deleted: true },
  });
  if (!project || project.deleted) return [];

  const collected = new Map<string, AggregatableCost>();

  // 1. 项目直记成本（subjectType=PROJECT，排除带 orderId 的 ORDER 成本——那些从 OrderProjectLink 分摊进入）
  const directEntries = await db.costEntry.findMany({
    where: { subjectType: "PROJECT", projectId, status: { not: "CANCELLED" } },
    select: {
      id: true,
      bucket: true,
      status: true,
      amount: true,
      effectiveGroupKey: true,
      sourceType: true,
      sourceKey: true,
    },
  });
  for (const e of directEntries) collected.set(e.id, e);

  // 2. 通过 OrderProjectLink 关联的订单成本（仅 PROJECT_INCLUDED 且非 EXCLUDED）
  const links = await db.orderProjectLink.findMany({
    where: { projectId },
    select: {
      orderId: true,
      treatment: true,
      allocatedAmount: true,
      order: {
        select: {
          deleted: true,
          financeTreatment: true,
        },
      },
    },
  });

  // 收集所有涉及的 orderId，用于查询每笔订单的「全部」项目链接（计算分摊比例）
  const involvedOrderIds = Array.from(new Set(links.map((l: { orderId: string }) => l.orderId)));

  // 查询这些订单的全部 OrderProjectLink（含 allocatedAmount），用于计算分摊比例
  const allOrderLinks = involvedOrderIds.length > 0
    ? await db.orderProjectLink.findMany({
        where: { orderId: { in: involvedOrderIds } },
        select: { orderId: true, projectId: true, allocatedAmount: true },
      })
    : [];

  // 按 orderId 分组，计算每笔订单各项目的分摊比例
  const orderLinkMap = new Map<string, { orderId: string; projectId: string; allocatedAmount: number | null }[]>();
  for (const al of allOrderLinks) {
    const arr = orderLinkMap.get(al.orderId);
    if (arr) arr.push(al);
    else orderLinkMap.set(al.orderId, [al]);
  }

  for (const link of links) {
    if (link.order.deleted) continue;
    const treatment = link.order.financeTreatment;
    if (treatment === "EXCLUDED") continue;
    // AUTO 时有项目链接视为 PROJECT_INCLUDED，否则 STANDALONE
    const effective =
      treatment === "AUTO"
        ? "PROJECT_INCLUDED"
        : treatment;
    if (effective !== "PROJECT_INCLUDED") continue; // STANDALONE 不 rollup

    const orderEntries = await db.costEntry.findMany({
      where: { subjectType: "ORDER", orderId: link.orderId, status: { not: "CANCELLED" } },
      select: {
        id: true,
        bucket: true,
        status: true,
        amount: true,
        effectiveGroupKey: true,
        sourceType: true,
        sourceKey: true,
      },
    });

    // 分摊处理（镜像收入侧 §与 financeTreatment 对齐）：
    // - 单一项目链接：整笔成本归入该项目（allocationRate = 1）
    // - 多项目链接 + 有 allocatedAmount：按 link.allocatedAmount / sum(allocatedAmount) 分摊
    // - 多项目链接 + 无 allocatedAmount：不自动均分，跳过（进入异常队列）
    const sameOrderLinks = orderLinkMap.get(link.orderId) ?? [];
    let allocationRate = 1; // 默认整笔

    if (sameOrderLinks.length > 1) {
      const totalAllocated = sameOrderLinks.reduce(
        (s, l) => s + (l.allocatedAmount ?? 0),
        0,
      );
      if (totalAllocated > 0 && link.allocatedAmount != null && link.allocatedAmount > 0) {
        allocationRate = link.allocatedAmount / totalAllocated;
      } else {
        // 多链接且无 allocatedAmount：不自动均分，跳过
        continue;
      }
    }

    for (const e of orderEntries) {
      if (collected.has(e.id)) continue; // 按 id 去重
      collected.set(e.id, {
        ...e,
        amount: Math.round(e.amount * allocationRate),
      });
    }
  }

  return Array.from(collected.values());
}

/**
 * 收集客户级 CostEntry（直记 + 订单 + 项目），按 id 去重。
 * subjectId 语义：CrmCustomerProfile.id（Phase D+）。
 */
async function collectCustomerEntries(
  subjectId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx?: any,
): Promise<AggregatableCost[]> {
  const db = tx ?? prisma;

  const profile = await db.crmCustomerProfile.findFirst({
    where: {
      deleted: false,
      archived: false,
      id: subjectId,
    },
    select: { id: true },
  });

  const profileId = profile?.id ?? null;
  if (!profileId) return [];

  const customerScope = { profileId };

  const collected = new Map<string, AggregatableCost>();

  const directEntries = await db.costEntry.findMany({
    where: {
      subjectType: "CUSTOMER",
      status: { not: "CANCELLED" },
      ...customerScope,
    },
    select: {
      id: true,
      bucket: true,
      status: true,
      amount: true,
      effectiveGroupKey: true,
      sourceType: true,
      sourceKey: true,
    },
  });
  for (const e of directEntries) collected.set(e.id, e);

  const orders = await db.order.findMany({
    where: { deleted: false, ...customerScope },
    select: { id: true },
  });
  for (const o of orders) {
    const orderEntries = await collectOrderEntries(o.id, db);
    for (const e of orderEntries) {
      if (!collected.has(e.id)) collected.set(e.id, e);
    }
  }

  const projects = await db.project.findMany({
    // Phase 0 review #3：成本聚合排除治理桶。
    where: { deleted: false, systemType: "NORMAL", ...customerScope },
    select: { id: true },
  });
  for (const p of projects) {
    const projectEntries = await collectProjectEntries(p.id, db);
    for (const e of projectEntries) {
      if (!collected.has(e.id)) collected.set(e.id, e);
    }
  }

  return Array.from(collected.values());
}

/**
 * 从 CostEntry 聚合当前有效成本，写入 CostSnapshot。
 * 不读取 FinancePayable / FinancePayment。
 */
export async function recomputeCostSnapshot(
  params: RecomputeCostSnapshotParams,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx?: any,
) {
  const { subjectType, subjectId } = params;

  let entries: AggregatableCost[];
  if (subjectType === COST_SUBJECT_TYPE.ORDER) {
    entries = await collectOrderEntries(subjectId, tx);
  } else if (subjectType === COST_SUBJECT_TYPE.PROJECT) {
    entries = await collectProjectEntries(subjectId, tx);
  } else if (subjectType === COST_SUBJECT_TYPE.CUSTOMER) {
    entries = await collectCustomerEntries(subjectId, tx);
  } else {
    throw new Error(`Unsupported subjectType for recompute: ${subjectType}`);
  }

  const effective = pickEffectiveCosts(entries);
  const rollup = aggregateEffectiveCosts(effective);

  // sourceHash：检测快照是否过期（设计文档 §重算触发）
  const sourceHash = entries
    .map((e) => `${e.id}:${e.status}:${e.amount}`)
    .sort()
    .join("|");
  const crypto = await import("crypto");
  const hash = crypto.createHash("sha256").update(sourceHash).digest("hex").slice(0, 16);

  const db = tx ?? prisma;
  await db.costSnapshot.upsert({
    where: {
      subjectType_subjectId: { subjectType, subjectId },
    },
    update: {
      realCost: rollup.realCost,
      circulationCost: rollup.circulationCost,
      taxCost: rollup.taxCost,
      fullCost: rollup.fullCost,
      estimatedCost: rollup.estimatedCost,
      quotedCost: rollup.quotedCost,
      committedCost: rollup.committedCost,
      actualCost: rollup.actualCost,
      settledCost: rollup.settledCost,
      sourceHash: hash,
      recomputedAt: new Date(),
    },
    create: {
      subjectType,
      subjectId,
      realCost: rollup.realCost,
      circulationCost: rollup.circulationCost,
      taxCost: rollup.taxCost,
      fullCost: rollup.fullCost,
      estimatedCost: rollup.estimatedCost,
      quotedCost: rollup.quotedCost,
      committedCost: rollup.committedCost,
      actualCost: rollup.actualCost,
      settledCost: rollup.settledCost,
      sourceHash: hash,
      recomputedAt: new Date(),
    },
  });

  return { subjectType, subjectId, rollup, sourceHash: hash };
}

/**
 * 批量重算多个 subject 的快照。
 * subjectType 应为 ORDER / PROJECT / CUSTOMER；MANUAL 不支持快照。
 */
export async function recomputeSnapshotsForSubjects(
  subjects: { subjectType: "ORDER" | "PROJECT" | "CUSTOMER"; subjectId: string }[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx?: any,
) {
  for (const s of subjects) {
    await recomputeCostSnapshot(s, tx);
  }
}

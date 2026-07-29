import { prisma } from "@/lib/prisma";
import {
  CRM_ACTIVE_COOLDOWN_DAYS,
  CRM_ACTIVE_WARNING_TO_DORMANT_DAYS,
  CRM_COMMUNICATION_TASK_SOURCE_TYPES,
  CRM_DORMANT_THRESHOLD_DAYS,
  CRM_DORMANT_WARNING_DAYS,
  CRM_EFFECTIVE_INTERACTION_TYPES,
} from "@/lib/crm/constants";
import { Prisma, type PrismaClient } from "@prisma/client";

type DbClient = PrismaClient | Prisma.TransactionClient;

type OrderAggregate = {
  activeOrderCount: number;
  historicalOrderCount: number;
  activeOrderAmount: number;
  lastActiveOrderAt: Date | null;
  lastHistoricalOrderAt: Date | null;
  firstOrderAt: Date | null;
};

type ProjectAggregate = {
  activeProjectCount: number;
  lastActiveProjectAt: Date | null;
};

/**
 * Prisma SQLite $queryRaw 返回类型：
 * - COUNT(*) / SUM() → bigint（SQLite 整数）
 * - MAX(DateTime 列) → string（ISO 8601 或遗留格式）
 */
type OrderAggregateRow = {
  profileId: string | null;
  activeOrderCount: bigint;
  historicalOrderCount: bigint;
  activeOrderAmount: bigint | null;
  lastActiveOrderAt: string | null;
  lastHistoricalOrderAt: string | null;
  firstOrderAt: string | null;
};

function normalizeNumber(value: bigint | number | null | undefined): number {
  if (value == null) return 0;
  return typeof value === "bigint" ? Number(value) : value;
}

function normalizeDate(value: Date | string | number | bigint | null | undefined): Date | null {
  if (value == null) return null;
  if (value instanceof Date) return value;
  if (typeof value === "bigint") return new Date(Number(value));
  if (typeof value === "number") return new Date(value);
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export type CrmLifecycleSummary = {
  profileId: string;
  stage: string;
  ownerUserId: string | null;
  assignedAt: Date | null;
  createdAt: Date;
  lastFollowUpAt: Date | null;
  activeOrderCount: number;
  activeOrderAmount: number;
  historicalOrderCount: number;
  lastActiveOrderAt: Date | null;
  lastHistoricalOrderAt: Date | null;
  firstOrderAt: Date | null;
  isRepeatCustomer: boolean;
  lastEffectiveInteractionAt: Date | null;
  nextCommunicationTaskAt: Date | null;
  openCommunicationTaskCount: number;
  overdueCommunicationTaskCount: number;
  dueCommunicationTaskCount30d: number;
  doneCommunicationTaskCount30d: number;
  dormantRisk: boolean;
  dormantCandidate: boolean;
  activeProjectCount: number;
  lastActiveProjectAt: Date | null;
  lastActiveBehaviorEndedAt: Date | null;
  activeCooldownEndsAt: Date | null;
  activeWarningIssuedAt: Date | null;
};

export type StageTransitionEvent =
  | { type: "INTERACTION"; happenedAt: Date; nextActionAt?: Date | null; interactionId?: string }
  | { type: "CHECKIN"; happenedAt: Date; nextActionAt?: Date | null; checkinId?: string }
  | { type: "FOLLOW_UP_CREATED"; taskId: string; dueAt: Date }
  | { type: "FOLLOW_UP_COMPLETED"; taskId: string; completedInteractionId?: string | null; happenedAt?: Date }
  | { type: "FOLLOW_UP_CANCELLED"; taskId: string }
  | { type: "ORDER_CONFIRMED"; orderId: string }
  | { type: "ORDER_CLOSED"; orderId: string }
  | { type: "PROJECT_STARTED"; projectId: string }
  | { type: "PROJECT_ENDED"; projectId: string }
  | { type: "APPLICATION_APPROVED"; applicationId: string }
  | { type: "ACTIVE_COOLDOWN_SCAN" }
  | { type: "ACTIVE_WARNING_SCAN" }
  | { type: "DORMANT_SCAN" }
  | { type: "MANUAL_UPDATE"; actorUserId: string; targetStage: string; reason?: string };

const EFFECTIVE_INTERACTION_TYPE_SET = new Set<string>(CRM_EFFECTIVE_INTERACTION_TYPES);
const COMMUNICATION_TASK_SOURCE_TYPE_SET = new Set<string>(CRM_COMMUNICATION_TASK_SOURCE_TYPES);
const DORMANCY_ELIGIBLE_STAGE_SET = new Set(["LEAD", "CONTACTED", "FOLLOWING", "DORMANT"]);
const LOCKED_STAGES = new Set(["BLOCKED", "LOST"]);

function subtractDays(days: number, now: Date = new Date()) {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

/**
 * 阶段标准化：旧数据中的 NEW 按 CONTACTED 兼容处理
 */
export function normalizeStage(stage: string | null | undefined): string {
  if (!stage) return "LEAD";
  if (stage === "NEW") return "CONTACTED";
  return stage;
}

function isLockedStage(stage: string): boolean {
  return LOCKED_STAGES.has(stage);
}

// ─── Order aggregates ────────────────────────────────────────

async function getOrderAggregatesForProfiles(
  profileIds: string[],
  db: DbClient = prisma,
): Promise<Map<string, OrderAggregate>> {
  const uniqueIds = [...new Set(profileIds.filter(Boolean))];
  if (uniqueIds.length === 0) return new Map();

  const rows = await db.$queryRaw<OrderAggregateRow[]>(Prisma.sql`
    SELECT
      "profileId" AS "profileId",
      COUNT(CASE WHEN "status" IN ('CONFIRMED', 'DELIVERED') THEN 1 END) AS "activeOrderCount",
      COUNT(CASE WHEN "status" IN ('CONFIRMED', 'DELIVERED', 'CLOSED') THEN 1 END) AS "historicalOrderCount",
      SUM(CASE WHEN "status" IN ('CONFIRMED', 'DELIVERED') THEN COALESCE("financeAmountOverride", "totalAmount", 0) ELSE 0 END) AS "activeOrderAmount",
      MAX(CASE WHEN "status" IN ('CONFIRMED', 'DELIVERED') THEN COALESCE("confirmedAt", "orderedAt", "createdAt") END) AS "lastActiveOrderAt",
      MAX(CASE WHEN "status" IN ('CONFIRMED', 'DELIVERED', 'CLOSED') THEN COALESCE("orderedAt", "confirmedAt", "createdAt") END) AS "lastHistoricalOrderAt",
      MIN(CASE WHEN "status" IN ('CONFIRMED', 'DELIVERED', 'CLOSED') THEN COALESCE("orderedAt", "confirmedAt", "createdAt") END) AS "firstOrderAt"
    FROM "Order"
    WHERE "profileId" IN (${Prisma.join(uniqueIds)})
      AND "deleted" = ${false}
      AND "archived" = ${false}
    GROUP BY "profileId"
  `);

  return new Map(
    rows
      .filter((row): row is OrderAggregateRow & { profileId: string } => Boolean(row.profileId))
      .map((row) => [
        row.profileId,
        {
          activeOrderCount: normalizeNumber(row.activeOrderCount),
          historicalOrderCount: normalizeNumber(row.historicalOrderCount),
          activeOrderAmount: normalizeNumber(row.activeOrderAmount),
          lastActiveOrderAt: normalizeDate(row.lastActiveOrderAt),
          lastHistoricalOrderAt: normalizeDate(row.lastHistoricalOrderAt),
          firstOrderAt: normalizeDate(row.firstOrderAt),
        },
      ]),
  );
}

async function getProjectAggregatesForProfiles(
  profileIds: string[],
  db: DbClient = prisma,
): Promise<Map<string, ProjectAggregate>> {
  const uniqueIds = [...new Set(profileIds.filter(Boolean))];
  if (uniqueIds.length === 0) return new Map();

  const projects = await db.project.findMany({
    where: {
      profileId: { in: uniqueIds },
      deleted: false,
      status: "IN_PROGRESS",
    },
    select: { profileId: true, updatedAt: true },
    orderBy: { updatedAt: "desc" },
  });

  const result = new Map<string, ProjectAggregate>();
  for (const project of projects) {
    if (!project.profileId) continue;
    if (!result.has(project.profileId)) {
      result.set(project.profileId, {
        activeProjectCount: 0,
        lastActiveProjectAt: null,
      });
    }
    const agg = result.get(project.profileId)!;
    agg.activeProjectCount += 1;
    if (!agg.lastActiveProjectAt || project.updatedAt > agg.lastActiveProjectAt) {
      agg.lastActiveProjectAt = project.updatedAt;
    }
  }
  return result;
}

/**
 * Phase D：按 profileId 聚合生命周期（含 Profile-only；订单/项目只认 profileId）。
 */
export async function getCrmLifecycleSummaryByProfileId(
  profileId: string,
  db: DbClient = prisma,
  nowInput: Date = new Date(),
): Promise<CrmLifecycleSummary | null> {
  const profile = await db.crmCustomerProfile.findUnique({
    where: { id: profileId },
    select: {
      id: true,
      ownerUserId: true,
      stage: true,
      assignedAt: true,
      createdAt: true,
      lastFollowUpAt: true,
      archived: true,
      assignmentStatus: true,
      lastActiveBehaviorEndedAt: true,
      activeCooldownEndsAt: true,
      activeWarningIssuedAt: true,
    },
  });
  if (!profile || profile.archived) return null;

  const normalizedStage = normalizeStage(profile.stage);
  const now = nowInput;

  const [orderAgg, projectAgg, interactionAgg, taskAgg] = await Promise.all([
    getOrderAggregateForProfile(profile.id, db),
    getProjectAggregateForProfile(profile.id, db),
    getInteractionAggregate(profile.id, db),
    getCommunicationTaskAggregate(profile.id, db),
  ]);

  const dormantWarningDate = subtractDays(CRM_DORMANT_WARNING_DAYS, now);
  const dormantThresholdDate = subtractDays(CRM_DORMANT_THRESHOLD_DAYS, now);
  const dormantBaseAt = profile.lastFollowUpAt ?? profile.assignedAt ?? profile.createdAt;

  const hasActiveSignal = orderAgg.activeOrderCount > 0 || projectAgg.activeProjectCount > 0;

  const dormantRisk = !hasActiveSignal
    && profile.assignmentStatus === "ASSIGNED"
    && DORMANCY_ELIGIBLE_STAGE_SET.has(normalizedStage)
    && dormantBaseAt < dormantWarningDate;

  const dormantCandidate = !hasActiveSignal
    && profile.assignmentStatus === "ASSIGNED"
    && DORMANCY_ELIGIBLE_STAGE_SET.has(normalizedStage)
    && dormantBaseAt < dormantThresholdDate;

  return {
    profileId: profile.id,
    stage: normalizedStage,
    ownerUserId: profile.ownerUserId,
    assignedAt: profile.assignedAt,
    createdAt: profile.createdAt,
    lastFollowUpAt: profile.lastFollowUpAt,
    activeOrderCount: orderAgg.activeOrderCount,
    activeOrderAmount: orderAgg.activeOrderAmount,
    historicalOrderCount: orderAgg.historicalOrderCount,
    lastActiveOrderAt: orderAgg.lastActiveOrderAt,
    lastHistoricalOrderAt: orderAgg.lastHistoricalOrderAt,
    firstOrderAt: orderAgg.firstOrderAt,
    isRepeatCustomer: orderAgg.historicalOrderCount >= 2,
    lastEffectiveInteractionAt: interactionAgg.lastEffectiveInteractionAt,
    nextCommunicationTaskAt: taskAgg.nextCommunicationTaskAt,
    openCommunicationTaskCount: taskAgg.openCommunicationTaskCount,
    overdueCommunicationTaskCount: taskAgg.overdueCommunicationTaskCount,
    dueCommunicationTaskCount30d: taskAgg.dueCommunicationTaskCount30d,
    doneCommunicationTaskCount30d: taskAgg.doneCommunicationTaskCount30d,
    dormantRisk,
    dormantCandidate,
    activeProjectCount: projectAgg.activeProjectCount,
    lastActiveProjectAt: projectAgg.lastActiveProjectAt,
    lastActiveBehaviorEndedAt: profile.lastActiveBehaviorEndedAt,
    activeCooldownEndsAt: profile.activeCooldownEndsAt,
    activeWarningIssuedAt: profile.activeWarningIssuedAt,
  };
}

/** 批量：key = profileId（固定数量查询，按 profileId 组装） */
export async function getCrmLifecycleSummariesForProfiles(
  profileIds: string[],
  db: DbClient = prisma,
  nowInput: Date = new Date(),
): Promise<Map<string, CrmLifecycleSummary>> {
  const uniqueIds = [...new Set(profileIds.filter(Boolean))];
  if (uniqueIds.length === 0) return new Map();

  const profiles = await db.crmCustomerProfile.findMany({
    where: {
      id: { in: uniqueIds },
      archived: false,
    },
    select: {
      id: true,
      ownerUserId: true,
      stage: true,
      assignedAt: true,
      createdAt: true,
      lastFollowUpAt: true,
      assignmentStatus: true,
      lastActiveBehaviorEndedAt: true,
      activeCooldownEndsAt: true,
      activeWarningIssuedAt: true,
    },
  });
  if (profiles.length === 0) return new Map();

  const now = nowInput;
  const d30 = subtractDays(30, now);
  const dormantWarningDate = subtractDays(CRM_DORMANT_WARNING_DAYS, now);
  const dormantThresholdDate = subtractDays(CRM_DORMANT_THRESHOLD_DAYS, now);

  const profileIdList = profiles.map((p) => p.id);

  const [orders, projects, interactions, openTasks, doneTasks30d] = await Promise.all([
    db.order.findMany({
      where: {
        deleted: false,
        archived: false,
        profileId: { in: profileIdList },
      },
      select: {
        profileId: true,
        status: true,
        totalAmount: true,
        financeAmountOverride: true,
        confirmedAt: true,
        orderedAt: true,
        createdAt: true,
      },
    }),
    db.project.findMany({
      where: {
        deleted: false,
        status: "IN_PROGRESS",
        profileId: { in: profileIdList },
      },
      select: { profileId: true, updatedAt: true },
      orderBy: { updatedAt: "desc" },
    }),
    db.crmInteraction.findMany({
      where: {
        profileId: { in: profileIdList },
        type: { in: CRM_EFFECTIVE_INTERACTION_TYPES as unknown as string[] },
      },
      select: { profileId: true, happenedAt: true },
      orderBy: { happenedAt: "desc" },
    }),
    db.crmFollowUpTask.findMany({
      where: {
        profileId: { in: profileIdList },
        status: "OPEN",
        sourceType: { in: CRM_COMMUNICATION_TASK_SOURCE_TYPES as unknown as string[] },
      },
      select: { profileId: true, dueAt: true },
      orderBy: { dueAt: "asc" },
    }),
    db.crmFollowUpTask.findMany({
      where: {
        profileId: { in: profileIdList },
        status: "DONE",
        sourceType: { in: CRM_COMMUNICATION_TASK_SOURCE_TYPES as unknown as string[] },
        completedAt: { gte: d30 },
      },
      select: { profileId: true },
    }),
  ]);

  const emptyOrder = (): OrderAggregate => ({
    activeOrderCount: 0,
    historicalOrderCount: 0,
    activeOrderAmount: 0,
    lastActiveOrderAt: null,
    lastHistoricalOrderAt: null,
    firstOrderAt: null,
  });
  const orderAggMap = new Map<string, OrderAggregate>();
  for (const order of orders) {
    const pid = order.profileId;
    if (!pid) continue;
    const agg = orderAggMap.get(pid) ?? emptyOrder();
    const amount = order.financeAmountOverride ?? order.totalAmount ?? 0;
    const activeAt = order.confirmedAt ?? order.orderedAt ?? order.createdAt;
    const historicalAt = order.orderedAt ?? order.confirmedAt ?? order.createdAt;
    if (order.status === "CONFIRMED" || order.status === "DELIVERED") {
      agg.activeOrderCount += 1;
      agg.activeOrderAmount += amount;
      if (!agg.lastActiveOrderAt || activeAt > agg.lastActiveOrderAt) agg.lastActiveOrderAt = activeAt;
    }
    if (order.status === "CONFIRMED" || order.status === "DELIVERED" || order.status === "CLOSED") {
      agg.historicalOrderCount += 1;
      if (!agg.lastHistoricalOrderAt || historicalAt > agg.lastHistoricalOrderAt) {
        agg.lastHistoricalOrderAt = historicalAt;
      }
      if (!agg.firstOrderAt || historicalAt < agg.firstOrderAt) agg.firstOrderAt = historicalAt;
    }
    orderAggMap.set(pid, agg);
  }

  const projectAggMap = new Map<string, ProjectAggregate>();
  for (const project of projects) {
    const pid = project.profileId;
    if (!pid) continue;
    const current = projectAggMap.get(pid) ?? { activeProjectCount: 0, lastActiveProjectAt: null };
    current.activeProjectCount += 1;
    if (!current.lastActiveProjectAt || project.updatedAt > current.lastActiveProjectAt) {
      current.lastActiveProjectAt = project.updatedAt;
    }
    projectAggMap.set(pid, current);
  }

  const interactionMap = new Map<string, Date>();
  for (const interaction of interactions) {
    if (!interactionMap.has(interaction.profileId)) {
      interactionMap.set(interaction.profileId, interaction.happenedAt);
    }
  }

  const taskAggMap = new Map<string, CommunicationTaskAggregate>();
  for (const task of openTasks) {
    const current = taskAggMap.get(task.profileId) ?? {
      nextCommunicationTaskAt: null,
      openCommunicationTaskCount: 0,
      overdueCommunicationTaskCount: 0,
      dueCommunicationTaskCount30d: 0,
      doneCommunicationTaskCount30d: 0,
    };
    current.openCommunicationTaskCount += 1;
    if (!current.nextCommunicationTaskAt || task.dueAt < current.nextCommunicationTaskAt) {
      current.nextCommunicationTaskAt = task.dueAt;
    }
    if (task.dueAt < now) current.overdueCommunicationTaskCount += 1;
    if (task.dueAt >= d30 && task.dueAt <= now) current.dueCommunicationTaskCount30d += 1;
    taskAggMap.set(task.profileId, current);
  }
  for (const task of doneTasks30d) {
    const current = taskAggMap.get(task.profileId) ?? {
      nextCommunicationTaskAt: null,
      openCommunicationTaskCount: 0,
      overdueCommunicationTaskCount: 0,
      dueCommunicationTaskCount30d: 0,
      doneCommunicationTaskCount30d: 0,
    };
    current.doneCommunicationTaskCount30d += 1;
    taskAggMap.set(task.profileId, current);
  }

  const result = new Map<string, CrmLifecycleSummary>();
  for (const profile of profiles) {
    const normalizedStage = normalizeStage(profile.stage);
    const orderAgg = orderAggMap.get(profile.id) ?? emptyOrder();
    const projectAgg = projectAggMap.get(profile.id) ?? {
      activeProjectCount: 0,
      lastActiveProjectAt: null,
    };
    const taskAgg = taskAggMap.get(profile.id) ?? {
      nextCommunicationTaskAt: null,
      openCommunicationTaskCount: 0,
      overdueCommunicationTaskCount: 0,
      dueCommunicationTaskCount30d: 0,
      doneCommunicationTaskCount30d: 0,
    };
    const dormantBaseAt = profile.lastFollowUpAt ?? profile.assignedAt ?? profile.createdAt;
    const hasActiveSignal = orderAgg.activeOrderCount > 0 || projectAgg.activeProjectCount > 0;
    const dormantRisk = !hasActiveSignal
      && profile.assignmentStatus === "ASSIGNED"
      && DORMANCY_ELIGIBLE_STAGE_SET.has(normalizedStage)
      && dormantBaseAt < dormantWarningDate;
    const dormantCandidate = !hasActiveSignal
      && profile.assignmentStatus === "ASSIGNED"
      && DORMANCY_ELIGIBLE_STAGE_SET.has(normalizedStage)
      && dormantBaseAt < dormantThresholdDate;

    result.set(profile.id, {
      profileId: profile.id,
      stage: normalizedStage,
      ownerUserId: profile.ownerUserId,
      assignedAt: profile.assignedAt,
      createdAt: profile.createdAt,
      lastFollowUpAt: profile.lastFollowUpAt,
      activeOrderCount: orderAgg.activeOrderCount,
      activeOrderAmount: orderAgg.activeOrderAmount,
      historicalOrderCount: orderAgg.historicalOrderCount,
      lastActiveOrderAt: orderAgg.lastActiveOrderAt,
      lastHistoricalOrderAt: orderAgg.lastHistoricalOrderAt,
      firstOrderAt: orderAgg.firstOrderAt,
      isRepeatCustomer: orderAgg.historicalOrderCount >= 2,
      lastEffectiveInteractionAt: interactionMap.get(profile.id) ?? null,
      nextCommunicationTaskAt: taskAgg.nextCommunicationTaskAt,
      openCommunicationTaskCount: taskAgg.openCommunicationTaskCount,
      overdueCommunicationTaskCount: taskAgg.overdueCommunicationTaskCount,
      dueCommunicationTaskCount30d: taskAgg.dueCommunicationTaskCount30d,
      doneCommunicationTaskCount30d: taskAgg.doneCommunicationTaskCount30d,
      dormantRisk,
      dormantCandidate,
      activeProjectCount: projectAgg.activeProjectCount,
      lastActiveProjectAt: projectAgg.lastActiveProjectAt,
      lastActiveBehaviorEndedAt: profile.lastActiveBehaviorEndedAt,
      activeCooldownEndsAt: profile.activeCooldownEndsAt,
      activeWarningIssuedAt: profile.activeWarningIssuedAt,
    });
  }

  return result;
}

// ─── 核心阶段计算 ────────────────────────────────────────────

/**
 * 按优先级计算目标阶段（纯函数，无数据库写入）
 *
 * 优先级（从高到低）：
 * 1. BLOCKED / LOST：人工锁定，不被普通自动规则覆盖
 * 2. 存在进行中业务信号：ACTIVE
 * 3. 无进行中业务但仍在 ACTIVE 冷却期内：ACTIVE
 * 4. ACTIVE warning 后 30 天仍无有效沟通或 ACTIVE 行为：DORMANT
 * 5. 普通休眠扫描命中：DORMANT
 * 6. ACTIVE 冷却期到期后发出 warning：FOLLOWING
 * 7. 存在开放销售跟进任务：FOLLOWING
 * 8. 存在有效沟通记录：CONTACTED
 * 9. 未发生有效沟通：LEAD
 */
export function computeCrmStage(
  profile: {
    stage: string;
    lastActiveBehaviorEndedAt: Date | null;
    activeCooldownEndsAt: Date | null;
    activeWarningIssuedAt: Date | null;
    assignmentStatus: string;
    lastFollowUpAt: Date | null;
    assignedAt: Date | null;
    createdAt: Date;
  },
  signals: {
    hasActiveOrder: boolean;
    hasActiveProject: boolean;
    lastEffectiveInteractionAt: Date | null;
    openCommunicationTaskCount: number;
  },
): { nextStage: string; reason: string } {
  const now = new Date();
  const normalizedCurrentStage = normalizeStage(profile.stage);

  // 1. 锁定阶段不覆盖
  if (isLockedStage(normalizedCurrentStage)) {
    return { nextStage: normalizedCurrentStage, reason: "LOCKED_STAGE_PRESERVED" };
  }

  // 2. 存在进行中业务信号 → ACTIVE
  if (signals.hasActiveOrder || signals.hasActiveProject) {
    return { nextStage: "ACTIVE", reason: "ACTIVE_SIGNAL_PRESENT" };
  }

  // 3. 仍在 ACTIVE 冷却期内 → ACTIVE
  if (profile.activeCooldownEndsAt && profile.activeCooldownEndsAt > now) {
    return { nextStage: "ACTIVE", reason: "ACTIVE_COOLDOWN" };
  }

  // 4. ACTIVE warning 后 30 天仍无有效沟通或 ACTIVE 行为 → DORMANT
  if (profile.activeWarningIssuedAt) {
    const warningThreshold = new Date(
      profile.activeWarningIssuedAt.getTime() + CRM_ACTIVE_WARNING_TO_DORMANT_DAYS * 24 * 60 * 60 * 1000,
    );
    const hasRecentActivity = signals.lastEffectiveInteractionAt
      && signals.lastEffectiveInteractionAt > profile.activeWarningIssuedAt;
    if (now >= warningThreshold && !hasRecentActivity) {
      return { nextStage: "DORMANT", reason: "ACTIVE_WARNING_DORMANT" };
    }
  }

  // 5. 普通休眠扫描
  const dormantBaseAt = profile.lastFollowUpAt ?? profile.assignedAt ?? profile.createdAt;
  const dormantThresholdDate = subtractDays(CRM_DORMANT_THRESHOLD_DAYS);
  const isDormantEligible = DORMANCY_ELIGIBLE_STAGE_SET.has(normalizedCurrentStage);
  if (
    isDormantEligible
    && profile.assignmentStatus === "ASSIGNED"
    && dormantBaseAt < dormantThresholdDate
    && !signals.hasActiveOrder
    && !signals.hasActiveProject
  ) {
    return { nextStage: "DORMANT", reason: "DORMANT_SCAN" };
  }

  // 6. ACTIVE 冷却期到期后发出 warning → FOLLOWING
  if (profile.activeCooldownEndsAt && profile.activeCooldownEndsAt <= now && normalizedCurrentStage === "ACTIVE") {
    return { nextStage: "FOLLOWING", reason: "ACTIVE_COOLDOWN_WARNING" };
  }

  // 7. 存在开放销售跟进任务 → FOLLOWING
  if (signals.openCommunicationTaskCount > 0) {
    return { nextStage: "FOLLOWING", reason: "OPEN_FOLLOW_UP_TASK" };
  }

  // 8. 存在有效沟通记录 → CONTACTED
  if (signals.lastEffectiveInteractionAt) {
    return { nextStage: "CONTACTED", reason: "EFFECTIVE_COMMUNICATION" };
  }

  // 9. 默认 → LEAD
  return { nextStage: "LEAD", reason: "NO_EFFECTIVE_COMMUNICATION" };
}

// ─── 统一阶段转移入口 ────────────────────────────────────────

export async function transitionCrmStage(
  profileId: string,
  event: StageTransitionEvent,
  db: DbClient = prisma,
): Promise<{
  profileId: string;
  previousStage: string;
  nextStage: string;
  changed: boolean;
  reason: string;
} | null> {
  const profile = await db.crmCustomerProfile.findUnique({
    where: { id: profileId },
    select: {
      id: true,
      ownerUserId: true,
      stage: true,
      lastFollowUpAt: true,
      assignedAt: true,
      createdAt: true,
      assignmentStatus: true,
      lastActiveBehaviorEndedAt: true,
      activeCooldownEndsAt: true,
      activeWarningIssuedAt: true,
    },
  });
  if (!profile) return null;

  const normalizedCurrentStage = normalizeStage(profile.stage);

  // Phase D：运行时业务信号只认 profileId。
  const profileScope = { profileId: profile.id };
  const [orderSignals, projectSignals, interactionAgg, taskAgg] = await Promise.all([
    db.order.findFirst({
      where: {
        ...profileScope,
        deleted: false,
        archived: false,
        status: "CONFIRMED",
      },
      select: { id: true },
    }),
    db.project.findFirst({
      where: {
        ...profileScope,
        deleted: false,
        status: "IN_PROGRESS",
      },
      select: { id: true },
    }),
    getInteractionAggregate(profileId, db),
    getCommunicationTaskAggregate(profileId, db),
  ]);

  const signals = {
    hasActiveOrder: !!orderSignals,
    hasActiveProject: !!projectSignals,
    lastEffectiveInteractionAt: interactionAgg.lastEffectiveInteractionAt,
    openCommunicationTaskCount: taskAgg.openCommunicationTaskCount,
  };

  // 处理特定事件对冷却期字段的影响
  let activeCooldownEndsAt = profile.activeCooldownEndsAt;
  let lastActiveBehaviorEndedAt = profile.lastActiveBehaviorEndedAt;
  let activeWarningIssuedAt = profile.activeWarningIssuedAt;
  let nextStage: string = normalizedCurrentStage;
  let reason: string = "NO_CHANGE";

  // MANUAL_UPDATE：人工强制改阶段，不走自动推导
  if (event.type === "MANUAL_UPDATE") {
    const manualEvent = event as Extract<StageTransitionEvent, { type: "MANUAL_UPDATE" }>;
    const allowedManualStages = new Set(["BLOCKED", "LOST", "CONTACTED", "FOLLOWING", "LEAD", "DORMANT"]);
    if (!allowedManualStages.has(manualEvent.targetStage)) {
      throw new Error(`MANUAL_UPDATE 不允许将阶段改为 ${manualEvent.targetStage}`);
    }
    nextStage = manualEvent.targetStage;
    reason = manualEvent.reason || "MANUAL_UPDATE";
  } else if (event.type === "APPLICATION_APPROVED") {
    // 审批通过：业务语义即“已联系”，直接设为 CONTACTED
    nextStage = "CONTACTED";
    reason = "APPLICATION_APPROVED";
  } else {
    // 事件驱动冷却期更新（仅自动规则分支）
    let skipCompute = false;

    if (event.type === "ORDER_CONFIRMED" || event.type === "PROJECT_STARTED") {
      // ACTIVE 信号出现，清除冷却期和 warning
      activeCooldownEndsAt = null;
      lastActiveBehaviorEndedAt = null;
      activeWarningIssuedAt = null;
    } else if (event.type === "ORDER_CLOSED" || event.type === "PROJECT_ENDED") {
      // ACTIVE 信号结束，只在「最后一个 ACTIVE 信号」结束时启动冷却期
      const stillHasActiveOrder = await db.order.findFirst({
        where: {
          ...profileScope,
          deleted: false,
          archived: false,
          status: "CONFIRMED",
        },
        select: { id: true },
      });
      const stillHasActiveProject = await db.project.findFirst({
        where: {
          ...profileScope,
          deleted: false,
          status: "IN_PROGRESS",
        },
        select: { id: true },
      });
      if (!stillHasActiveOrder && !stillHasActiveProject) {
        const now = new Date();
        lastActiveBehaviorEndedAt = now;
        activeCooldownEndsAt = new Date(now.getTime() + CRM_ACTIVE_COOLDOWN_DAYS * 24 * 60 * 60 * 1000);
        activeWarningIssuedAt = null;
      }
      // 若仍有其它 ACTIVE 信号，不改冷却期字段
    } else if (event.type === "ACTIVE_COOLDOWN_SCAN") {
      // 冷却期到期，发出 warning
      if (activeCooldownEndsAt && activeCooldownEndsAt <= new Date() && normalizedCurrentStage === "ACTIVE") {
        activeWarningIssuedAt = new Date();
      }
    } else if (event.type === "ACTIVE_WARNING_SCAN") {
      // warning 后扫描，不需要额外更新冷却期字段
    } else if (event.type === "INTERACTION" || event.type === "CHECKIN" || event.type === "FOLLOW_UP_CREATED") {
      // 有效沟通/跟进任务会重置 lastFollowUpAt，影响休眠判断
      // 如果当前在 ACTIVE warning 后，有效沟通可清除 warning
      if (activeWarningIssuedAt && signals.lastEffectiveInteractionAt && signals.lastEffectiveInteractionAt > activeWarningIssuedAt) {
        activeWarningIssuedAt = null;
      }
    } else if (event.type === "FOLLOW_UP_COMPLETED") {
      const fuEvent = event as Extract<StageTransitionEvent, { type: "FOLLOW_UP_COMPLETED" }>;
      if (!fuEvent.completedInteractionId) {
        // 未关联有效互动：不能制造 CONTACTED/LEAD，也不能压住 ACTIVE
        if (signals.hasActiveOrder || signals.hasActiveProject) {
          nextStage = "ACTIVE";
          reason = "ACTIVE_SIGNAL_PRESENT";
          skipCompute = true;
        } else if (normalizedCurrentStage === "FOLLOWING" || signals.openCommunicationTaskCount > 0) {
          nextStage = "FOLLOWING";
          reason = "FOLLOW_UP_COMPLETED_WITHOUT_INTERACTION_KEEP_FOLLOWING";
          skipCompute = true;
        }
      } else if (
        activeWarningIssuedAt
        && signals.lastEffectiveInteractionAt
        && signals.lastEffectiveInteractionAt > activeWarningIssuedAt
      ) {
        // 有关联互动且发生在 warning 之后，清除 warning
        activeWarningIssuedAt = null;
      }
    }

    if (!skipCompute) {
      ({ nextStage, reason } = computeCrmStage(
        {
          stage: normalizedCurrentStage,
          lastActiveBehaviorEndedAt,
          activeCooldownEndsAt,
          activeWarningIssuedAt,
          assignmentStatus: profile.assignmentStatus,
          lastFollowUpAt: profile.lastFollowUpAt,
          assignedAt: profile.assignedAt,
          createdAt: profile.createdAt,
        },
        signals,
      ));
    }
  }

  const changed = normalizedCurrentStage !== nextStage;

  // 强制记历史的关键业务事件（即使阶段未变化）
  const forceHistoryEvents = new Set(["MANUAL_UPDATE", "APPLICATION_APPROVED"]);
  const shouldLogHistory = changed || forceHistoryEvents.has(event.type);

  if (shouldLogHistory) {
    const manualEvent = event.type === "MANUAL_UPDATE"
      ? (event as Extract<StageTransitionEvent, { type: "MANUAL_UPDATE" }>)
      : null;
    const appEvent = event.type === "APPLICATION_APPROVED"
      ? (event as Extract<StageTransitionEvent, { type: "APPLICATION_APPROVED" }>)
      : null;
    await db.crmCustomerStageHistory.create({
      data: {
        profileId: profile.id,
        ownerUserId: profile.ownerUserId,
        previousStage: normalizedCurrentStage,
        nextStage,
        reason,
        actorUserId: manualEvent?.actorUserId ?? null,
        sourceType: event.type,
        sourceId: extractSourceId(event),
        metadataJson: manualEvent?.reason
          ? JSON.stringify({ manualReason: manualEvent.reason, targetStage: manualEvent.targetStage })
          : appEvent
            ? JSON.stringify({ trigger: "approve_bind", stageChanged: changed })
            : null,
      },
    });
  }

  // 轻量断言：ACTIVE 信号存在时，不应被非人工规则降级到 FOLLOWING/CONTACTED/LEAD/DORMANT
  if ((signals.hasActiveOrder || signals.hasActiveProject)
    && event.type !== "MANUAL_UPDATE"
    && !["ACTIVE", "BLOCKED", "LOST"].includes(nextStage)
  ) {
    console.warn(
      `[CRM][LIFECYCLE] ACTIVE signal present but nextStage=${nextStage} for profile ${profileId}. ` +
      `Event=${event.type}, current=${normalizedCurrentStage}`
    );
  }

  // 更新 profile
  const updateData: Record<string, unknown> = {
    stage: nextStage,
    lastActiveBehaviorEndedAt,
    activeCooldownEndsAt,
    activeWarningIssuedAt,
  };

  // 跟进任务相关字段更新
  if (event.type === "FOLLOW_UP_CREATED" || event.type === "FOLLOW_UP_COMPLETED" || event.type === "FOLLOW_UP_CANCELLED") {
    updateData.nextFollowUpAt = taskAgg.nextCommunicationTaskAt;
  }

  if (event.type === "INTERACTION" || event.type === "CHECKIN") {
    const e = event as Extract<StageTransitionEvent, { type: "INTERACTION" | "CHECKIN" }>;
    updateData.lastFollowUpAt = e.happenedAt;
    if (e.nextActionAt) {
      updateData.nextFollowUpAt = e.nextActionAt;
    }
  }

  await db.crmCustomerProfile.update({
    where: { id: profileId },
    data: updateData,
  });

  return {
    profileId: profile.id,
    previousStage: normalizedCurrentStage,
    nextStage,
    changed,
    reason,
  };
}

function extractSourceId(event: StageTransitionEvent): string | null {
  switch (event.type) {
    case "INTERACTION": return event.interactionId ?? null;
    case "CHECKIN": return event.checkinId ?? null;
    case "FOLLOW_UP_CREATED":
    case "FOLLOW_UP_COMPLETED":
    case "FOLLOW_UP_CANCELLED": return event.taskId;
    case "ORDER_CONFIRMED":
    case "ORDER_CLOSED": return event.orderId;
    case "PROJECT_STARTED":
    case "PROJECT_ENDED": return event.projectId;
    case "APPLICATION_APPROVED": return event.applicationId;
    default: return null;
  }
}

// ─── 互动后生命周期同步 ──────────────────────────────────────

export async function syncCrmLifecycleAfterInteraction(
  profileId: string,
  params: { happenedAt: Date; nextActionAt?: Date | null; actorUserId?: string | null },
  db: DbClient = prisma,
): Promise<void> {
  // 先处理跟进任务创建（如果 nextActionAt 存在）
  if (params.nextActionAt) {
    const profile = await db.crmCustomerProfile.findUnique({
      where: { id: profileId },
      select: { ownerUserId: true },
    });
    if (profile) {
      const taskOwnerUserId = profile.ownerUserId ?? params.actorUserId;
      if (!taskOwnerUserId) {
        // P1 修复：无合法 owner 时跳过任务创建，不写空字符串外键
        console.warn(`[CRM_LIFECYCLE] skip follow-up for profile=${profileId}: no valid owner`);
      } else {
      await db.crmFollowUpTask.upsert({
        where: {
          sourceOpenKey: `crm-communication:${profileId}:${params.happenedAt.toISOString()}`,
        },
        update: {
          dueAt: params.nextActionAt,
          title: "沟通后续跟进",
          ownerUserId: taskOwnerUserId,
          taskType: "CONTACT",
        },
        create: {
          profileId,
          ownerUserId: taskOwnerUserId,
          title: "沟通后续跟进",
          dueAt: params.nextActionAt,
          taskType: "CONTACT",
          createdByUserId: params.actorUserId || taskOwnerUserId,
          sourceType: "CRM_COMMUNICATION",
          sourceId: `${profileId}:${params.happenedAt.toISOString()}`,
          sourceOpenKey: `crm-communication:${profileId}:${params.happenedAt.toISOString()}`,
        },
      });
      }
    }
  }

  await transitionCrmStage(profileId, {
    type: "INTERACTION",
    happenedAt: params.happenedAt,
    nextActionAt: params.nextActionAt,
  }, db);
}

// ─── 休眠扫描 ────────────────────────────────────────────────

export async function scanDormantCrmProfiles(
  params?: { dormantDays?: number; warningDays?: number; dryRun?: boolean; actorUserId?: string | null },
  db: DbClient = prisma,
): Promise<{ scannedCount: number; warnedCount: number; dormantCount: number }> {
  const dormantDays = params?.dormantDays ?? CRM_DORMANT_THRESHOLD_DAYS;
  const warningDays = params?.warningDays ?? CRM_DORMANT_WARNING_DAYS;
  const dryRun = params?.dryRun ?? false;
  const now = new Date();
  const dormantThresholdDate = new Date(now.getTime() - dormantDays * 24 * 60 * 60 * 1000);
  const warningThresholdDate = new Date(now.getTime() - warningDays * 24 * 60 * 60 * 1000);

  const profiles = await db.crmCustomerProfile.findMany({
    where: {
      archived: false,
      assignmentStatus: "ASSIGNED",
    },
    select: {
      id: true,
      ownerUserId: true,
      stage: true,
      assignedAt: true,
      createdAt: true,
      lastFollowUpAt: true,
      lastOrderAt: true,
      nextFollowUpAt: true,
      assignmentStatus: true,
      lastActiveBehaviorEndedAt: true,
      activeCooldownEndsAt: true,
      activeWarningIssuedAt: true,
    },
  });

  let warnedCount = 0;
  let dormantCount = 0;

  for (const profile of profiles) {
    const normalizedStage = normalizeStage(profile.stage);
    const profileScope = { profileId: profile.id };

    // 快速查询当前 ACTIVE 信号
    const [orderSignals, projectSignals] = await Promise.all([
      db.order.findFirst({
        where: {
          ...profileScope,
          deleted: false,
          archived: false,
          status: "CONFIRMED",
        },
        select: { id: true },
      }),
      db.project.findFirst({
        where: {
          ...profileScope,
          deleted: false,
          status: "IN_PROGRESS",
        },
        select: { id: true },
      }),
    ]);

    const hasActiveSignal = !!orderSignals || !!projectSignals;
    if (hasActiveSignal) continue;

    // 判断应该触发哪种扫描事件
    let eventType: "ACTIVE_COOLDOWN_SCAN" | "ACTIVE_WARNING_SCAN" | "DORMANT_SCAN" | null = null;

    if (profile.activeCooldownEndsAt && profile.activeCooldownEndsAt <= now && normalizedStage === "ACTIVE") {
      eventType = "ACTIVE_COOLDOWN_SCAN";
    } else if (profile.activeWarningIssuedAt) {
      const warningThreshold = new Date(
        profile.activeWarningIssuedAt.getTime() + CRM_ACTIVE_WARNING_TO_DORMANT_DAYS * 24 * 60 * 60 * 1000,
      );
      if (now >= warningThreshold) {
        eventType = "ACTIVE_WARNING_SCAN";
      }
    } else if (DORMANCY_ELIGIBLE_STAGE_SET.has(normalizedStage)) {
      const baseAt = profile.lastFollowUpAt ?? profile.assignedAt ?? profile.createdAt;
      if (baseAt < dormantThresholdDate) {
        eventType = "DORMANT_SCAN";
      } else if (baseAt < warningThresholdDate) {
        warnedCount += 1;
        if (!dryRun) {
          const dormantTaskOwnerUserId = profile.ownerUserId ?? params?.actorUserId;
          if (dormantTaskOwnerUserId) {
          await db.crmFollowUpTask.upsert({
            where: { sourceOpenKey: `crm-dormant-warning:${profile.id}` },
            update: {
              dueAt: now,
              title: "休眠预警跟进",
              ownerUserId: dormantTaskOwnerUserId,
              status: "OPEN",
              taskType: "CONTACT",
            },
            create: {
              profileId: profile.id,
              ownerUserId: dormantTaskOwnerUserId,
              title: "休眠预警跟进",
              dueAt: now,
              taskType: "CONTACT",
              sourceType: "CRM_DORMANT_WARNING",
              sourceId: profile.id,
              sourceOpenKey: `crm-dormant-warning:${profile.id}`,
              createdByUserId: params?.actorUserId || dormantTaskOwnerUserId,
            },
          });
          } else {
            console.warn(`[CRM_LIFECYCLE] skip dormant warning task for profile=${profile.id}: no valid owner`);
          }
        }
      }
    }

    if (eventType && !dryRun) {
      const result = await transitionCrmStage(profile.id, { type: eventType }, db);
      if (result?.changed) {
        if (eventType === "ACTIVE_COOLDOWN_SCAN") {
          warnedCount += 1;
          // ACTIVE 降级 warning 任务
          const downgradeTaskOwnerUserId = profile.ownerUserId ?? params?.actorUserId;
          if (downgradeTaskOwnerUserId) {
          await db.crmFollowUpTask.upsert({
            where: { sourceOpenKey: `crm-active-downgrade-warning:${profile.id}` },
            update: {
              dueAt: now,
              title: "业务结束后续跟进",
              ownerUserId: downgradeTaskOwnerUserId,
              status: "OPEN",
              taskType: "CONTACT",
            },
            create: {
              profileId: profile.id,
              ownerUserId: downgradeTaskOwnerUserId,
              title: "业务结束后续跟进",
              dueAt: now,
              taskType: "CONTACT",
              sourceType: "CRM_ACTIVE_DOWNGRADE_WARNING",
              sourceId: profile.id,
              sourceOpenKey: `crm-active-downgrade-warning:${profile.id}`,
              createdByUserId: params?.actorUserId || downgradeTaskOwnerUserId,
            },
          });
          } else {
            console.warn(`[CRM_LIFECYCLE] skip active-downgrade task for profile=${profile.id}: no valid owner`);
          }
        }
        if (result.nextStage === "DORMANT") dormantCount += 1;
      }
    }
  }

  return {
    scannedCount: profiles.length,
    warnedCount,
    dormantCount,
  };
}

// ─── 辅助查询函数 ────────────────────────────────────────────

async function getOrderAggregateForProfile(
  profileId: string,
  db: DbClient = prisma,
): Promise<OrderAggregate> {
  const empty: OrderAggregate = {
    activeOrderCount: 0,
    historicalOrderCount: 0,
    activeOrderAmount: 0,
    lastActiveOrderAt: null,
    lastHistoricalOrderAt: null,
    firstOrderAt: null,
  };
  const orders = await db.order.findMany({
    where: {
      deleted: false,
      archived: false,
      profileId,
    },
    select: {
      status: true,
      totalAmount: true,
      financeAmountOverride: true,
      confirmedAt: true,
      orderedAt: true,
      createdAt: true,
    },
  });
  if (orders.length === 0) return empty;

  const result = { ...empty };
  for (const order of orders) {
    const amount = order.financeAmountOverride ?? order.totalAmount ?? 0;
    const activeAt = order.confirmedAt ?? order.orderedAt ?? order.createdAt;
    const historicalAt = order.orderedAt ?? order.confirmedAt ?? order.createdAt;
    if (order.status === "CONFIRMED" || order.status === "DELIVERED") {
      result.activeOrderCount += 1;
      result.activeOrderAmount += amount;
      if (!result.lastActiveOrderAt || activeAt > result.lastActiveOrderAt) {
        result.lastActiveOrderAt = activeAt;
      }
    }
    if (order.status === "CONFIRMED" || order.status === "DELIVERED" || order.status === "CLOSED") {
      result.historicalOrderCount += 1;
      if (!result.lastHistoricalOrderAt || historicalAt > result.lastHistoricalOrderAt) {
        result.lastHistoricalOrderAt = historicalAt;
      }
      if (!result.firstOrderAt || historicalAt < result.firstOrderAt) {
        result.firstOrderAt = historicalAt;
      }
    }
  }
  return result;
}

async function getProjectAggregateForProfile(
  profileId: string,
  db: DbClient = prisma,
): Promise<ProjectAggregate> {
  const projects = await db.project.findMany({
    where: {
      deleted: false,
      status: "IN_PROGRESS",
      profileId,
    },
    select: { updatedAt: true },
    orderBy: { updatedAt: "desc" },
  });
  return {
    activeProjectCount: projects.length,
    lastActiveProjectAt: projects[0]?.updatedAt ?? null,
  };
}

type InteractionAggregate = {
  lastEffectiveInteractionAt: Date | null;
};

async function getInteractionAggregate(profileId: string, db: DbClient): Promise<InteractionAggregate> {
  const interaction = await db.crmInteraction.findFirst({
    where: {
      profileId,
      type: { in: CRM_EFFECTIVE_INTERACTION_TYPES as unknown as string[] },
    },
    orderBy: { happenedAt: "desc" },
    select: { happenedAt: true },
  });
  return {
    lastEffectiveInteractionAt: interaction?.happenedAt ?? null,
  };
}

type CommunicationTaskAggregate = {
  nextCommunicationTaskAt: Date | null;
  openCommunicationTaskCount: number;
  overdueCommunicationTaskCount: number;
  dueCommunicationTaskCount30d: number;
  doneCommunicationTaskCount30d: number;
};

async function getCommunicationTaskAggregate(profileId: string, db: DbClient): Promise<CommunicationTaskAggregate> {
  const now = new Date();
  const d30 = subtractDays(30);
  const [openTasks, doneCount30d] = await Promise.all([
    db.crmFollowUpTask.findMany({
      where: {
        profileId,
        status: "OPEN",
        sourceType: { in: CRM_COMMUNICATION_TASK_SOURCE_TYPES as unknown as string[] },
      },
      select: { dueAt: true },
      orderBy: { dueAt: "asc" },
    }),
    db.crmFollowUpTask.count({
      where: {
        profileId,
        status: "DONE",
        sourceType: { in: CRM_COMMUNICATION_TASK_SOURCE_TYPES as unknown as string[] },
        completedAt: { gte: d30 },
      },
    }),
  ]);

  let overdueCommunicationTaskCount = 0;
  let dueCommunicationTaskCount30d = 0;
  for (const task of openTasks) {
    if (task.dueAt < now) overdueCommunicationTaskCount += 1;
    if (task.dueAt >= d30 && task.dueAt <= now) dueCommunicationTaskCount30d += 1;
  }

  return {
    nextCommunicationTaskAt: openTasks[0]?.dueAt ?? null,
    openCommunicationTaskCount: openTasks.length,
    overdueCommunicationTaskCount,
    dueCommunicationTaskCount30d,
    doneCommunicationTaskCount30d: doneCount30d,
  };
}

export function isEffectiveInteractionType(type: string) {
  return EFFECTIVE_INTERACTION_TYPE_SET.has(type);
}

export function isCommunicationTaskSourceType(sourceType: string | null | undefined) {
  return !!sourceType && COMMUNICATION_TASK_SOURCE_TYPE_SET.has(sourceType);
}

/**
 * @deprecated 使用 computeCrmStage + transitionCrmStage 替代
 */
export function getEffectiveCrmLifecycleStage(
  summary: {
    stage: string;
    activeOrderCount?: number;
    dormantCandidate?: boolean;
    activeProjectCount?: number;
    lastActiveBehaviorEndedAt?: Date | string | null;
    activeCooldownEndsAt?: Date | string | null;
    activeWarningIssuedAt?: Date | string | null;
    lastFollowUpAt?: Date | string | null;
    assignedAt?: Date | string | null;
    createdAt: Date | string;
    assignmentStatus?: string;
    lastEffectiveInteractionAt?: Date | string | null;
    openCommunicationTaskCount?: number;
  },
) {
  const { nextStage } = computeCrmStage(
    {
      stage: summary.stage,
      lastActiveBehaviorEndedAt: normalizeDate(summary.lastActiveBehaviorEndedAt) ?? null,
      activeCooldownEndsAt: normalizeDate(summary.activeCooldownEndsAt) ?? null,
      activeWarningIssuedAt: normalizeDate(summary.activeWarningIssuedAt) ?? null,
      assignmentStatus: summary.assignmentStatus || "ASSIGNED",
      lastFollowUpAt: normalizeDate(summary.lastFollowUpAt) ?? null,
      assignedAt: normalizeDate(summary.assignedAt) ?? null,
      createdAt: typeof summary.createdAt === "string" ? new Date(summary.createdAt) : summary.createdAt,
    },
    {
      hasActiveOrder: (summary.activeOrderCount ?? 0) > 0,
      hasActiveProject: (summary.activeProjectCount ?? 0) > 0,
      lastEffectiveInteractionAt: normalizeDate(summary.lastEffectiveInteractionAt) ?? null,
      openCommunicationTaskCount: summary.openCommunicationTaskCount ?? 0,
    },
  );
  return nextStage;
}

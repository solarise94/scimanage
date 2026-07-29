/**
 * CRM 客户偏好 lib —— 人工标注 + 自动洞察的创建/更新/查询辅助。
 *
 * 设计文档 §偏好模型设计 / §自动洞察操作语义：
 * - 创建偏好：只要能访问 profile 即可（assertCrmProfileAccess 已在 API 层校验）。
 * - 编辑偏好：ADMIN 全量；其他人只能编辑自己创建的 MANUAL 偏好。
 * - 自动洞察（ORDER_RULE 等）不可直接编辑原始事实，只允许「采纳/隐藏/置顶/标记不准确/转人工偏好」。
 * - 隐藏过的洞察不应在下一次重算中重新激活（见 preference-insights.ts）。
 *
 * 不回写 Customer 旧业务字段，不写 CrmCustomerProfile.summary / tagsJson。
 */
import { prisma } from "@/lib/prisma";
import type { CrmCustomerPreference } from "@prisma/client";

const PREFERENCE_SELECT = {
  id: true,
  profileId: true,
  category: true,
  key: true,
  label: true,
  valueText: true,
  valueJson: true,
  sourceType: true,
  confidence: true,
  evidenceType: true,
  evidenceId: true,
  status: true,
  reviewStatus: true,
  reviewedByUserId: true,
  reviewedAt: true,
  pinned: true,
  note: true,
  createdById: true,
  updatedByUserId: true,
  createdAt: true,
  updatedAt: true,
} as const;

export type CrmCustomerPreferenceItem = Pick<
  CrmCustomerPreference,
  keyof typeof PREFERENCE_SELECT
>;

/**
 * 判断用户是否可编辑某条偏好。
 * - ADMIN：全量。
 * - 非 ADMIN：只能编辑自己创建的 MANUAL 偏好；自动洞察不可直接编辑。
 */
export function canEditPreference(
  pref: { sourceType: string; createdById: string },
  userId: string,
  role: string,
): boolean {
  if (role === "ADMIN") return true;
  // 自动洞察不允许直接编辑内容，只能通过 review/pin/archive 操作（见 updatePreference）。
  if (pref.sourceType !== "MANUAL") return false;
  return pref.createdById === userId;
}

/**
 * 创建人工偏好。sourceType 强制为 MANUAL。
 */
export async function createManualPreference(params: {
  profileId: string;
  category: string;
  key: string;
  label: string;
  valueText?: string;
  valueJson?: string;
  pinned?: boolean;
  note?: string;
  actorUserId: string;
}): Promise<CrmCustomerPreferenceItem> {
  const { profileId, actorUserId } = params;
  return prisma.crmCustomerPreference.create({
    data: {
      profileId,
      category: params.category,
      key: params.key,
      label: params.label,
      valueText: params.valueText ?? null,
      valueJson: params.valueJson ?? null,
      sourceType: "MANUAL",
      status: "ACTIVE",
      reviewStatus: "ACCEPTED",
      pinned: params.pinned ?? false,
      note: params.note ?? null,
      createdById: actorUserId,
      updatedByUserId: actorUserId,
    },
    select: PREFERENCE_SELECT,
  });
}

/**
 * 更新偏好。
 *
 * 字段语义与权限分层（设计文档 §写入 / §自动洞察操作语义）：
 * - label / valueText / valueJson / note：内容字段，受 canEditPreference 控制。
 *   （ADMIN 全量；非 ADMIN 只能编辑自己创建的 MANUAL 偏好）
 * - pinned：任意可访问用户可切换（不改变来源和审核状态）。
 * - status（DISMISSED / SUPERSEDED / ARCHIVED / ACTIVE）：
 *   · MANUAL 人工偏好：ADMIN 全量；非 ADMIN 只能操作自己创建的（DISMISSED/ARCHIVED）。
 *   · 自动洞察（ORDER_RULE/INTERACTION_AI/SYSTEM）：能访问 profile 的用户可
 *     DISMISSED/SUPERSEDED（隐藏/标记不准确）；恢复 ACTIVE 需 ADMIN。
 *   · 客诉摘要（COMPLAINT）：由客诉状态机驱动，不应被手动 status 操作；
 *     ADMIN 可强制操作。
 * - reviewStatus（ACCEPTED / REJECTED）：仅对自动洞察有意义，同时写
 *   reviewedByUserId / reviewedAt。任何能访问的用户可采纳/拒绝。
 *
 * 隐藏 = status=DISMISSED + reviewStatus=REJECTED（设计文档 §自动洞察操作语义 第 2 点）。
 */
export async function updatePreference(params: {
  preferenceId: string;
  actorUserId: string;
  role: string;
  label?: string;
  valueText?: string | null;
  valueJson?: string | null;
  note?: string | null;
  pinned?: boolean;
  status?: string;
  reviewStatus?: string;
}): Promise<CrmCustomerPreferenceItem> {
  const { preferenceId, actorUserId, role } = params;
  const isAdmin = role === "ADMIN";

  return prisma.$transaction(async (tx) => {
    const existing = await tx.crmCustomerPreference.findUnique({
      where: { id: preferenceId },
      select: { ...PREFERENCE_SELECT },
    });
    if (!existing) throw new Error("NOT_FOUND");

    const data: Record<string, unknown> = { updatedByUserId: actorUserId };

    // 内容字段 —— 受 canEditPreference 控制
    const wantsContentChange =
      params.label !== undefined ||
      params.valueText !== undefined ||
      params.valueJson !== undefined ||
      params.note !== undefined;
    if (wantsContentChange) {
      if (!canEditPreference(existing, actorUserId, role)) {
        throw new Error("FORBIDDEN");
      }
      if (params.label !== undefined) data.label = params.label;
      if (params.valueText !== undefined) data.valueText = params.valueText;
      if (params.valueJson !== undefined) data.valueJson = params.valueJson;
      if (params.note !== undefined) data.note = params.note;
    }

    // pinned —— 任意可访问用户可切换
    if (params.pinned !== undefined) data.pinned = params.pinned;

    // status —— 按 sourceType 分层校验
    if (params.status !== undefined) {
      const isManual = existing.sourceType === "MANUAL";
      const isComplaint = existing.sourceType === "COMPLAINT";
      const isAutoInsight = !isManual && !isComplaint;
      const target = params.status;

      if (isAdmin) {
        // ADMIN 全量
      } else if (isManual && existing.createdById === actorUserId) {
        // 自己创建的人工偏好：只能 DISMISSED/ARCHIVED，不能 SUPERSEDED/ACTIVE
        if (target !== "DISMISSED" && target !== "ARCHIVED") {
          throw new Error("FORBIDDEN");
        }
      } else if (isAutoInsight) {
        // 自动洞察：只能 DISMISSED/SUPERSEDED（隐藏/标记不准确），恢复 ACTIVE 需 ADMIN
        if (target !== "DISMISSED" && target !== "SUPERSEDED") {
          throw new Error("FORBIDDEN");
        }
      } else {
        // 客诉摘要或别人的人工偏好：非 ADMIN 不可操作 status
        throw new Error("FORBIDDEN");
      }
      data.status = target;
    }

    // reviewStatus —— 仅自动洞察有意义，同时写审核人/时间
    if (params.reviewStatus !== undefined) {
      if (existing.sourceType === "MANUAL") {
        throw new Error("FORBIDDEN");
      }
      data.reviewStatus = params.reviewStatus;
      data.reviewedByUserId = actorUserId;
      data.reviewedAt = new Date();
    }

    return tx.crmCustomerPreference.update({
      where: { id: preferenceId },
      data,
      select: PREFERENCE_SELECT,
    });
  });
}

/**
 * 将自动洞察转成人工偏好——单事务原子操作。
 *
 * 1. 新建一条 sourceType=MANUAL 的偏好，内容从洞察带入。
 * 2. 原洞察标记为 SUPERSEDED。
 *
 * 只允许自动洞察（ORDER_RULE/INTERACTION_AI/SYSTEM）转换，不允许转换客诉摘要（COMPLAINT）。
 * 返回新建的人工偏好。
 */
export async function convertInsightToManual(params: {
  preferenceId: string;
  actorUserId: string;
}): Promise<CrmCustomerPreferenceItem> {
  const { preferenceId, actorUserId } = params;

  return prisma.$transaction(async (tx) => {
    const existing = await tx.crmCustomerPreference.findUnique({
      where: { id: preferenceId },
      select: { ...PREFERENCE_SELECT },
    });
    if (!existing) throw new Error("NOT_FOUND");

    // 只允许自动洞察转换
    const AUTO_SOURCES = ["ORDER_RULE", "INTERACTION_AI", "SYSTEM"];
    if (!AUTO_SOURCES.includes(existing.sourceType)) {
      throw new Error("FORBIDDEN");
    }
    // 仅允许 ACTIVE 洞察转换——已 SUPERSEDED/DISMISSED 的不可重复转换。
    // 符合一次性采纳语义，也防止并发请求产生多条人工副本。
    if (existing.status !== "ACTIVE") {
      throw new Error("ALREADY_CONVERTED");
    }

    // 新建人工偏好
    const manualKey = `manual:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    const created = await tx.crmCustomerPreference.create({
      data: {
        profileId: existing.profileId,
        category: existing.category,
        key: manualKey,
        label: existing.label,
        valueText: existing.valueText,
        sourceType: "MANUAL",
        status: "ACTIVE",
        reviewStatus: "ACCEPTED",
        pinned: existing.pinned,
        createdById: actorUserId,
        updatedByUserId: actorUserId,
      },
      select: PREFERENCE_SELECT,
    });

    // 原洞察标记 SUPERSEDED
    await tx.crmCustomerPreference.update({
      where: { id: preferenceId },
      data: {
        status: "SUPERSEDED",
        updatedByUserId: actorUserId,
      },
    });

    return created;
  });
}

/**
 * 概览卡片用：置顶人工偏好 + 最近人工偏好摘要。
 * Phase 1 只返回人工偏好；Phase 2/3 在 API 层拼接客诉/洞察。
 */
export async function getProfilePreferenceSummary(profileId: string): Promise<{
  pinned: CrmCustomerPreferenceItem[];
  recent: CrmCustomerPreferenceItem[];
  topInsights: CrmCustomerPreferenceItem[];
}> {
  const [pinned, recentManual, topInsights] = await Promise.all([
    prisma.crmCustomerPreference.findMany({
      where: { profileId, status: "ACTIVE", pinned: true },
      orderBy: [{ createdAt: "desc" }],
      take: 3,
      select: PREFERENCE_SELECT,
    }),
    prisma.crmCustomerPreference.findMany({
      where: { profileId, status: "ACTIVE", sourceType: "MANUAL" },
      orderBy: [{ createdAt: "desc" }],
      take: 5,
      select: PREFERENCE_SELECT,
    }),
    // Phase 3：置信度最高的自动洞察（仅 ACTIVE + 非 DISMISSED）
    prisma.crmCustomerPreference.findMany({
      where: {
        profileId,
        status: "ACTIVE",
        sourceType: { not: "MANUAL" },
        confidence: { not: null },
      },
      orderBy: [{ confidence: "desc" }, { updatedAt: "desc" }],
      take: 3,
      select: PREFERENCE_SELECT,
    }),
  ]);

  // 去掉 recent 中已 pinned 的（避免概览重复）
  const pinnedIds = new Set(pinned.map((p) => p.id));
  return {
    pinned,
    recent: recentManual.filter((p) => !pinnedIds.has(p.id)).slice(0, 3),
    topInsights,
  };
}

export { PREFERENCE_SELECT };

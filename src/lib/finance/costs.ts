import { prisma } from "@/lib/prisma";
import { findActiveProfile } from "@/lib/crm/ids";

export const VALID_COST_TYPES = [
  "PROCUREMENT", "EXPERIMENT", "LABOR", "LOGISTICS",
  "PLATFORM", "MARKETING", "ENTERTAINMENT", "REFUND", "OTHER",
] as const;

export type CostType = (typeof VALID_COST_TYPES)[number];

export function isValidCostType(v: string): v is CostType {
  return VALID_COST_TYPES.includes(v as CostType);
}

/**
 * Validate and resolve cost entity references (Profile-only).
 *
 * Rules (W6.3b):
 * - Order / Project 若传入或被推导，自身必须有非空 profileId（禁止用请求体 profileId 掩盖脏数据）
 * - resolvedProjectId（显式或由 order.projectLinks[0] 推导）一律做存在性 / deleted / profile 一致性校验
 * - 最终 resolvedProfileId 一律经 findActiveProfile（含从 Order/Project 派生）
 */
export async function resolveAndValidateCostRefs(params: {
  profileId?: string | null;
  orderId?: string | null;
  projectId?: string | null;
}): Promise<{
  valid: boolean;
  error?: string;
  resolvedProfileId: string | null;
  resolvedProjectId: string | null;
}> {
  const { profileId, orderId, projectId } = params;

  let orderProfileId: string | null = null;
  let projectProfileId: string | null = null;
  let resolvedProjectId: string | null = projectId || null;

  if (orderId) {
    const order = await prisma.order.findUnique({
      where: { id: orderId, deleted: false },
      select: {
        id: true,
        profileId: true,
        projectLinks: { select: { projectId: true }, orderBy: { isPrimary: "desc" } },
      },
    });
    if (!order) {
      return {
        valid: false,
        error: `订单 ${orderId.slice(-6)} 不存在`,
        resolvedProfileId: null,
        resolvedProjectId: null,
      };
    }
    if (!order.profileId) {
      return {
        valid: false,
        error: `订单 ${orderId.slice(-6)} 缺少 profileId，无法登记成本。请先完成客户资料绑定。`,
        resolvedProfileId: null,
        resolvedProjectId: null,
      };
    }
    orderProfileId = order.profileId;

    if (!resolvedProjectId && order.projectLinks.length > 0) {
      resolvedProjectId = order.projectLinks[0]!.projectId;
    }
    if (resolvedProjectId && order.projectLinks.length > 0) {
      const belongs = order.projectLinks.some((l) => l.projectId === resolvedProjectId);
      if (!belongs) {
        return {
          valid: false,
          error: "传入项目不属于该订单的关联项目",
          resolvedProfileId: null,
          resolvedProjectId: null,
        };
      }
    }
  }

  if (resolvedProjectId) {
    const project = await prisma.project.findUnique({
      where: { id: resolvedProjectId, deleted: false },
      select: { id: true, profileId: true },
    });
    if (!project) {
      return {
        valid: false,
        error: `项目 ${resolvedProjectId.slice(-6)} 不存在`,
        resolvedProfileId: null,
        resolvedProjectId: null,
      };
    }
    if (!project.profileId) {
      return {
        valid: false,
        error: `项目 ${resolvedProjectId.slice(-6)} 缺少 profileId，无法登记成本。请先完成客户资料绑定。`,
        resolvedProfileId: null,
        resolvedProjectId: null,
      };
    }
    projectProfileId = project.profileId;
  }

  // 一致性：Order / Project / 显式 profileId 必须指向同一 Profile
  if (orderProfileId && projectProfileId && orderProfileId !== projectProfileId) {
    return {
      valid: false,
      error: "订单客户与项目客户不一致",
      resolvedProfileId: null,
      resolvedProjectId: null,
    };
  }

  let candidateProfileId: string | null = null;
  if (profileId) {
    candidateProfileId = profileId;
  } else if (orderProfileId) {
    candidateProfileId = orderProfileId;
  } else if (projectProfileId) {
    candidateProfileId = projectProfileId;
  }

  if (profileId && orderProfileId && profileId !== orderProfileId) {
    return {
      valid: false,
      error: "订单客户与传入客户不一致",
      resolvedProfileId: null,
      resolvedProjectId: null,
    };
  }
  if (profileId && projectProfileId && profileId !== projectProfileId) {
    return {
      valid: false,
      error: "项目客户与传入客户不一致",
      resolvedProfileId: null,
      resolvedProjectId: null,
    };
  }

  if (!candidateProfileId) {
    return {
      valid: true,
      resolvedProfileId: null,
      resolvedProjectId,
    };
  }

  const active = await findActiveProfile(candidateProfileId);
  if (!active) {
    return {
      valid: false,
      error: `客户档案 ${candidateProfileId.slice(-6)} 不存在或已归档/删除`,
      resolvedProfileId: null,
      resolvedProjectId: null,
    };
  }

  return {
    valid: true,
    resolvedProfileId: active.profileId,
    resolvedProjectId,
  };
}

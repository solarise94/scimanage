/**
 * 服务端校验层（docs §7）：薄校验服务，负责 profileId 的「存在 / 可访问 / 非归档删除」复核。
 *
 * 设计原则（docs §2）：
 *  - 模型只能引用候选 profileId，不能自行创造；本层在工具执行前后对 profileId 重新校验。
 *  - 唯一性结论（UNIQUE/AMBIGUOUS/NO_MATCH）直接由 `scoreAndResolve` 基于「完整候选前两名」
 *    产出（见 customer-name-resolver.ts），调用方按其 `resolution` 字段消费——本层不再
 *    维护独立的 confidence strong/medium 维度或二次映射。
 *  - 模块独立可测。
 *
 * Scope-first 硬约束：`validateCustomerTarget` 始终通过
 * `getEffectiveCrmVisibleProfileIds` 复核权限。null（ADMIN/USER 全量）放行；非 null
 * 必须命中成员。任何召回/校验都不得扩大可见范围。
 */

import { prisma } from "@/lib/prisma";
import { getEffectiveCrmVisibleProfileIds } from "@/lib/crm/permissions";

// ── 类型（docs §7.2） ───────────────────────────────────────────────────────

/** 校验通过的简要客户信息（不含敏感字段，可安全回显）。 */
export interface ValidatedCustomerTarget {
  profileId: string;
  name: string;
  organization: string | null;
  principal: string | null;
  ownerName: string | null;
}

export interface ValidateOk {
  ok: true;
  profile: ValidatedCustomerTarget;
}

export interface ValidateFail {
  ok: false;
  /** 人类可读的失败原因（中文），用于 UI 与日志。 */
  reason: string;
}

export type ValidateResult = ValidateOk | ValidateFail;

// ── 服务端校验入口 ─────────────────────────────────────────────────────────

/**
 * 校验一个 profileId 是否可被当前 actor 操作：
 *  1. 存在；
 *  2. 非 archived / 非 deleted；
 *  3. 在 actor 的 CRM scope 内（null → 放行；Set → 成员校验）。
 *
 * 返回 `{ ok, profile }` 或 `{ ok: false, reason }`。不抛异常（调用方按 ok 分支）。
 *
 * 注意：与 `assertCrmProfileAccess` 的差异——本层返回结构化结果而非抛 Error，
 * 并显式拒绝 archived/deleted 的 profile（与召回层口径一致），适合作为工具执行前后的
 * 权限复核与可审计断言点。
 */
export async function validateCustomerTarget(
  actor: { userId: string; role: string },
  profileId: string,
): Promise<ValidateResult> {
  if (!profileId || typeof profileId !== "string") {
    return { ok: false, reason: "缺少 profileId" };
  }

  const profile = await prisma.crmCustomerProfile.findUnique({
    where: { id: profileId },
    select: {
      id: true,
      name: true,
      organization: true,
      principal: true,
      archived: true,
      deleted: true,
      ownerUser: { select: { name: true } },
    },
  });

  if (!profile) {
    return { ok: false, reason: "客户资料不存在" };
  }
  if (profile.archived || profile.deleted) {
    return { ok: false, reason: "客户资料已归档或删除" };
  }

  // Scope 复核：null（ADMIN/USER）放行；非 null 必须命中成员。
  const scopeIds = await getEffectiveCrmVisibleProfileIds(actor.userId, actor.role);
  if (scopeIds !== null && !scopeIds.has(profileId)) {
    // 故意不区分「不存在」与「越权」——避免侧信道泄漏 scope 外客户存在性。
    return { ok: false, reason: "客户资料不存在或不在当前可见范围内" };
  }

  return {
    ok: true,
    profile: {
      profileId: profile.id,
      name: profile.name ?? "未命名客户",
      organization: profile.organization ?? null,
      principal: profile.principal ?? null,
      ownerName: profile.ownerUser?.name ?? null,
    },
  };
}

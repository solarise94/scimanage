/**
 * 综合数据治理中心 — 公共判定常量与 Profile-only helper（设计文档 §2.2 / §八 Phase G1）。
 *
 * 治理能力此前散落在 5 个页面、12+ API，扫描口径在多处内联重复（机构 Profile 读取 4 处、
 * 强信号判定 / 三无判定各自实现）。本模块把这些公共判定收敛到单一来源，三块（C/O/M）扫描统一 import，
 * 禁止再内联重复，从根上消除口径漂移。
 *
 * 设计原则：
 *  - Profile-only：业务字段一律以 CrmCustomerProfile 为准，不再接受 Customer 第二参数。
 *  - 不兜底：缺机构 / 代表 NONE / 同名歧义 都只标记，不写默认值。
 *  - 口径单一：订单治理状态、强信号字段集都来自这里。
 */

// ── 订单治理状态口径 ───────────────────────────────────────────────
// 导入订单落库即 DELIVERED，治理扫描必须覆盖 CONFIRMED/DELIVERED/CLOSED，
// 不能沿用旧无客户口径的 [CONFIRMED, CLOSED]（那会让 DELIVERED 订单被计数却进不了列表）。
export const GOVERNANCE_ORDER_STATUSES = ["CONFIRMED", "DELIVERED", "CLOSED"] as const;
export type GovernanceOrderStatus = (typeof GOVERNANCE_ORDER_STATUSES)[number];

/** 订单状态是否落入治理口径（已落地的真实订单，排除 DRAFT/CANCELLED 等）。 */
export function isTerminalOrderStatus(status: string | null | undefined): boolean {
  return !!status && (GOVERNANCE_ORDER_STATUSES as readonly string[]).includes(status);
}

// ── 强信号（可唯一识别一个人的字段）────────────────────────────────
// 空壳客户判定看的是"能否唯一识别这个人"：微信 / 电话 / 联系人 / 小程序ID 全空即空壳。
// 机构不计入强信号——机构只影响代表解析（C2 缺联系方式与 C3 缺机构是正交维度，§3.2）。
export const STRONG_IDENTITY_FIELDS = ["wechat", "phone", "principal", "miniProgramId"] as const;
export type StrongIdentityField = (typeof STRONG_IDENTITY_FIELDS)[number];

/** 结构化最小输入：Prisma select 出来的对象字段更多也可直接传入（结构化类型）。 */
export interface StrongSignalSource {
  wechat?: string | null;
  phone?: string | null;
  principal?: string | null;
  miniProgramId?: string | null;
}

export interface OrgSource {
  organization?: string | null; // 机构文本
  organizationId?: string | null; // 机构 FK
  organizationRawInput?: string | null; // 用户原始输入文本
}

export interface StrongSignals {
  wechat: string | null;
  phone: string | null;
  principal: string | null;
  miniProgramId: string | null;
}

function trimOrNull(v: string | null | undefined): string | null {
  if (v == null) return null;
  const t = v.trim();
  return t === "" ? null : t;
}

/** 从 Profile 读取强信号四件套；无 Profile 时全部为 null。 */
export function readProfileStrongSignals(
  profile: StrongSignalSource | null | undefined,
): StrongSignals {
  return {
    wechat: trimOrNull(profile?.wechat),
    phone: trimOrNull(profile?.phone),
    principal: trimOrNull(profile?.principal),
    miniProgramId: trimOrNull(profile?.miniProgramId),
  };
}

/**
 * 空壳判定：强信号四件套全空即为空壳。
 * 注意：是否带机构 **不** 计入空壳判定（§3.2）。
 */
export function isStrongSignalEmpty(
  profile: StrongSignalSource | null | undefined,
): boolean {
  const s = readProfileStrongSignals(profile);
  return !s.wechat && !s.phone && !s.principal && !s.miniProgramId;
}

/** 从 Profile 读取机构（文本 + FK）。 */
export function readProfileOrg(
  profile: OrgSource | null | undefined,
): { organization: string | null; organizationId: string | null } {
  return {
    organization: trimOrNull(profile?.organization),
    organizationId: profile?.organizationId ?? null,
  };
}

/** 从 Profile 读取机构完整字段（文本 + FK + 原始输入）。 */
export function readProfileOrgFields(
  profile: OrgSource | null | undefined,
): { organization: string | null; organizationId: string | null; organizationRawInput: string | null } {
  return {
    organization: trimOrNull(profile?.organization),
    organizationId: profile?.organizationId ?? null,
    organizationRawInput: trimOrNull(profile?.organizationRawInput),
  };
}

// ── 三无客户判定 ───────────────────────────────────────────────────
// 三无 = 无机构（Profile.organizationId 为空）+ 无历史订单 + 无可解析代表（NONE / SYSTEM_FALLBACK）。
// 口径与 customer-org-bindings 现有内联判定一致；抽到这里供统一删除（§6.1 mode=TRIPLE_NONE）复用。
export function isTripleNone(args: {
  profileOrganizationId: string | null | undefined;
  historicalOrderCount: number;
  effectiveRepSource: string | null | undefined;
}): boolean {
  return (
    (args.profileOrganizationId ?? null) === null &&
    (args.historicalOrderCount ?? 0) === 0 &&
    (args.effectiveRepSource === "NONE" || args.effectiveRepSource === "SYSTEM_FALLBACK")
  );
}

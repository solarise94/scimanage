/**
 * 统一订单导入匹配打分核心（Profile-first）。
 *
 * 见 docs/order-import-crm-confirmation-design-2026-06-29.md §5。
 *
 * 这是项目内唯一一张匹配分值表 + 一套阈值。`source-order-match.ts`（按候选数组打分）
 * 与 `finance/pingoodmice-match.ts`（按 MatchContext 打分）都复用本模块，避免出现第三套实现。
 *
 * 字段主权：业务信号（微信/手机/小程序ID/机构/地址）只来自 CrmCustomerProfile，
 * 调用方负责把 Profile 字段装配进 ScoringCandidate；本模块不读 Customer 旧业务字段。
 */

// ─── 分值表（§5.2） ─────────────────────────────────────────────
export const SCORE = {
  MINIPROGRAM_EXACT: 100, // L1 小程序 ID 精确
  CUSTOMER_CODE_EXACT: 99, // L1.5 客户编码精确
  WECHAT_EXACT: 98, // L2 微信精确
  PHONE_EXACT: 95, // L3 手机精确
  NAME_ORG_EXACT: 85, // L4 姓名 + 机构精确
  NAME_ORG_PARTIAL: 75, // L5 姓名 + 机构近似（alias/site 参与）
  NAME_ADDRESS_OVERLAP: 70, // L6 姓名 + 地址重叠
  NAME_ONLY: 55, // L7 仅姓名精确（不可自动确认）
} as const;

/** 进入候选列表的最低分（含 L7 仅姓名，给用户展示，但不能自动确认）。 */
export const MATCH_THRESHOLD = 55;
/** 可作为高置信「自动建议」的最低分（§5.3）：L4 姓名+机构精确及以上。 */
export const AUTO_SUGGEST_MIN = 85;
/** 自动建议要求领先第二名的分差。 */
export const AUTO_SUGGEST_LEAD = 10;

// ─── 文本/电话归一化 ────────────────────────────────────────────
export function normalizeText(s: string | null | undefined): string {
  if (!s) return "";
  return s.trim().toLowerCase().replace(/\s+/g, "");
}

export function normalizePhone(s: string | null | undefined): string {
  if (!s) return "";
  return s.replace(/\D/g, "");
}

/** 从一段文本里抽取所有大陆手机号（11 位）。 */
export function extractPhones(s: string | null | undefined): string[] {
  if (!s) return [];
  const phoneRegex = /1[3-9]\d{9}/g;
  return s.match(phoneRegex) || [];
}

// ─── 类型 ───────────────────────────────────────────────────────

/** 订单一行的匹配输入信号（已是原始字符串，由本模块归一化）。 */
export interface ScoringOrderInput {
  buyerName?: string | null;
  buyerWechat?: string | null;
  buyerPhone?: string | null;
  buyerMiniProgramId?: string | null;
  buyerCustomerCode?: string | null;
  /** 机构名（已确定的单位文本）；若为空，调用方可改传地址抽取出的机构名。 */
  buyerOrgName?: string | null;
  buyerAddress?: string | null;
}

/**
 * 一个候选客户（已装配为 Profile 主权字段）。
 * 调用方负责把 Profile 的 wechat/phone/principal/miniProgramId/organization/address/org 别名站点
 * 折叠成下面这些归一化变体。
 *
 * 姓名变体分三层（docs §9.2）：
 * - nameVariantsNorm：正式姓名（与机构精确时 85 分，L4）
 * - trustedAliasVariantsNorm：MERGED_NAME / FORMER_NAME（与正式姓名同等可信，85 分）
 * - commonAliasVariantsNorm：COMMON（弱变体，最高 75 分，不自动建议）
 */
export interface ScoringCandidate {
  /** CrmCustomerProfile.id（候选就是 Profile，必填）。 */
  profileId: string;
  /** 展示名（锚点）。 */
  name: string;
  /** 客户编码（精确匹配用）。 */
  customerCodeNorm: string;
  /** 用于姓名精确比对的归一化正式姓名集合（仅 Profile.name）。 */
  nameVariantsNorm: string[];
  /** 可信历史姓名变体（MERGED_NAME / FORMER_NAME 归一化）。 */
  trustedAliasVariantsNorm: string[];
  /** 常用称呼变体（COMMON 归一化）。 */
  commonAliasVariantsNorm: string[];
  wechatNorm: string;
  miniProgramIdNorm: string;
  /** 归一化手机号集合（来自 Profile.phone + Profile.principal 抽取）。 */
  phones: string[];
  /** 归一化机构名变体集合（organization/canonical/normalized/alias/site/org+site 组合）。 */
  orgVariantsNorm: string[];
  addressNorm: string;
}

export interface ScoredCandidate {
  profileId: string;
  name: string;
  score: number;
  reason: string;
}

/** 统一的候选列表输出形态（§5.4）。 */
export interface MatchRowResolution {
  status: "AUTO_SUGGESTED" | "AMBIGUOUS" | "NO_MATCH";
  candidates: ScoredCandidate[];
  best: ScoredCandidate | null;
  /** 仅 AUTO_SUGGESTED 时非空：默认选中谁。commit 不信任它，只信任用户的 decisionType。 */
  suggestedProfileId: string | null;
}

// ─── 纯打分 ─────────────────────────────────────────────────────

/** 预归一化订单输入，避免每个候选重复归一化。 */
export interface NormalizedOrderInput {
  nameNorm: string;
  /** alias 比较专用归一化（含 NFKC，与 normalizeCustomerNameAlias 一致）。 */
  aliasNameNorm: string;
  wechatNorm: string;
  phoneNorm: string;
  miniProgramIdNorm: string;
  customerCodeNorm: string;
  orgNorm: string;
  addressNorm: string;
}

export function normalizeOrderInput(input: ScoringOrderInput): NormalizedOrderInput {
  return {
    nameNorm: normalizeText(input.buyerName),
    aliasNameNorm: normalizeCustomerNameAliasForScoring(input.buyerName),
    wechatNorm: normalizeText(input.buyerWechat),
    phoneNorm: normalizePhone(input.buyerPhone),
    miniProgramIdNorm: normalizeText(input.buyerMiniProgramId),
    customerCodeNorm: normalizeText(input.buyerCustomerCode),
    orgNorm: normalizeText(input.buyerOrgName),
    addressNorm: normalizeText(input.buyerAddress),
  };
}

/**
 * alias 比较专用归一化：与 normalizeCustomerNameAlias 一致（含 NFKC）。
 * 复用于候选 alias 变体构建和输入 alias 比对，保证两端归一化口径相同。
 */
function normalizeCustomerNameAliasForScoring(s: string | null | undefined): string {
  if (!s) return "";
  return s
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

/**
 * 对单个候选打分，返回最高命中层的 {score, reason}；无命中返回 null。
 * 层级互斥：命中高层后不再降级评估。
 */
export function scoreCandidate(
  input: NormalizedOrderInput,
  cand: ScoringCandidate,
): { score: number; reason: string } | null {
  // L1 小程序 ID 精确
  if (input.miniProgramIdNorm && cand.miniProgramIdNorm && input.miniProgramIdNorm === cand.miniProgramIdNorm) {
    return { score: SCORE.MINIPROGRAM_EXACT, reason: "miniprogram_exact_match" };
  }
  // L1.5 客户编码精确
  if (input.customerCodeNorm && cand.customerCodeNorm && input.customerCodeNorm === cand.customerCodeNorm) {
    return { score: SCORE.CUSTOMER_CODE_EXACT, reason: "customer_code_exact_match" };
  }
  // L2 微信精确
  if (input.wechatNorm && cand.wechatNorm && input.wechatNorm === cand.wechatNorm) {
    return { score: SCORE.WECHAT_EXACT, reason: "wechat_exact_match" };
  }
  // L3 手机精确
  if (input.phoneNorm && cand.phones.includes(input.phoneNorm)) {
    return { score: SCORE.PHONE_EXACT, reason: "phone_exact_match" };
  }

  const nameExact = !!input.nameNorm && cand.nameVariantsNorm.includes(input.nameNorm);
  // 可信历史姓名变体命中（MERGED_NAME / FORMER_NAME，docs §9.2：与正式姓名同等可信）
  // alias 使用 aliasNameNorm（含 NFKC）与候选的 trustedAliasVariantsNorm 比较
  const trustedAliasHit = !!input.aliasNameNorm && cand.trustedAliasVariantsNorm.includes(input.aliasNameNorm);
  // 常用称呼命中（COMMON，弱变体：最高 NAME_ORG_PARTIAL 75，不自动建议）
  const commonAliasHit = !!input.aliasNameNorm && cand.commonAliasVariantsNorm.includes(input.aliasNameNorm);

  // 正式姓名或可信别名命中 → 与正式姓名同等评分
  const formalOrTrustedHit = nameExact || trustedAliasHit;

  // L4 / L5 姓名 + 机构（正式名/可信别名）
  if (formalOrTrustedHit && input.orgNorm) {
    if (cand.orgVariantsNorm.some((v) => v === input.orgNorm)) {
      return { score: SCORE.NAME_ORG_EXACT, reason: nameExact ? "name_org_exact" : "trusted_alias_org_exact" };
    }
    if (cand.orgVariantsNorm.some((v) => v && (input.orgNorm.includes(v) || v.includes(input.orgNorm)))) {
      return { score: SCORE.NAME_ORG_PARTIAL, reason: nameExact ? "name_org_partial" : "trusted_alias_org_partial" };
    }
  }

  // COMMON 别名 + 机构精确（docs §9.2：最高 75，不自动建议）
  if (commonAliasHit && input.orgNorm) {
    if (cand.orgVariantsNorm.some((v) => v === input.orgNorm)) {
      return { score: SCORE.NAME_ORG_PARTIAL, reason: "common_alias_org_exact" };
    }
  }

  // L6 姓名 + 地址重叠（正式名/可信别名）
  if (formalOrTrustedHit && input.addressNorm && cand.addressNorm) {
    const a = input.addressNorm;
    const b = cand.addressNorm;
    const overlap =
      a.includes(b.substring(0, Math.max(4, Math.floor(b.length * 0.5)))) ||
      b.includes(a.substring(0, Math.max(4, Math.floor(a.length * 0.5))));
    if (overlap) return { score: SCORE.NAME_ADDRESS_OVERLAP, reason: nameExact ? "name_address_overlap" : "trusted_alias_address_overlap" };
  }

  // L7 仅姓名（正式名/可信别名）
  if (formalOrTrustedHit) return { score: SCORE.NAME_ONLY, reason: nameExact ? "name_only" : "trusted_alias_only" };

  // COMMON 别名无机构（docs §9.2：仅低分候选）
  if (commonAliasHit) return { score: SCORE.NAME_ONLY, reason: "common_alias_only" };

  return null;
}

/**
 * 把打分后的候选汇总为三态结论（§5.3）。
 * - 无候选 → NO_MATCH
 * - 最高分 >= AUTO_SUGGEST_MIN 且领先第二名 >= AUTO_SUGGEST_LEAD → AUTO_SUGGESTED
 * - 其余（分差过小 / 仅姓名 / 中等分唯一命中）→ AMBIGUOUS，必须人工判断
 */
export function buildResolution(scored: ScoredCandidate[]): MatchRowResolution {
  const candidates = [...scored].sort((a, b) => b.score - a.score);
  const best = candidates[0] ?? null;
  const second = candidates[1];

  let status: MatchRowResolution["status"];
  if (!best) {
    status = "NO_MATCH";
  } else if (best.score >= AUTO_SUGGEST_MIN && (!second || best.score - second.score >= AUTO_SUGGEST_LEAD)) {
    status = "AUTO_SUGGESTED";
  } else {
    status = "AMBIGUOUS";
  }

  return {
    status,
    candidates,
    best,
    suggestedProfileId: status === "AUTO_SUGGESTED" && best ? best.profileId : null,
  };
}

/** 便捷：对一组候选逐个打分（>= MATCH_THRESHOLD 入选）并汇总。 */
export function resolveAgainstCandidates(
  input: ScoringOrderInput,
  candidates: ScoringCandidate[],
): MatchRowResolution {
  const norm = normalizeOrderInput(input);
  const scored: ScoredCandidate[] = [];
  for (const cand of candidates) {
    const hit = scoreCandidate(norm, cand);
    if (hit && hit.score >= MATCH_THRESHOLD) {
      scored.push({
        profileId: cand.profileId,
        name: cand.name,
        score: hit.score,
        reason: hit.reason,
      });
    }
  }
  return buildResolution(scored);
}

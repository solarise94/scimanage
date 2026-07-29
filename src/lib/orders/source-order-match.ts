/**
 * 订单导入行 → 候选客户匹配（按候选数组打分的入口）。
 *
 * 本文件不再自带分值表，统一复用 `@/lib/orders/match-scoring` 的单一分值表与阈值
 * （见 docs/order-import-crm-confirmation-design-2026-06-29.md §5.0/§5.4）。
 *
 * 字段主权（§5.1）：候选的业务信号（微信/手机/小程序ID/机构/地址）应由调用方装配为
 * CrmCustomerProfile 主权值后传入；本文件只把 MatchCandidate 折叠成 ScoringCandidate。
 */
import {
  extractPhones,
  normalizePhone,
  normalizeText,
  resolveAgainstCandidates,
  type MatchRowResolution,
  type ScoringCandidate,
  type ScoringOrderInput,
} from "@/lib/orders/match-scoring";
import {
  normalizeCustomerNameAlias,
  NAME_ALIAS_TYPE,
  type NameAliasType,
} from "@/lib/customers/customer-name-alias";

export interface MatchInput {
  buyerName?: string | null;
  buyerPhone?: string | null;
  buyerWechat?: string | null;
  buyerMiniProgramId?: string | null;
  buyerCustomerCode?: string | null;
  buyerOrgName?: string | null;
  buyerAddress?: string | null;
}

export interface MatchCandidate {
  /** CrmCustomerProfile.id（候选就是 Profile，必填）。 */
  profileId: string;
  /** Profile 展示姓名（CrmCustomerProfile.name）。 */
  name: string | null;
  customerCode?: string | null;
  wechat: string | null;
  /** Profile 手机号字段（与 principal 一起抽取手机号）。 */
  phone?: string | null;
  principal: string | null;
  miniProgramId?: string | null;
  organization: string | null;
  address: string | null;
  orgCanonicalName?: string | null;
  orgNormalizedName?: string | null;
  orgAliases?: string[];
  /** Names of all (non-archived) sites under this customer's org, e.g. ["医学院","药学院"]. */
  orgSiteNames?: string[];
  /** The specific site this customer is bound to, if any. */
  customerSiteName?: string | null;
  /** 活动称呼变体（docs §9.1），按 aliasType 分级为 trusted/common 评分。 */
  nameAliases?: Array<{ alias: string; aliasType: NameAliasType }>;
}

export interface MatchResult {
  profileId: string;
  score: number;
  reason: string;
}

/** 把 MatchCandidate 折叠为打分核心使用的 ScoringCandidate（Profile 主权值已由调用方装配）。 */
export function toScoringCandidate(cust: MatchCandidate): ScoringCandidate {
  const orgBaseName = cust.orgCanonicalName || cust.organization || "";
  const orgVariantsNorm = [
    normalizeText(cust.organization),
    normalizeText(cust.orgCanonicalName),
    normalizeText(cust.orgNormalizedName),
    ...(cust.orgAliases || []).map((a) => normalizeText(a)),
    // 站点名独立（如"医学院"）
    ...(cust.orgSiteNames || []).map((s) => normalizeText(s)),
    // "机构+站点" 组合名（如"浙江大学医学院"）
    ...(cust.orgSiteNames || []).map((s) => normalizeText(orgBaseName + s)),
    // 客户自身绑定站点的组合名
    normalizeText(orgBaseName + (cust.customerSiteName || "")),
  ].filter(Boolean);

  const phones = Array.from(
    new Set(
      [
        normalizePhone(cust.phone),
        normalizePhone(cust.principal),
        ...extractPhones(cust.phone),
        ...extractPhones(cust.principal),
      ].filter(Boolean),
    ),
  );

  const nameVariantsNorm = Array.from(
    new Set([normalizeText(cust.name)].filter(Boolean)),
  );

  // alias 分级：trusted（MERGED_NAME/FORMER_NAME）vs common（COMMON）
  // 用 normalizeCustomerNameAlias（保留括号），与 alias 唯一键一致（docs §4.4）
  const trustedAliasVariantsNorm: string[] = [];
  const commonAliasVariantsNorm: string[] = [];
  for (const a of cust.nameAliases || []) {
    const norm = normalizeCustomerNameAlias(a.alias);
    if (!norm || nameVariantsNorm.includes(norm)) continue; // 与正式名重复则跳过
    if (a.aliasType === NAME_ALIAS_TYPE.MERGED_NAME || a.aliasType === NAME_ALIAS_TYPE.FORMER_NAME) {
      trustedAliasVariantsNorm.push(norm);
    } else {
      commonAliasVariantsNorm.push(norm);
    }
  }

  return {
    profileId: cust.profileId,
    name: cust.name ?? "",
    customerCodeNorm: normalizeText(cust.customerCode),
    nameVariantsNorm,
    trustedAliasVariantsNorm: Array.from(new Set(trustedAliasVariantsNorm)),
    commonAliasVariantsNorm: Array.from(new Set(commonAliasVariantsNorm)),
    wechatNorm: normalizeText(cust.wechat),
    miniProgramIdNorm: normalizeText(cust.miniProgramId),
    phones,
    orgVariantsNorm,
    addressNorm: normalizeText(cust.address),
  };
}

function toScoringInput(input: MatchInput): ScoringOrderInput {
  return {
    buyerName: input.buyerName,
    buyerWechat: input.buyerWechat,
    buyerPhone: input.buyerPhone,
    buyerMiniProgramId: input.buyerMiniProgramId,
    buyerCustomerCode: input.buyerCustomerCode,
    buyerOrgName: input.buyerOrgName || input.buyerAddress,
    buyerAddress: input.buyerAddress,
  };
}

/**
 * 候选列表形态（§5.4）：返回 { status, candidates, best, suggestedProfileId }。
 * 这是确认页主路径应使用的入口。
 */
export function resolveImportRowMatch(
  input: MatchInput,
  candidates: MatchCandidate[],
): MatchRowResolution {
  return resolveAgainstCandidates(toScoringInput(input), candidates.map(toScoringCandidate));
}

/**
 * 向后兼容的单 best-match 入口：返回最高分候选（无候选返回 null）。
 * 内部复用 `resolveImportRowMatch`，不再维护独立分值表。
 */
export function matchImportRow(
  input: MatchInput,
  candidates: MatchCandidate[],
): MatchResult | null {
  const resolution = resolveImportRowMatch(input, candidates);
  if (!resolution.best) return null;
  return {
    profileId: resolution.best.profileId,
    score: resolution.best.score,
    reason: resolution.best.reason,
  };
}

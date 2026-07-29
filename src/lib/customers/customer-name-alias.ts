/**
 * 客户常用称呼 / 历史姓名变体 — 归一化、类型与去重 helper
 * docs/customer-name-alias-merge-dedup-fix-2026-07-13.md
 *
 * 与 `normalizeCustomerName()`（会移除括号内容）刻意不同：本归一化器**保留括号**，
 * 因为 `张三（北大）` 的括号内容可能承担消歧含义。
 */

export const NAME_ALIAS_TYPE = {
  COMMON: "COMMON",
  FORMER_NAME: "FORMER_NAME",
  MERGED_NAME: "MERGED_NAME",
} as const;
export type NameAliasType = (typeof NAME_ALIAS_TYPE)[keyof typeof NAME_ALIAS_TYPE];

export const NAME_ALIAS_SOURCE = {
  MANUAL: "MANUAL",
  CUSTOMER_MERGE: "CUSTOMER_MERGE",
  IMPORT: "IMPORT",
} as const;
export type NameAliasSourceType = (typeof NAME_ALIAS_SOURCE)[keyof typeof NAME_ALIAS_SOURCE];

/**
 * 归一化客户称呼变体。
 * - NFKC 归一化（全半角统一）
 * - trim + toLowerCase + 去空白
 * - 保留括号内容（不删除）
 * - 保留称谓（老师/主任/同学等）
 * 空字符串返回空串，调用方负责拒绝入库。
 */
export function normalizeCustomerNameAlias(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

/**
 * aliasType 优先级：合并去重/冲突时高优先级覆盖低优先级。
 * MERGED_NAME > FORMER_NAME > COMMON
 */
export const NAME_ALIAS_TYPE_PRIORITY: Record<NameAliasType, number> = {
  MERGED_NAME: 3,
  FORMER_NAME: 2,
  COMMON: 1,
};

/**
 * 判断 a 类型是否比 b 优先级更高（严格大于）。
 */
export function isHigherAliasType(a: NameAliasType, b: NameAliasType): boolean {
  return NAME_ALIAS_TYPE_PRIORITY[a] > NAME_ALIAS_TYPE_PRIORITY[b];
}

/**
 * 输入字符串转 NameAliasType（带兜底）。
 */
export function parseNameAliasType(v: string | null | undefined): NameAliasType {
  if (v === NAME_ALIAS_TYPE.MERGED_NAME) return NAME_ALIAS_TYPE.MERGED_NAME;
  if (v === NAME_ALIAS_TYPE.FORMER_NAME) return NAME_ALIAS_TYPE.FORMER_NAME;
  return NAME_ALIAS_TYPE.COMMON;
}

/**
 * 输入字符串转 NameAliasSourceType（带兜底）。
 */
export function parseNameAliasSourceType(v: string | null | undefined): NameAliasSourceType {
  if (v === NAME_ALIAS_SOURCE.CUSTOMER_MERGE) return NAME_ALIAS_SOURCE.CUSTOMER_MERGE;
  if (v === NAME_ALIAS_SOURCE.IMPORT) return NAME_ALIAS_SOURCE.IMPORT;
  return NAME_ALIAS_SOURCE.MANUAL;
}

/**
 * 匹配姓名/称呼的来源标签，用于 DuplicateCandidate.matchedNameType 与订单评分。
 * 注意：FORMAL 表示正式姓名命中（非 alias 记录）。
 */
export type MatchedNameType = "FORMAL" | "COMMON" | "FORMER_NAME" | "MERGED_NAME";

/**
 * aliasType 是否属于"可信历史姓名"（订单匹配中可作为与正式姓名同等可信度的变体）。
 */
export function isTrustedAliasType(t: NameAliasType): boolean {
  return t === NAME_ALIAS_TYPE.MERGED_NAME || t === NAME_ALIAS_TYPE.FORMER_NAME;
}

/** alias 行的最小形状（用于合并装配、订单匹配、查重）。 */
export interface NameAliasLite {
  id: string;
  alias: string;
  normalizedAlias: string;
  aliasType: NameAliasType;
  active: boolean;
}

/**
 * 候选称呼集合项：合并时用于生成 target 的 alias 记录。
 */
export interface AliasCandidate {
  /** 原文（未归一化），入库写入 `alias`。 */
  raw: string;
  /** 归一化值，入库写入 `normalizedAlias`，同时用于去重。 */
  normalized: string;
  aliasType: NameAliasType;
}

/**
 * 把多个候选称呼按 normalized 去重，优先级高的胜出（MERGED_NAME > FORMER_NAME > COMMON）。
 * normalized 相同时保留优先级最高的一条；同优先级保留先出现的一条。
 */
export function dedupeAliasCandidates(candidates: AliasCandidate[]): AliasCandidate[] {
  const map = new Map<string, AliasCandidate>();
  for (const c of candidates) {
    if (!c.normalized) continue;
    const existing = map.get(c.normalized);
    if (!existing) {
      map.set(c.normalized, c);
      continue;
    }
    if (isHigherAliasType(c.aliasType, existing.aliasType)) {
      map.set(c.normalized, c);
    }
  }
  return Array.from(map.values());
}

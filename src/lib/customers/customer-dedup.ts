/**
 * Customer dedup algorithm — scans CrmCustomerProfile for duplicate pairs
 * based on normalized name + organization + disambiguator, and miniProgramId.
 *
 * Generates CustomerMergeTask records for admin review (pair key: profileIdA/B).
 */

import { prisma } from "@/lib/prisma";
import { normalizeCustomerNameAlias, NAME_ALIAS_TYPE, type NameAliasType } from "@/lib/customers/customer-name-alias";

/**
 * Normalize a customer name for dedup comparison.
 * Strips whitespace, lowercases, removes common suffixes.
 */
export function normalizeCustomerName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[（(].*?[）)]/g, ""); // remove parenthetical suffixes
}

/**
 * Normalize a phone number for dedup comparison.
 * Trim, remove spaces/hyphens, strip +86/0086 prefix, keep digits only.
 */
export function normalizePhone(phone: string | null | undefined): string {
  if (!phone) return "";
  return phone
    .trim()
    .replace(/[\s-]/g, "")
    .replace(/^(\+86|0086)/, "")
    .replace(/\D/g, "");
}

/**
 * Normalize a WeChat ID for dedup comparison.
 * Trim + lowercase.
 */
export function normalizeWechat(wechat: string | null | undefined): string {
  if (!wechat) return "";
  return wechat.trim().toLowerCase();
}


export interface DuplicatePair {
  profileIdA: string;
  profileIdB: string;
  matchTier: "EXACT" | "HIGH" | "MEDIUM";
  matchScore: number;
  matchReasons: string[];
  fieldDiff: Record<string, { a: unknown; b: unknown }>;
}

type ScanProfile = {
  id: string;
  name: string | null;
  nameDisambiguator: string | null;
  organization: string | null;
  organizationRawInput: string | null;
  organizationId: string | null;
  miniProgramId: string | null;
  principal: string | null;
  email: string | null;
  wechat: string | null;
  phone: string | null;
  nameAliases: Array<{ alias: string; normalizedAlias: string; aliasType: string }>;
};

/** Tier 优先级数值（越小越高）。用于跨规则合并时保留最高 tier。 */
const TIER_RANK: Record<DuplicatePair["matchTier"], number> = { EXACT: 0, HIGH: 1, MEDIUM: 2 };
function higherTier(a: DuplicatePair["matchTier"], b: DuplicatePair["matchTier"]): DuplicatePair["matchTier"] {
  return TIER_RANK[a] <= TIER_RANK[b] ? a : b;
}

/**
 * Normalize an organization name for dedup comparison.
 * Reuses the same logic as organization-normalize.
 */
function normalizeOrgName(org: string | null | undefined): string {
  if (!org) return "";
  return org
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/大学|学院|研究所|实验室|中心/g, "");
}

/**
 * Build a dedup key from normalized name + org + disambiguator.
 */
function dedupKey(name: string, org: string, disambiguator: string | null): string {
  return `${normalizeCustomerName(name)}|${normalizeOrgName(org)}|${(disambiguator || "").trim().toLowerCase()}`;
}

/** Profile 正式展示姓名；为空时返回空串。 */
function effectiveName(p: { name: string | null }): string {
  return p.name ?? "";
}

/**
 * Scan active profiles and find duplicate pairs.
 */
export async function scanDuplicateCustomerPairs(): Promise<{
  pairs: DuplicatePair[];
  skippedNoOrg: number;
  truncatedAliasBuckets: Array<{ key: string; count: number }>;
}> {
  const profiles = await prisma.crmCustomerProfile.findMany({
    where: { deleted: false, mergedIntoProfileId: null, archived: false },
    select: {
      id: true,
      name: true,
      nameDisambiguator: true,
      organization: true,
      organizationRawInput: true,
      organizationId: true,
      miniProgramId: true,
      principal: true,
      email: true,
      wechat: true,
      phone: true,
      nameAliases: { where: { active: true }, select: { alias: true, normalizedAlias: true, aliasType: true } },
    },
    orderBy: { createdAt: "asc" },
  }) as ScanProfile[];

  // 治理 P8/D5：MANAGING 代表标签用于辅助去重（同代表提升 MEDIUM 匹配度）。
  const repTags = await prisma.customerRepTag.findMany({
    where: { tagType: "MANAGING", isActive: true, profile: { deleted: false, archived: false } },
    select: { profileId: true, representativeId: true },
  });
  const profileRepMap = new Map<string, Set<string>>();
  for (const tag of repTags) {
    const set = profileRepMap.get(tag.profileId) || new Set<string>();
    set.add(tag.representativeId);
    profileRepMap.set(tag.profileId, set);
  }

  // Group by dedup key (name + org + disambiguator)
  const keyBuckets = new Map<string, ScanProfile[]>();
  for (const p of profiles) {
    const name = effectiveName(p);
    if (!name || !p.organization) continue;
    const key = dedupKey(name, p.organization, p.nameDisambiguator);
    const bucket = keyBuckets.get(key) || [];
    bucket.push(p);
    keyBuckets.set(key, bucket);
  }

  // Also group by miniProgramId for cross-org blocking
  const mpIdBuckets = new Map<string, ScanProfile[]>();
  for (const p of profiles) {
    if (!p.miniProgramId) continue;
    const bucket = mpIdBuckets.get(p.miniProgramId) || [];
    bucket.push(p);
    mpIdBuckets.set(p.miniProgramId, bucket);
  }

  // Group by name+phone for contact-based dedup
  const namePhoneBuckets = new Map<string, ScanProfile[]>();
  for (const p of profiles) {
    const name = effectiveName(p);
    const phoneNorm = normalizePhone(p.phone);
    if (!name || !phoneNorm) continue;
    const key = `${normalizeCustomerName(name)}|${phoneNorm}`;
    const bucket = namePhoneBuckets.get(key) || [];
    bucket.push(p);
    namePhoneBuckets.set(key, bucket);
  }

  // Group by name+wechat for contact-based dedup
  const nameWechatBuckets = new Map<string, ScanProfile[]>();
  for (const p of profiles) {
    const name = effectiveName(p);
    const wechatNorm = normalizeWechat(p.wechat);
    if (!name || !wechatNorm) continue;
    const key = `${normalizeCustomerName(name)}|${wechatNorm}`;
    const bucket = nameWechatBuckets.get(key) || [];
    bucket.push(p);
    nameWechatBuckets.set(key, bucket);
  }

  // 统计真正无法被任何维度匹配的 Profile：无机构 + 无电话 + 无微信 + 无小程序ID。
  let skippedNoOrg = 0;
  for (const p of profiles) {
    if (
      !p.organization &&
      !normalizePhone(p.phone) &&
      !normalizeWechat(p.wechat) &&
      !p.miniProgramId
    ) {
      skippedNoOrg++;
    }
  }

  const pairs: DuplicatePair[] = [];
  const pairByKey = new Map<string, DuplicatePair>();

  function addPair(a: ScanProfile, b: ScanProfile, tier: "EXACT" | "HIGH" | "MEDIUM", score: number, reasons: string[]) {
    const [idA, idB] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];
    const pairKey = `${idA}:${idB}`;

    // Ensure `first` always maps to the smaller profileId (idA), `second` to the larger (idB)
    const [first, second] = a.id < b.id ? [a, b] : [b, a];

    const fieldDiff = {
      name: { a: effectiveName(first), b: effectiveName(second) },
      organization: { a: first.organization ?? null, b: second.organization ?? null },
      principal: { a: first.principal ?? null, b: second.principal ?? null },
      email: { a: first.email ?? null, b: second.email ?? null },
      wechat: { a: first.wechat ?? null, b: second.wechat ?? null },
      phone: { a: first.phone ?? null, b: second.phone ?? null },
      miniProgramId: { a: first.miniProgramId ?? null, b: second.miniProgramId ?? null },
      representative: { a: [...(profileRepMap.get(first.id) || new Set())], b: [...(profileRepMap.get(second.id) || new Set())] },
    };

    const existing = pairByKey.get(pairKey);
    if (existing) {
      // 跨规则合并：保留最高 tier、最高 score，合并去重 reasons
      existing.matchTier = higherTier(existing.matchTier, tier);
      existing.matchScore = Math.max(existing.matchScore, score);
      for (const r of reasons) {
        if (!existing.matchReasons.includes(r)) existing.matchReasons.push(r);
      }
      // fieldDiff 保持首次计算的值（客户字段不会因规则不同而变化）
      return;
    }

    const pair: DuplicatePair = {
      profileIdA: idA,
      profileIdB: idB,
      matchTier: tier,
      matchScore: score,
      matchReasons: [...reasons],
      fieldDiff,
    };
    pairByKey.set(pairKey, pair);
    pairs.push(pair);
  }

  // EXACT: same dedup key (name + org + disambiguator all match)
  for (const [, bucket] of keyBuckets) {
    if (bucket.length < 2) continue;
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        addPair(bucket[i], bucket[j], "EXACT", 1.0, ["姓名+单位完全匹配"]);
      }
    }
  }

  // HIGH: same miniProgramId (cross-org blocking)
  for (const [, bucket] of mpIdBuckets) {
    if (bucket.length < 2) continue;
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const a = bucket[i], b = bucket[j];
        const reasons = ["小程序ID匹配"];
        const nameA = effectiveName(a);
        const nameB = effectiveName(b);
        if (nameA && nameB && normalizeCustomerName(nameA) === normalizeCustomerName(nameB)) {
          reasons.push("姓名匹配");
        }
        addPair(a, b, "HIGH", 0.9, reasons);
      }
    }
  }

  // HIGH: same name + phone
  for (const [, bucket] of namePhoneBuckets) {
    if (bucket.length < 2) continue;
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        addPair(bucket[i], bucket[j], "HIGH", 0.85, ["姓名+电话匹配"]);
      }
    }
  }

  // HIGH: same name + wechat
  for (const [, bucket] of nameWechatBuckets) {
    if (bucket.length < 2) continue;
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        addPair(bucket[i], bucket[j], "HIGH", 0.85, ["姓名+微信匹配"]);
      }
    }
  }

  // MEDIUM: same name, different org (potential misspelling or org change)
  const nameBuckets = new Map<string, ScanProfile[]>();
  for (const p of profiles) {
    const key = normalizeCustomerName(effectiveName(p));
    if (!key) continue;
    const bucket = nameBuckets.get(key) || [];
    bucket.push(p);
    nameBuckets.set(key, bucket);
  }

  for (const [, bucket] of nameBuckets) {
    if (bucket.length < 2) continue;
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const a = bucket[i], b = bucket[j];
        // 跨规则合并模式下不再跳过已见 pair；addPair 内部会合并 reasons。
        const reasons = ["姓名匹配"];
        if (a.organization && b.organization && normalizeOrgName(a.organization) === normalizeOrgName(b.organization)) {
          reasons.push("单位相似");
        }
        const repsA = profileRepMap.get(a.id);
        const repsB = profileRepMap.get(b.id);
        if (repsA && repsB) {
          const shared = [...repsA].some((id) => repsB.has(id));
          if (shared) {
            reasons.push("同负责代表");
          }
        }
        const score = reasons.includes("同负责代表") ? 0.75 : 0.7;
        addPair(a, b, "MEDIUM", score, reasons);
      }
    }
  }

  // ── P2：alias 比较桶（docs §10）──
  // 新桶使用 normalizeCustomerNameAlias（保留括号），不做全库 alias 两两比较。
  // 只比较"某客户正式姓名 vs 另一客户 alias"以及同机构约束下的 alias-alias 组合。
  // 按 organizationId + normalizeCustomerNameAlias(value) 分桶；正式姓名进桶时也用 normalizeCustomerNameAlias。
  // 限制每个 bucket 组合数量，防止"王老师"桶拖垮扫描。
  const ALIAS_BUCKET_LIMIT = 50;
  const truncatedAliasBuckets: Array<{ key: string; count: number }> = [];

  const aliasVariantBuckets = new Map<string, Array<{ profile: ScanProfile; type: "FORMAL" | NameAliasType; disambiguator: string | null }>>();
  for (const p of profiles) {
    const orgId = p.organizationId;
    if (!orgId) continue;
    const disambiguator = p.nameDisambiguator?.trim().toLowerCase() || null;
    // 正式姓名（用 normalizeCustomerNameAlias 归一化，进 alias 桶）
    const formalNorm = normalizeCustomerNameAlias(effectiveName(p));
    if (formalNorm) {
      const key = `${orgId}|${formalNorm}`;
      const bucket = aliasVariantBuckets.get(key) || [];
      bucket.push({ profile: p, type: "FORMAL", disambiguator });
      aliasVariantBuckets.set(key, bucket);
    }
    // alias
    for (const a of p.nameAliases || []) {
      const norm = a.normalizedAlias;
      if (!norm) continue;
      const key = `${orgId}|${norm}`;
      const bucket = aliasVariantBuckets.get(key) || [];
      bucket.push({ profile: p, type: a.aliasType as NameAliasType, disambiguator });
      aliasVariantBuckets.set(key, bucket);
    }
  }

  for (const [bucketKey, bucket] of aliasVariantBuckets) {
    if (bucket.length < 2) continue;
    // 限制组合数量
    if (bucket.length > ALIAS_BUCKET_LIMIT) {
      truncatedAliasBuckets.push({ key: bucketKey, count: bucket.length });
      continue;
    }
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const { profile: a, type: typeA, disambiguator: disambA } = bucket[i];
        const { profile: b, type: typeB, disambiguator: disambB } = bucket[j];
        // 排除自配对
        if (a.id === b.id) continue;
        // 跨规则合并模式下不再跳过已见 pair；addPair 内部会合并 reasons。

        const isFormal = (t: "FORMAL" | NameAliasType) => t === "FORMAL";
        const isTrustedAlias = (t: "FORMAL" | NameAliasType) =>
          t === NAME_ALIAS_TYPE.MERGED_NAME || t === NAME_ALIAS_TYPE.FORMER_NAME;
        const isCommon = (t: "FORMAL" | NameAliasType) => t === NAME_ALIAS_TYPE.COMMON;
        const bothFormal = isFormal(typeA) && isFormal(typeB);
        const anyTrustedAlias = isTrustedAlias(typeA) || isTrustedAlias(typeB);
        const bothCommon = isCommon(typeA) && isCommon(typeB);

        // Disambiguator guard: if both sides have different non-empty
        // disambiguators, the customers have been explicitly told apart.
        // Name/alias evidence alone must NOT promote them to HIGH.
        const hasConflictingDisambiguator =
          disambA != null && disambB != null && disambA !== disambB;

        if (bothFormal) {
          // FORMAL vs FORMAL is handled by the EXACT keyBuckets rule.
          // Skip here to avoid duplicating that logic and to respect the
          // disambiguator guard consistently.
          continue;
        } else if (anyTrustedAlias && !bothCommon) {
          // FORMAL vs MERGED_NAME/FORMER_NAME or trusted aliases vs each other:
          // real signal, but respect disambiguator guard.
          if (hasConflictingDisambiguator) {
            // Explicitly disambiguated: downgrade to MEDIUM
            const reasons = ["历史姓名/合并姓名匹配（已消歧）"];
            if (a.organization && b.organization && normalizeOrgName(a.organization) === normalizeOrgName(b.organization)) {
              reasons.push("单位相似");
            }
            addPair(a, b, "MEDIUM", 0.7, reasons);
          } else {
            addPair(a, b, "HIGH", 0.88, ["历史姓名/合并姓名匹配"]);
          }
        } else if (bothCommon) {
          // COMMON vs COMMON: no direct task (docs §10.4).
          continue;
        } else {
          // COMMON vs formal/trusted alias -> MEDIUM
          // Also respect disambiguator guard for COMMON pairs
          if (hasConflictingDisambiguator) {
            continue;
          }
          const reasons = ["常用称呼匹配"];
          if (a.organization && b.organization && normalizeOrgName(a.organization) === normalizeOrgName(b.organization)) {
            reasons.push("单位相似");
          }
          addPair(a, b, "MEDIUM", 0.72, reasons);
        }
      }
    }
  }

  // Sort: EXACT first, then HIGH, then MEDIUM
  const tierOrder = { EXACT: 0, HIGH: 1, MEDIUM: 2 };
  pairs.sort((a, b) => tierOrder[a.matchTier] - tierOrder[b.matchTier] || b.matchScore - a.matchScore);

  return { pairs, skippedNoOrg, truncatedAliasBuckets };
}

/** Count rows linked by the canonical profileId. */
async function countProfileOrLegacyCustomer(
  profileId: string,
  model: "project" | "order" | "financeReceipt" | "financeCost",
) {
  const where = { profileId };

  switch (model) {
    case "project":
      return prisma.project.count({ where });
    case "order":
      return prisma.order.count({ where });
    case "financeReceipt":
      return prisma.financeReceipt.count({ where });
    case "financeCost":
      return prisma.financeCost.count({ where });
  }
}

async function countPartyResources(profileId: string) {
  const [projects, orders, receipts, financeCosts] = await Promise.all([
    countProfileOrLegacyCustomer(profileId, "project"),
    countProfileOrLegacyCustomer(profileId, "order"),
    countProfileOrLegacyCustomer(profileId, "financeReceipt"),
    countProfileOrLegacyCustomer(profileId, "financeCost"),
  ]);
  return { projects, orders, receipts, financeCosts };
}

/**
 * Get merge preview data for a given task.
 */
export async function getMergePreview(taskId: string) {
  const previewProfileSelect = {
    id: true,
    deleted: true,
    mergedIntoProfileId: true,
    name: true,
    customerCode: true,
    organization: true,
    stage: true,
    importance: true,
    org: { select: { canonicalName: true } },
    profileRepTags: {
      where: { tagType: "MANAGING", isActive: true },
      include: { representative: { select: { name: true } } },
    },
  } as const;

  const task = await prisma.customerMergeTask.findUnique({
    where: { id: taskId },
    include: {
      profileA: { select: previewProfileSelect },
      profileB: { select: previewProfileSelect },
    },
  });

  if (!task) return null;

  const { profileA, profileB, ...taskRest } = task;

  const [relationsA, relationsB, countsA, countsB] = await Promise.all([
    prisma.customerRelation.count({
      where: { OR: [{ fromProfileId: taskRest.profileIdA }, { toProfileId: taskRest.profileIdA }] },
    }),
    prisma.customerRelation.count({
      where: { OR: [{ fromProfileId: taskRest.profileIdB }, { toProfileId: taskRest.profileIdB }] },
    }),
    countPartyResources(profileA.id),
    countPartyResources(profileB.id),
  ]);

  function buildProfilePreview(
    profile: typeof profileA,
    counts: { projects: number; orders: number; receipts: number; financeCosts: number },
  ) {
    const orgCanon = profile.org?.canonicalName;
    const organization = orgCanon || profile.organization || null;
    return {
      id: profile.id,
      name: profile.name,
      customerCode: profile.customerCode,
      organization,
      stage: profile.stage,
      importance: profile.importance,
      deleted: profile.deleted,
      mergedIntoProfileId: profile.mergedIntoProfileId,
      _count: {
        projects: counts.projects,
        orders: counts.orders,
        receipts: counts.receipts,
        financeCosts: counts.financeCosts,
      },
      repTags: profile.profileRepTags,
    };
  }

  return {
    task: {
      ...taskRest,
      profileA: buildProfilePreview(profileA, countsA),
      profileB: buildProfilePreview(profileB, countsB),
    },
    relationCountA: relationsA,
    relationCountB: relationsB,
  };
}

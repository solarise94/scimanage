/**
 * 机构解析核心逻辑（src/lib/organizations/resolve-core.ts）
 *
 * 从 `@/lib/organization-resolver` 抽取并增强：
 * - 支持传入 CRM scope（Organization findMany where），scope 外即使全量能匹配到
 *   同名机构也返回 NOT_FOUND，不向调用方暴露 scope 外机构的存在。
 * - 支持批量解析：一次查询 scope 内 Organization + 已通过 alias，内存内做
 *   精确/模糊匹配，避免 N 次往返数据库。
 *
 * 匹配口径与 `organization-resolver.ts` 保持一致：
 * - 精确匹配（normalizedName / canonicalName / 已通过 alias）→ RESOLVED，直接可用。
 * - 模糊匹配（编辑距离 ≤ 2）永远不自动判定为精确，一律 AMBIGUOUS，需要人工确认。
 * - 无任何命中 → NOT_FOUND。
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { normalizeOrgName } from "@/lib/organization-normalize";
import { getEffectiveCrmVisibleProfileIds } from "@/lib/crm/permissions";

export type OrgResolveResult = {
  status: "RESOLVED" | "AMBIGUOUS" | "NOT_FOUND";
  organization?: { id: string; name: string };
  candidates?: Array<{ id: string; name: string; score: number }>;
};

type ScopedOrg = {
  id: string;
  canonicalName: string;
  normalizedName: string;
  aliases: Array<{ normalizedAlias: string }>;
};

const SQLITE_PARAM_LIMIT = 900;

function chunk<T>(items: T[], limit: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += limit) chunks.push(items.slice(i, i + limit));
  return chunks;
}

/** 加载 scope 内（deleted=false, archived=false）的机构 + 已通过 alias，供内存匹配。 */
async function loadScopedOrganizations(
  scopeWhere?: Prisma.OrganizationWhereInput | null,
): Promise<ScopedOrg[]> {
  const where: Prisma.OrganizationWhereInput = scopeWhere
    ? { deleted: false, archived: false, AND: [scopeWhere] }
    : { deleted: false, archived: false };

  return prisma.organization.findMany({
    where,
    select: {
      id: true,
      canonicalName: true,
      normalizedName: true,
      aliases: {
        where: { approved: true },
        select: { normalizedAlias: true },
      },
    },
  });
}

/**
 * 经典 Levenshtein 编辑距离（O(n*m)，双行滚动数组）。
 * 机构名一般较短（<= 数十字），无需更复杂的算法。
 */
function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  const al = a.length;
  const bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;

  let prevRow = new Array<number>(bl + 1);
  let currRow = new Array<number>(bl + 1);
  for (let j = 0; j <= bl; j++) prevRow[j] = j;

  for (let i = 1; i <= al; i++) {
    currRow[0] = i;
    for (let j = 1; j <= bl; j++) {
      const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1;
      currRow[j] = Math.min(
        prevRow[j] + 1, // 删除
        currRow[j - 1] + 1, // 插入
        prevRow[j - 1] + substitutionCost, // 替换
      );
    }
    const tmp = prevRow;
    prevRow = currRow;
    currRow = tmp;
  }
  return prevRow[bl];
}

/** 模糊候选打分：1 - 编辑距离 / 较长字符串长度，越接近 1 越相似。 */
function fuzzyScore(distance: number, a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length, 1);
  return Math.max(0, 1 - distance / maxLen);
}

/** 单个名称在给定候选机构集合内的匹配（纯内存计算，不查库）。 */
function matchNameAgainstOrgs(payerName: string, orgs: ScopedOrg[]): OrgResolveResult {
  const trimmed = payerName.trim();
  const normalized = normalizeOrgName(payerName);
  if (!normalized) {
    return { status: "NOT_FOUND" };
  }

  // Step 1: 精确匹配 normalizedName / canonicalName
  const exactOrg = orgs.find(
    (o) => o.normalizedName === normalized || o.canonicalName === trimmed,
  );
  if (exactOrg) {
    return {
      status: "RESOLVED",
      organization: { id: exactOrg.id, name: exactOrg.canonicalName },
    };
  }

  // Step 2: 精确匹配已通过 alias
  const exactAliasOrg = orgs.find((o) => o.aliases.some((a) => a.normalizedAlias === normalized));
  if (exactAliasOrg) {
    return {
      status: "RESOLVED",
      organization: { id: exactAliasOrg.id, name: exactAliasOrg.canonicalName },
    };
  }

  // Step 3: 模糊匹配（编辑距离 ≤ 2），永远不自动判定为精确 —— 需要人工确认
  const bestByOrg = new Map<string, { id: string; name: string; score: number }>();
  for (const org of orgs) {
    let bestDistance = levenshteinDistance(normalized, org.normalizedName);
    for (const alias of org.aliases) {
      const aliasDistance = levenshteinDistance(normalized, alias.normalizedAlias);
      if (aliasDistance < bestDistance) bestDistance = aliasDistance;
    }
    if (bestDistance <= 2) {
      const score = fuzzyScore(bestDistance, normalized, org.normalizedName);
      const existing = bestByOrg.get(org.id);
      if (!existing || score > existing.score) {
        bestByOrg.set(org.id, { id: org.id, name: org.canonicalName, score });
      }
    }
  }

  if (bestByOrg.size === 0) {
    return { status: "NOT_FOUND" };
  }

  const candidates = [...bestByOrg.values()].sort((a, b) => b.score - a.score);
  return { status: "AMBIGUOUS", candidates };
}

/**
 * 单条解析。scopeWhere 为 null/undefined 时全量；否则带入 Organization findMany where
 * （AND 合并，不覆盖 deleted/archived 基础条件）。scope 外即使全量有匹配也返回 NOT_FOUND。
 */
export async function resolveOrganizationCore(
  payerName: string,
  scopeWhere?: Prisma.OrganizationWhereInput | null,
): Promise<OrgResolveResult> {
  const map = await resolveOrganizationsBatch([payerName], scopeWhere);
  return map.get(payerName) ?? { status: "NOT_FOUND" };
}

/**
 * 批量解析：一次查询 scope 内 Organization + alias，内存内逐个匹配。
 * 匹配顺序：精确 normalizedName/canonicalName > 精确 alias > 编辑距离 ≤ 2 的模糊（AMBIGUOUS）。
 */
export async function resolveOrganizationsBatch(
  names: string[],
  scopeWhere?: Prisma.OrganizationWhereInput | null,
): Promise<Map<string, OrgResolveResult>> {
  const result = new Map<string, OrgResolveResult>();
  if (names.length === 0) return result;

  const orgs = await loadScopedOrganizations(scopeWhere);
  for (const name of names) {
    result.set(name, matchNameAgainstOrgs(name, orgs));
  }
  return result;
}

/**
 * 根据角色构造 Organization 的 scopeWhere（基于 CRM profile 可见范围）。
 * - ADMIN / USER：`getEffectiveCrmVisibleProfileIds` 返回 null（全量可见）→ 返回 null（不限制）。
 * - 其他角色（REPRESENTATIVE / REGIONAL_MANAGER 等）：取可见 profile 的 organizationId 去重；
 *   无可见 profile 或可见 profile 均未绑定机构时，返回 `{ id: { in: ["__NO_MATCH__"] } }`
 *   （构造出恒不匹配的条件，而不是放开全量）。
 */
export async function getOrganizationResolveScopeWhere(
  userId: string,
  role: string,
): Promise<Prisma.OrganizationWhereInput | null> {
  const visibleProfileIds = await getEffectiveCrmVisibleProfileIds(userId, role);
  if (visibleProfileIds === null) return null;

  if (visibleProfileIds.size === 0) {
    return { id: { in: ["__NO_MATCH__"] } };
  }

  const orgIdSet = new Set<string>();
  for (const idsChunk of chunk([...visibleProfileIds], SQLITE_PARAM_LIMIT)) {
    const profiles = await prisma.crmCustomerProfile.findMany({
      where: { id: { in: idsChunk } },
      select: { organizationId: true },
    });
    for (const p of profiles) {
      if (p.organizationId) orgIdSet.add(p.organizationId);
    }
  }

  if (orgIdSet.size === 0) {
    return { id: { in: ["__NO_MATCH__"] } };
  }

  return { id: { in: [...orgIdSet] } };
}

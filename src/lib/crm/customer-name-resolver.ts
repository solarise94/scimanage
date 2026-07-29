/**
 * Agent 语音客户名消歧（AGENT-VOICE-01）。
 *
 * 把可能含同音错字的语音转写姓名解析为当前 actor 可见 scope 内的候选
 * CrmCustomerProfile。分两层：
 *
 *   1. 数据层 `gatherNameResolutionCandidates` —— 碰 DB、走 scope（唯一真相源
 *      `getEffectiveCrmVisibleProfileIds`），任何信号都不得扩大可见范围。
 *   2. 纯函数层 `scoreAndResolve` —— 给候选打分并给出 UNIQUE/AMBIGUOUS/NO_MATCH
 *      决策，便于 smoke 测试无需 DB。
 *
 * 关键用例：ASR 同音错字（"王小明" 实际客户 "王晓明"）。pinyin-match 不能把
 * 汉字转拼音，因此同音比对依赖 pinyin-pro 的 `pinyin(text, { toneType:"none" })`。
 */

import type { Prisma } from "@prisma/client";
import PinyinMatch from "pinyin-match";

import { prisma } from "@/lib/prisma";
import { getEffectiveCrmVisibleProfileIds } from "@/lib/crm/permissions";
// `toPinyinToneless` 的实现已迁出至独立模块 `@/lib/crm/pinyin`（namePinyin 字段唯一真相源）。
// 这里 re-export 以保持历史调用方与 smoke 测试（`@/lib/crm/customer-name-resolver`）可用。
import { toPinyinToneless } from "@/lib/crm/pinyin";
import { collectByChunks } from "@/lib/finance/query-chunk";

export { toPinyinToneless };

// ── 公共类型 ──────────────────────────────────────────────────────────────

export type NameResolutionResult = "UNIQUE" | "AMBIGUOUS" | "NO_MATCH";

export interface NameResolutionHints {
  /** 机构线索（用户语音里顺带提到的单位/机构）。可选。 */
  organizationHint?: string | null;
  /** 负责人/PI 线索。可选。 */
  principalHint?: string | null;
}

export interface NameResolutionCandidate {
  profileId: string;
  name: string;
  organization: string | null;
  ownerName: string | null;
  /** 0-100 综合得分。 */
  score: number;
  /** 人类可读的命中原因（中文），用于 UI chip 与可解释性。 */
  reasons: string[];
  /**
   * 排序尾锚分（tie-breaker）：hint 命中、最近互动等「排序信号」单独累加，
   * 不参与 score 的 0-100 clamp。仅用于同名同分时打破平局，不进入决策阈值。
   */
  tieBreaker?: number;
}

export interface NameResolutionOutput {
  normalizedSpokenName: string;
  candidates: NameResolutionCandidate[];
  resolution: NameResolutionResult;
}

// ── 决策阈值（导出常量，便于 smoke 测试断言） ────────────────────────────────
//
// 取值理由：
//  - UNIQUE_MIN_SCORE = 85：要求「可信命中」（汉字精确/包含 或 同音全拼命中）才
//    允许 UNIQUE；弱信号（拼音首字母、编辑距离、机构加分）单独不足以唯一确定。
//  - UNIQUE_MARGIN = 12：第二名必须明显落后。低于此差值视为旗鼓相当 → AMBIGUOUS，
//    防止同音错字场景误唯一化（如两个发音相同的候选人）。
//  - 纯机构/负责人命中不达 UNIQUE 阈值，保证不会只凭机构猜测就唯一锁定。
export const UNIQUE_MIN_SCORE = 85;
export const UNIQUE_MARGIN = 12;

// ── 内部评分常量 ──────────────────────────────────────────────────────────
//
// 分两类：
//  - 基础匹配分（NAME_*/ALIAS_*/PINYIN_*）：反映姓名/拼音匹配强度，进入 score
//    并参与 0-100 clamp 与决策阈值（UNIQUE_MIN_SCORE/UNIQUE_MARGIN）。
//  - 排序信号（ORG_HINT/PRINCIPAL_HINT/RECENT_INTERACTION）：只影响排序，累加到
//    tieBreaker 而非 score，避免把姓名精确命中（100）的候选压回 100 而无法
//    打破同名平局（见 scoreAndResolve）。

const SCORE = {
  NAME_EXACT: 100, // 姓名精确相等（归一化后）
  NAME_CONTAINS: 92, // 姓名包含/被包含
  ALIAS_EXACT: 90, // 活动 alias 精确
  ALIAS_CONTAINS: 82, // 活动 alias 包含
  PINYIN_EXACT: 88, // 去声调全拼完全相等（同音错字核心）
  PINYIN_EDIT_DIST_1: 70, // 拼音编辑距离 ≤1
  PINYIN_MATCH: 65, // pinyin-match 命中（拼音/首字母输入）
  ORG_HINT: 8, // 机构线索命中（tieBreaker，不进 score）
  PRINCIPAL_HINT: 8, // 负责人线索命中（tieBreaker，不进 score）
  RECENT_INTERACTION: 3, // 最近 30 天互动（tieBreaker，不进 score）
} as const;

const RECENT_INTERACTION_DAYS = 30;
const RECENT_INTERACTION_MS = RECENT_INTERACTION_DAYS * 24 * 60 * 60 * 1000;

// ── 数据层 ────────────────────────────────────────────────────────────────

/** 数据库召回的最小候选形状。 */
export interface GatheredCandidate {
  profileId: string;
  name: string;
  /**
   * DB 持久化的去声调全拼（`CrmCustomerProfile.namePinyin`）。
   * 由写路径（create-profile / 回填脚本）填充；gather 直查时直接取出，避免在
   * 打分阶段对每个候选重复跑 pinyin-pro。null 表示 DB 未回填（罕见，scoreAndResolve
   * 会回退到内存 `toPinyinToneless(name)`）。
   */
  namePinyin: string | null;
  organization: string | null;
  ownerName: string | null;
  principal: string | null;
  lastInteractionAt: Date | null;
  aliases: Array<{ alias: string; aliasType: string; active: boolean }>;
}

/**
 * 在 actor scope 内召回客户名解析候选。
 *
 * 召回策略（docs §6.2）—— 优先走 SQL 索引精确匹配，避免依赖固定时间窗口：
 *
 *  - **Set scope（REP/RM）**：分块（每批 500 id）SQL 预筛
 *    `namePinyin == spokenPinyin OR name contains spokenName OR alias contains spokenName`；
 *    预筛为空时再分块拉全 scope 做内存 pinyin-match 补召回（覆盖拼音首字母输入）。
 *  - **null scope（ADMIN/USER 全量）**：
 *    `namePinyin ==` 走索引精确查（这是冷客户召回的核心，纯 SQL，不依赖窗口）；
 *    name/alias contains 取 50；拼音首字母 fallback 保留「最近 500 条内存 pinyin-match」
 *    作为 best-effort 兜底（全量库无索引无法做首字母精确匹配；namePinyin 精确路径已不依赖窗口）。
 *
 * 安全硬约束：所有查询全程 `archived:false, deleted:false`，且严格只在
 * `getEffectiveCrmVisibleProfileIds` 返回的集合内召回。null（ADMIN/USER 全量）时不得
 * 把任何召回信号作为扩大可见范围的依据。不返回 scope 外候选数量（防侧信道）。
 */
export async function gatherNameResolutionCandidates(
  actor: { userId: string; role: string },
  spokenName: string,
): Promise<GatheredCandidate[]> {
  const normalizedSpoken = normalizeForCompare(spokenName);
  if (!normalizedSpoken) return [];

  // 预计算 spoken 的去声调全拼，用于同音错字召回（pinyin-match 不做汉字间同音比较）。
  const spokenPinyin = toPinyinToneless(normalizedSpoken);

  const scopeIds = await getEffectiveCrmVisibleProfileIds(actor.userId, actor.role);

  if (scopeIds === null) {
    return gatherForNullScope(normalizedSpoken, spokenPinyin);
  }
  if (scopeIds.size === 0) return [];
  return gatherForSetScope([...scopeIds], normalizedSpoken, spokenPinyin);
}

/**
 * null scope（ADMIN/USER 全量）召回：纯 SQL 走 `namePinyin` 索引精确查（核心路径，
 * 不依赖时间窗口），辅以 name/alias contains 与 best-effort 拼音首字母 fallback。
 */
async function gatherForNullScope(
  normalizedSpoken: string,
  spokenPinyin: string,
): Promise<GatheredCandidate[]> {
  // 1. namePinyin 精确命中（同音错字核心，走 @@index([namePinyin])）。
  const baseWhere = { archived: false, deleted: false };
  const pinyinExact: RawProfile[] = spokenPinyin
    ? await prisma.crmCustomerProfile.findMany({
      where: { ...baseWhere, namePinyin: spokenPinyin },
      take: 50,
      orderBy: { updatedAt: "desc" },
      select: baseGatherSelect(),
    })
    : [];

  // 2. name / alias contains（take 50，限量保护性能）。
  const containsProfiles = normalizedSpoken
    ? await prisma.crmCustomerProfile.findMany({
      where: {
        ...baseWhere,
        OR: [
          { name: { contains: normalizedSpoken } },
          { nameAliases: { some: { alias: { contains: normalizedSpoken } } } },
        ],
      },
      take: 50,
      orderBy: { updatedAt: "desc" },
      select: baseGatherSelect(),
    })
    : [];

  // 合并去重（namePinyin 精确 + contains）。
  const seen = new Set<string>();
  const merged: RawProfile[] = [];
  for (const p of [...pinyinExact, ...containsProfiles]) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    merged.push(p);
  }

  // 3. best-effort 拼音首字母 fallback（全量库无索引无法做精确首字母匹配；此处仅做
  //    最近 500 条内存 pinyin-match 兜底）。注释明确：这是兜底路径，namePinyin 精确
  //    路径已不依赖时间窗口，冷客户不会因「不在最近 500 条」而漏召回（只要 namePinyin
  //    已回填）。
  const fallbackProfiles = await prisma.crmCustomerProfile.findMany({
    where: baseWhere,
    take: 500,
    orderBy: { updatedAt: "desc" },
    select: { ...baseGatherSelect(), name: true },
  });
  for (const p of fallbackProfiles) {
    if (seen.has(p.id)) continue;
    if (matchesSpoken(p, normalizedSpoken, spokenPinyin)) {
      merged.push(p);
      seen.add(p.id);
    }
  }

  return toGatheredCandidates(merged);
}

/**
 * Set scope（REP/RM）召回：分块（每批 500 id）SQL 预筛 namePinyin 精确 / name contains /
 * alias contains；预筛为空时再分块拉全 scope 做内存 pinyin-match 补召回（覆盖拼音首字母输入）。
 */
async function gatherForSetScope(
  scopeIdList: string[],
  normalizedSpoken: string,
  spokenPinyin: string,
): Promise<GatheredCandidate[]> {
  const CHUNK = 500; // 远低于 SQLite ~999 参数上限，留余量给 OR 条件参数。

  // SQL 预筛：namePinyin == spokenPinyin OR name contains OR alias contains。
  // namePinyin 精确走索引；name/alias contains 走全表 scan 但 scope 已限定。
  const preFilterOR: Prisma.CrmCustomerProfileWhereInput[] = [];
  if (spokenPinyin) preFilterOR.push({ namePinyin: spokenPinyin });
  if (normalizedSpoken) {
    preFilterOR.push(
      { name: { contains: normalizedSpoken } },
      { nameAliases: { some: { alias: { contains: normalizedSpoken } } } },
    );
  }

  let profiles: RawProfile[] = [];
  if (preFilterOR.length > 0) {
    profiles = await collectByChunks(scopeIdList, (chunk) =>
      prisma.crmCustomerProfile.findMany({
        where: {
          archived: false,
          deleted: false,
          id: { in: chunk },
          OR: preFilterOR,
        },
        take: 100,
        orderBy: { updatedAt: "desc" },
        select: baseGatherSelect(),
      }),
    );
  }

  // 预筛为空 → 拉全 scope 做内存 pinyin-match 补召回（覆盖拼音首字母输入场景）。
  if (profiles.length === 0) {
    const all = await collectByChunks(scopeIdList, (chunk) =>
      prisma.crmCustomerProfile.findMany({
        where: { archived: false, deleted: false, id: { in: chunk } },
        select: { ...baseGatherSelect(), name: true },
      }),
    );
    for (const p of all) {
      if (matchesSpoken(p, normalizedSpoken, spokenPinyin)) profiles.push(p);
    }
  }

  return toGatheredCandidates(profiles);
}

/**
 * 内存补召回判定：判断一个候选是否应该被加入候选池。
 *
 * 三个信号（OR 关系）：
 *  1. pinyin-match 命中：覆盖拼音/首字母输入（如 "zsy" → 张三阳）。
 *  2. 去声调全拼完全相等：覆盖汉字同音错字（如 "王小明" → 王晓明）。
 *     pinyin-match 不做汉字间同音比较（实测 `PinyinMatch.match("王晓明","王小明")===false`），
 *     因此同音错字必须靠 pinyin-pro 的 toPinyinToneless 比对，否则候选进不了评分阶段。
 *  3. 活动 alias 上的上述两个信号。
 */
function matchesSpoken(
  profile: RawProfile,
  normalizedSpoken: string,
  spokenPinyin: string,
): boolean {
  const name = profile.name ?? "";
  if (name) {
    if (PinyinMatch.match(name, normalizedSpoken) !== false) return true;
    if (spokenPinyin) {
      const namePinyin = toPinyinToneless(name);
      if (namePinyin && namePinyin === spokenPinyin) return true;
    }
  }
  return profile.nameAliases.some((a) => {
    if (!a.active || !a.alias) return false;
    if (PinyinMatch.match(a.alias, normalizedSpoken) !== false) return true;
    if (spokenPinyin) {
      const aliasPinyin = toPinyinToneless(a.alias);
      if (aliasPinyin && aliasPinyin === spokenPinyin) return true;
    }
    return false;
  });
}

function baseGatherSelect() {
  return {
    id: true,
    name: true,
    namePinyin: true,
    organization: true,
    principal: true,
    lastFollowUpAt: true,
    ownerUser: { select: { name: true } },
    nameAliases: {
      where: { active: true },
      select: { alias: true, aliasType: true, active: true },
    },
  } as const;
}

interface RawProfile {
  id: string;
  name: string | null;
  namePinyin: string | null;
  organization: string | null;
  principal: string | null;
  lastFollowUpAt: Date | null;
  ownerUser: { name: string } | null;
  nameAliases: Array<{ alias: string; aliasType: string; active: boolean }>;
}

function toGatheredCandidates(profiles: RawProfile[]): GatheredCandidate[] {
  return profiles.map((p) => ({
    profileId: p.id,
    name: p.name ?? "",
    namePinyin: p.namePinyin ?? null,
    organization: p.organization ?? null,
    ownerName: p.ownerUser?.name ?? null,
    principal: p.principal ?? null,
    lastInteractionAt: p.lastFollowUpAt,
    aliases: p.nameAliases,
  }));
}

// ── 纯函数层（不碰 DB，可 smoke 测试） ───────────────────────────────────────

/**
 * 归一化用于比较的字符串：NFKC + trim + lower + 去空白。
 * 与 customer-name-alias 的 normalizeCustomerNameAlias 口径保持一致。
 */
export function normalizeForCompare(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

/** Levenshtein 编辑距离（单字节 unicode code point；按拼音 ASCII 串比对足够）。 */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const prev = new Array<number>(n + 1);
  const curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j];
  }
  return prev[n];
}

/**
 * 给候选打分并给出决策。
 *
 * @param spokenName 语音转写姓名（原文）
 * @param candidates 数据层召回的候选（必须在 scope 内）
 * @param hints 可选机构/负责人线索
 * @param options.limit 仅截断返回展示的候选数，默认 5，clamp 1-10。
 *   **不影响 resolution 结论**：唯一性判断始终基于完整候选的前两名，避免 limit=1
 *   把第二名截掉后误判 UNIQUE（见 AGENTS review P1#1：周舟/周州 limit=1 场景）。
 */
export function scoreAndResolve(
  spokenName: string,
  candidates: GatheredCandidate[],
  hints: NameResolutionHints = {},
  options: { limit?: number } = {},
): NameResolutionOutput {
  const normalizedSpoken = normalizeForCompare(spokenName);
  const spokenPinyin = toPinyinToneless(normalizedSpoken);
  const orgHint = hints.organizationHint ? normalizeForCompare(hints.organizationHint) : "";
  const principalHint = hints.principalHint ? normalizeForCompare(hints.principalHint) : "";
  const now = Date.now();

  const scored: NameResolutionCandidate[] = candidates.map((c) => {
    const reasons: string[] = [];
    let score = 0;
    // tieBreaker 只用于排序（hint/最近互动），不参与 score 的 clamp 与决策阈值，
    // 避免姓名精确命中（100）的候选被压回 100 而无法打破同名平局。
    let tieBreaker = 0;

    const candidateNameNorm = normalizeForCompare(c.name);
    // 优先用 DB 已持久化的 namePinyin（避免重复 pinyin-pro 计算）；回退到内存计算。
    const candidateNamePinyin = c.namePinyin ?? toPinyinToneless(candidateNameNorm);

    // a. 姓名精确相等（归一化后）。
    if (candidateNameNorm && candidateNameNorm === normalizedSpoken) {
      score = Math.max(score, SCORE.NAME_EXACT);
      reasons.push("姓名完全匹配");
    } else if (candidateNameNorm && (candidateNameNorm.includes(normalizedSpoken) || normalizedSpoken.includes(candidateNameNorm))) {
      // b. 姓名包含/被包含。
      score = Math.max(score, SCORE.NAME_CONTAINS);
      reasons.push("姓名包含匹配");
    }

    // c. 活动 alias 精确/包含。
    for (const a of c.aliases) {
      if (!a.active) continue;
      const aliasNorm = normalizeForCompare(a.alias);
      if (!aliasNorm) continue;
      if (aliasNorm === normalizedSpoken) {
        score = Math.max(score, SCORE.ALIAS_EXACT);
        reasons.push(`别名匹配：${a.alias}`);
        break;
      }
      if (aliasNorm.includes(normalizedSpoken) || normalizedSpoken.includes(aliasNorm)) {
        score = Math.max(score, SCORE.ALIAS_CONTAINS);
        reasons.push(`别名包含：${a.alias}`);
        break;
      }
    }

    // d. 去声调全拼完全相等（同音错字核心："王小明" vs "王晓明"）。
    if (candidateNamePinyin && spokenPinyin && candidateNamePinyin === spokenPinyin && candidateNameNorm !== normalizedSpoken) {
      score = Math.max(score, SCORE.PINYIN_EXACT);
      reasons.push("发音相同（同音错字）");
    }

    // e. 拼音编辑距离 ≤1（按拼音串比对）。
    if (candidateNamePinyin && spokenPinyin) {
      const dist = editDistance(candidateNamePinyin, spokenPinyin);
      if (dist > 0 && dist <= 1) {
        score = Math.max(score, SCORE.PINYIN_EDIT_DIST_1);
        reasons.push("发音相近");
      }
    }

    // f. pinyin-match 命中（用户输入本来就是拼音/首字母，文本输入场景）。
    if (c.name && PinyinMatch.match(c.name, normalizedSpoken) !== false) {
      // 仅当尚未因拼音精确/编辑距离拿到更高分时计这一档。
      if (score < SCORE.PINYIN_MATCH) {
        score = Math.max(score, SCORE.PINYIN_MATCH);
        reasons.push("拼音/首字母命中");
      }
    }

    // g. hints 排序信号（独立于姓名命中，累加到 tieBreaker 而非 score）。
    if (orgHint && c.organization) {
      const orgNorm = normalizeForCompare(c.organization);
      if (orgNorm.includes(orgHint) || orgHint.includes(orgNorm)) {
        tieBreaker += SCORE.ORG_HINT;
        reasons.push("机构线索命中");
      }
    }
    if (principalHint && c.principal) {
      const principalNorm = normalizeForCompare(c.principal);
      if (principalNorm.includes(principalHint) || principalHint.includes(principalNorm)) {
        tieBreaker += SCORE.PRINCIPAL_HINT;
        reasons.push("负责人线索命中");
      }
    }

    // h. 最近互动（微弱排序信号，累加到 tieBreaker）。
    if (c.lastInteractionAt) {
      if (now - c.lastInteractionAt.getTime() <= RECENT_INTERACTION_MS) {
        tieBreaker += SCORE.RECENT_INTERACTION;
      }
    }

    // clamp 到 0-100（仅基础匹配分）。
    score = Math.max(0, Math.min(100, score));

    return {
      profileId: c.profileId,
      name: c.name || "未命名客户",
      organization: c.organization,
      ownerName: c.ownerName,
      score,
      reasons,
      tieBreaker,
    };
  });

  // 丢掉 0 分候选（无任何命中），按分数降序稳定排序。
  // 排序：先 score（降序），score 相等再 tieBreaker（降序），最后 profileId（升序）
  // 做稳定尾锚——保证同名同分同 hint 的候选顺序确定（不依赖 DB 原序）。
  const filtered = scored.filter((c) => c.score > 0);
  filtered.sort((a, b) =>
    b.score - a.score
    || (b.tieBreaker ?? 0) - (a.tieBreaker ?? 0)
    || (a.profileId < b.profileId ? -1 : a.profileId > b.profileId ? 1 : 0),
  );

  // 决策（基于完整 filtered，**不**先按 limit 截断）。
  // 语音同音歧义感知：当第二名候选已达到 PINYIN_EXACT（同音错字核心档）时，
  // 说明 ASR 可能输出其中任一姓名，此时用更大的 margin（+5）防止把同音候选
  // 误唯一化。例如「周舟」转写 vs 周舟（精确100）+ 周州（同音88）：差值 12
  // 达不到 88+5 所需的更大领先，判 AMBIGUOUS 让用户点选。
  //
  // ⚠️ 唯一性必须基于完整候选前两名判断，不能在截断后的列表上判断——否则
  // limit=1 时第二名候选被截掉，两个同音客户（周舟/周州）会被错误判为 UNIQUE。
  // limit 只用于截断返回展示的候选，见 docstring。
  let resolution: NameResolutionResult = "NO_MATCH";
  if (filtered.length === 0) {
    resolution = "NO_MATCH";
  } else {
    const top = filtered[0];
    const second = filtered[1];
    const effectiveMargin = second && second.score >= SCORE.PINYIN_EXACT
      ? UNIQUE_MARGIN + 5
      : UNIQUE_MARGIN;
    if (top.score >= UNIQUE_MIN_SCORE && (!second || top.score - second.score >= effectiveMargin)) {
      resolution = "UNIQUE";
    } else {
      resolution = "AMBIGUOUS";
    }
  }

  // 截断只影响返回的 candidates 展示，不影响 resolution 结论。
  const limit = clampLimit(options.limit ?? 5, 1, 10);
  const truncated = filtered.slice(0, limit);

  return {
    normalizedSpokenName: normalizedSpoken,
    candidates: truncated,
    resolution,
  };
}

function clampLimit(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

/**
 * 热客户加载层（docs §5）。
 *
 * 设计要点（docs §2 / §5）：
 *  - 热客户列表只是 prompt 上下文，**不是权限边界**。工具执行前后仍由
 *    `validateCustomerTarget` + `getEffectiveCrmVisibleProfileIds` 重新校验权限。
 *  - 模型只能引用列表中的 profileId，不得自行创造；列表未命中再调拼音/解析工具。
 *  - 不输出手机号、邮箱、地址等敏感或长文本字段，控制 prompt token 体积。
 *
 * Scope-first 硬约束（与 permissions.ts 保持一致）：
 *  - REP/RM：通过 `getEffectiveCrmVisibleProfileIds` 拿到 Set，空集 → []，分块（500/批）
 *    拉全 scope 内存排序后取前 limit。
 *  - ADMIN（scope=null）：只取最近活跃候选池（updatedAt 倒序最近 200 条），禁止全库塞 prompt。
 *  - 无权限角色（如 USER）：返回 []（设计 §5.2）。
 */

import { prisma } from "@/lib/prisma";
import { getEffectiveCrmVisibleProfileIds } from "@/lib/crm/permissions";
import { toPinyinToneless } from "@/lib/crm/pinyin";

// ── 类型（docs §5.1） ───────────────────────────────────────────────────────

export interface HotCustomerEntry {
  profileId: string;
  name: string;
  namePinyin: string;
  organization: string | null;
  principal: string | null;
  stage: string;
  importance: string;
  /** ISO 字符串；null 表示无记录。 */
  lastFollowUpAt: string | null;
  /** ISO 字符串；null 表示无计划。 */
  nextFollowUpAt: string | null;
}

// ── 常量 ─────────────────────────────────────────────────────────────────

/** 默认 limit（docs §5.3）。 */
const DEFAULT_LIMIT = 30;
/** limit 上界（docs §5.3）。 */
const MAX_LIMIT = 50;
/** scope 分块大小，规避 SQLite 参数上限（与 permissions.ts 同口径，留余量）。 */
const SCOPE_CHUNK_SIZE = 500;
/** ADMIN 候选池大小：只取最近活跃 Top-N，避免全库塞 prompt（docs §5.2）。 */
const ADMIN_CANDIDATE_POOL = 200;
/** 最近互动优先窗口（docs §5.3 #3：30 天内有互动更靠前）。 */
const RECENT_INTERACTION_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

// ── 排序优先级映射（docs §5.3 #1 / #2） ────────────────────────────────────

const STAGE_PRIORITY: Record<string, number> = {
  ACTIVE: 0,
  FOLLOWING: 1,
  CONTACTED: 2,
  LEAD: 3,
  // 其余（BLOCKED / LOST / DORMANT / NEW / 未知）=4
};

const IMPORTANCE_PRIORITY: Record<string, number> = {
  KEY: 0,
  HIGH: 1,
  NORMAL: 2,
  LOW: 3,
  // 未知 =4
};

function stagePriority(stage: string): number {
  return STAGE_PRIORITY[stage] ?? 4;
}

function importancePriority(importance: string): number {
  return IMPORTANCE_PRIORITY[importance] ?? 4;
}

/**
 * 比较两条候选的排序序（docs §5.3）。完全确定性：全相等时以 profileId 字典序尾锚。
 *
 * 返回负数表示 a 排前。
 *
 * 排序键（从前到后）：
 *  1. 阶段优先级（ACTIVE=0 … 其余=4）；
 *  2. 重要性（KEY=0 … LOW=3 / 未知=4）；
 *  3. 最近 30 天内有互动的优先；组内按 lastFollowUpAt 新→旧（null 最后）；
 *  4. nextFollowUpAt 逾期的优先（nextFollowUpAt < now 且非 null）；
 *  5. nextFollowUpAt 即将到期的早→晚（null 最后）；
 *  6. profileId 字典序尾锚（确定性）。
 */
export function compareHotCustomers(
  a: HotCustomerEntry,
  b: HotCustomerEntry,
  now: number = Date.now(),
): number {
  // 1. 阶段
  {
    const pa = stagePriority(a.stage);
    const pb = stagePriority(b.stage);
    if (pa !== pb) return pa - pb;
  }
  // 2. 重要性
  {
    const pa = importancePriority(a.importance);
    const pb = importancePriority(b.importance);
    if (pa !== pb) return pa - pb;
  }
  // 3. 最近互动：30 天内有互动的优先；组内 lastFollowUpAt 新→旧；null 最后。
  {
    const ta = parseTs(a.lastFollowUpAt);
    const tb = parseTs(b.lastFollowUpAt);
    const aRecent = ta !== null && now - ta <= RECENT_INTERACTION_WINDOW_MS;
    const bRecent = tb !== null && now - tb <= RECENT_INTERACTION_WINDOW_MS;
    if (aRecent !== bRecent) return aRecent ? -1 : 1;
    if (ta !== tb) {
      // 新→旧：大的在前。null 视为 -1（最旧）。
      const aa = ta ?? -1;
      const bb = tb ?? -1;
      if (aa !== bb) return bb - aa;
    }
  }
  // 4. nextFollowUpAt 逾期的优先（< now 且非 null）。
  {
    const ta = parseTs(a.nextFollowUpAt);
    const tb = parseTs(b.nextFollowUpAt);
    const aOverdue = ta !== null && ta < now;
    const bOverdue = tb !== null && tb < now;
    if (aOverdue !== bOverdue) return aOverdue ? -1 : 1;

    // 5. 即将到期的早→晚；null 最后。
    if (ta !== tb) {
      const aa = ta ?? Number.POSITIVE_INFINITY;
      const bb = tb ?? Number.POSITIVE_INFINITY;
      if (aa !== bb) return aa - bb;
    }
  }
  // 6. profileId 字典序尾锚（稳定性）。
  if (a.profileId < b.profileId) return -1;
  if (a.profileId > b.profileId) return 1;
  return 0;
}

function parseTs(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

function clampLimit(raw: number | undefined): number {
  if (!Number.isFinite(raw as number)) return DEFAULT_LIMIT;
  const n = Math.floor(raw as number);
  if (n < 1) return 1;
  if (n > MAX_LIMIT) return MAX_LIMIT;
  return n;
}

/** 判断角色是否有资格加载热客户（docs §5.2：仅销售相关角色 + ADMIN）。 */
function isHotCustomerEligibleRole(role: string): boolean {
  return (
    role === "ADMIN" ||
    role === "REPRESENTATIVE" ||
    role === "REGIONAL_MANAGER"
  );
}

// ── Prisma select 公共子集（仅取 prompt 安全字段） ─────────────────────────

type ProfileRow = {
  id: string;
  name: string | null;
  namePinyin: string | null;
  organization: string | null;
  principal: string | null;
  stage: string;
  importance: string;
  lastFollowUpAt: Date | null;
  nextFollowUpAt: Date | null;
  updatedAt: Date;
};

const PROFILE_SELECT = {
  id: true,
  name: true,
  namePinyin: true,
  organization: true,
  principal: true,
  stage: true,
  importance: true,
  lastFollowUpAt: true,
  nextFollowUpAt: true,
  updatedAt: true,
} as const;

function toEntry(row: ProfileRow): HotCustomerEntry {
  const name = row.name ?? "未命名客户";
  return {
    profileId: row.id,
    name,
    // DB 值优先；null/空 回退 toPinyinToneless(name)。
    namePinyin: row.namePinyin || toPinyinToneless(name),
    organization: row.organization ?? null,
    principal: row.principal ?? null,
    stage: row.stage,
    importance: row.importance,
    lastFollowUpAt: row.lastFollowUpAt ? row.lastFollowUpAt.toISOString() : null,
    nextFollowUpAt: row.nextFollowUpAt ? row.nextFollowUpAt.toISOString() : null,
  };
}

// ── 入口 ─────────────────────────────────────────────────────────────────

/**
 * 列出当前 actor 可见的「热客户」候选（docs §5）。
 *
 * - limit 默认 30，clamp 到 1..50；
 * - 非销售/管理角色（如 USER）→ []；
 * - REP/RM：scope 内全量拉取后内存排序；ADMIN：仅最近活跃候选池；
 * - 排序完全确定（见 compareHotCustomers），尾锚 profileId。
 *
 * 不抛异常：scope 解析失败时降级为 []，由调用方决定如何处理。
 */
export async function listHotCustomersForActor(
  actor: { userId: string; role: string },
  opts: { limit?: number } = {},
): Promise<HotCustomerEntry[]> {
  const limit = clampLimit(opts.limit);

  // 角色门控：非销售/管理角色不开放 Agent 热客户（docs §5.2）。
  if (!isHotCustomerEligibleRole(actor.role)) {
    return [];
  }

  const scopeIds = await getEffectiveCrmVisibleProfileIds(actor.userId, actor.role);

  // REP/RM 的 Set：空集 → []。
  if (scopeIds !== null) {
    if (scopeIds.size === 0) return [];
    const ids = [...scopeIds];
    const rows: ProfileRow[] = [];
    for (let i = 0; i < ids.length; i += SCOPE_CHUNK_SIZE) {
      const chunk = ids.slice(i, i + SCOPE_CHUNK_SIZE);
      const part = await prisma.crmCustomerProfile.findMany({
        where: {
          id: { in: chunk },
          archived: false,
          deleted: false,
        },
        select: PROFILE_SELECT,
      });
      for (const r of part) rows.push(r);
    }
    const entries = rows.map(toEntry);
    entries.sort((a, b) => compareHotCustomers(a, b));
    return entries.slice(0, limit);
  }

  // ADMIN（scope === null）：只取最近活跃候选池（docs §5.2：避免全库塞 prompt）。
  // 用 updatedAt 倒序拉 ADMIN_CANDIDATE_POOL 条作为候选池，再按统一 comparator 排序。
  const pool = await prisma.crmCustomerProfile.findMany({
    where: { archived: false, deleted: false },
    orderBy: { updatedAt: "desc" },
    take: ADMIN_CANDIDATE_POOL,
    select: PROFILE_SELECT,
  });
  const entries = pool.map(toEntry);
  entries.sort((a, b) => compareHotCustomers(a, b));
  return entries.slice(0, limit);
}

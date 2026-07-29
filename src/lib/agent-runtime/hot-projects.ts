/**
 * 梦境记忆 D1 · 热项目加载层。
 *
 * 设计要点（与 src/lib/crm/hot-customers.ts 同口径）：
 *  - 热项目列表只是 prompt 上下文，**不是权限边界**。工具执行前后仍由
 *    permissions.ts 重新校验（getReadableProjectIds / canReadProject）。
 *  - 不输出敏感或长文本字段，控制 prompt token 体积。
 *
 * Scope-first 硬约束（与 permissions.ts 保持一致）：
 *  - 非 ADMIN：通过 `getReadableProjectIds` 拿到候选 id 数组；空数组 → []；500/批分块拉取。
 *  - ADMIN（scope=null）：只取最近活跃候选池（updatedAt 倒序 200 条），禁止全库塞 prompt。
 *  - 无项目可读角色（如 USER 且无 ProjectMember 关系）自然被 getReadableProjectIds 处理为空集 → []。
 *
 * lastActivityAt 计算：取以下来源的 max，全部用 groupBy 批量查（禁止 N+1）：
 *  - ActivityLog.createdAt（限最近 30 天，避免历史噪音主导热项目判定）
 *  - Ticket.updatedAt（T4：待 ticket query service 迁移）
 *  - OrderProjectLink.updatedAt
 *  - Project.updatedAt（本身在主 select 中已取）
 */


import { maxOrderProjectLinkUpdatedAtByProjectIds } from "@/lib/orders/application/order-project-link-activity";
import {
  listHotProjectCandidatesForActor,
  type HotProjectCandidateRow,
} from "@/lib/projects/application/query-hot-project-candidates";
import { maxActivityLogUpdatedAtByProjectIds } from "@/lib/projects/application/project-activity";
import { maxTicketUpdatedAtByProjectIds } from "@/lib/tickets/application/ticket-activity";

// ── 类型 ───────────────────────────────────────────────────────────────────

export interface HotProjectEntry {
  projectId: string;
  name: string;
  projectNo: string | null;
  status: string;
  representative: string | null;
  customerName: string | null;
  organization: string | null;
  /** ISO 字符串；null 表示无活动记录（回退到 Project.updatedAt）。 */
  lastActivityAt: string | null;
}

// ── 常量 ───────────────────────────────────────────────────────────────────

/** 默认 limit。 */
const DEFAULT_LIMIT = 20;
/** limit 上界。 */
const MAX_LIMIT = 30;
/** ActivityLog 活动窗口：仅统计最近 30 天，避免历史噪音主导热项目判定。 */
const ACTIVITY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

// ── 排序 ───────────────────────────────────────────────────────────────────

/** IN_PROGRESS 排前（=0），NOT_STARTED 次之（=1），其余（理论不会出现）=2。 */
function statusPriority(status: string): number {
  if (status === "IN_PROGRESS") return 0;
  if (status === "NOT_STARTED") return 1;
  return 2;
}

function parseTs(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/**
 * 比较两条候选的排序序（完全确定性）。返回负数表示 a 排前。
 *
 * 排序键（从前到后）：
 *  1. status 优先级（IN_PROGRESS=0, NOT_STARTED=1）；
 *  2. lastActivityAt 新→旧（null 最后）；
 *  3. projectId 字典序尾锚（确定性）。
 */
export function compareHotProjects(a: HotProjectEntry, b: HotProjectEntry): number {
  const pa = statusPriority(a.status);
  const pb = statusPriority(b.status);
  if (pa !== pb) return pa - pb;

  const ta = parseTs(a.lastActivityAt);
  const tb = parseTs(b.lastActivityAt);
  const aa = ta ?? -1; // null 视为最旧
  const bb = tb ?? -1;
  if (aa !== bb) return bb - aa; // 新→旧

  if (a.projectId < b.projectId) return -1;
  if (a.projectId > b.projectId) return 1;
  return 0;
}

function clampLimit(raw: number | undefined): number {
  if (!Number.isFinite(raw as number)) return DEFAULT_LIMIT;
  const n = Math.floor(raw as number);
  if (n < 1) return 1;
  if (n > MAX_LIMIT) return MAX_LIMIT;
  return n;
}

function toEntry(
  row: HotProjectCandidateRow,
  activityMap: Map<string, Date>,
): HotProjectEntry {
  // 取 max(批量活动信号, project.updatedAt)。
  const updatedAt = row.updatedAt;
  const fromMap = activityMap.get(row.id);
  const last = fromMap && fromMap > updatedAt ? fromMap : updatedAt;
  return {
    projectId: row.id,
    name: row.name,
    projectNo: row.projectNo ?? null,
    status: row.status,
    representative: row.representative ?? null,
    customerName: row.profile?.name ?? null,
    organization: row.profile?.organization ?? null,
    lastActivityAt: last ? last.toISOString() : null,
  };
}

// ── 活动信号批量聚合（groupBy，禁止 N+1） ─────────────────────────────────

/**
 * 给定一批 projectId，返回每个项目最近一次活动的 max 时间戳。
 * 来源：ActivityLog（近 30 天）+ Ticket.updatedAt + OrderProjectLink.updatedAt。
 * 不含 Project.updatedAt（由调用方在 toEntry 中合并）。
 */
async function batchLastActivity(projectIds: string[]): Promise<Map<string, Date>> {
  const map = new Map<string, Date>();
  if (projectIds.length === 0) return map;

  const since = new Date(Date.now() - ACTIVITY_WINDOW_MS);

  const [activityMax, ticketMax, orderLinkMax] = await Promise.all([
    maxActivityLogUpdatedAtByProjectIds(projectIds, since),
    maxTicketUpdatedAtByProjectIds(projectIds),
    maxOrderProjectLinkUpdatedAtByProjectIds(projectIds),
  ]);

  const bump = (projectId: string | null, d: Date | null | undefined) => {
    if (!projectId || !d) return;
    const prev = map.get(projectId);
    if (!prev || d > prev) map.set(projectId, d);
  };
  for (const [projectId, d] of activityMax) bump(projectId, d);
  for (const [projectId, d] of ticketMax) bump(projectId, d);
  for (const [projectId, d] of orderLinkMax) bump(projectId, d);

  return map;
}

// ── 入口 ───────────────────────────────────────────────────────────────────

/**
 * 列出当前 actor 可见的「热项目」候选。
 *
 * - limit 默认 20，clamp 到 1..30；
 * - scope：getReadableProjectIds；null（ADMIN）→ updatedAt 倒序候选池 200；
 *   数组 → 500 分块；空数组 → []；
 * - where：status ∈ {NOT_STARTED, IN_PROGRESS}，archived:false，deleted:false；
 * - 排序完全确定（见 compareHotProjects），尾锚 projectId。
 *
 * 不抛异常：scope 解析失败时降级为 []。
 */
export async function listHotProjectsForActor(
  actor: { userId: string; role: string },
  opts: { limit?: number } = {},
): Promise<HotProjectEntry[]> {
  const limit = clampLimit(opts.limit);

  try {
    const rows = await listHotProjectCandidatesForActor(actor);
    const activityMap = await batchLastActivity(rows.map((r) => r.id));
    const entries = rows.map((r) => toEntry(r, activityMap));
    entries.sort((a, b) => compareHotProjects(a, b));
    return entries.slice(0, limit);
  } catch {
    return [];
  }
}

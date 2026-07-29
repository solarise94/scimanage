/**
 * 订单列表/统计的日期区间解析（服务端共享）。
 *
 * 接受 "YYYY-MM-DD"（按服务端本地时区构造当日边界）或完整 ISO 串。
 * - from → 当日 00:00:00.000（含端点）
 * - to   → 当日 23:59:59.999（含端点，避免"本月"漏掉当天晚上的订单）
 *
 * 与 stats route 的 monthStart 口径一致：均用本地时区构造（orderedAt 落库口径）。
 * 返回 { gte?, lte? }，两端可缺省；都缺省时返回 null（调用方据此跳过 push）。
 */

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function parseStart(s: string): Date | null {
  const t = s.trim();
  if (!t) return null;
  if (DATE_ONLY.test(t)) {
    const [y, m, d] = t.split("-").map(Number);
    return new Date(y, m - 1, d, 0, 0, 0, 0);
  }
  // 非 "YYYY-MM-DD" 的完整 ISO 串：交给 new Date(t)。
  // 注意：带时区偏移的串按其偏移解析；裸 "YYYY-MM-DDTHH:mm:ss"（无 Z/偏移）按宿主本地时区解析，
  // 故跨时区宿主结果可能不同。当前调用方（前端 fmtYmd）只产出 DATE_ONLY，不触发此分支。
  const dt = new Date(t);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function parseEnd(s: string): Date | null {
  const t = s.trim();
  if (!t) return null;
  if (DATE_ONLY.test(t)) {
    const [y, m, d] = t.split("-").map(Number);
    return new Date(y, m - 1, d, 23, 59, 59, 999);
  }
  // 同 parseStart：完整 ISO 串走 new Date(t)，裸 datetime 串的时区行为依赖宿主。
  const dt = new Date(t);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

export function parseDateRange(
  from?: string | null,
  to?: string | null,
): { gte?: Date; lte?: Date } | null {
  const range: { gte?: Date; lte?: Date } = {};
  if (from) {
    const d = parseStart(from);
    if (d) range.gte = d;
  }
  if (to) {
    const d = parseEnd(to);
    if (d) range.lte = d;
  }
  if (range.gte === undefined && range.lte === undefined) return null;
  return range;
}

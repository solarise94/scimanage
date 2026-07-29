/**
 * 财务回款 receivedAt 后端解析工具。
 *
 * 系统约定：
 * - receivedAt 是“业务自然日”，不是精确时间戳。
 * - 前端传输格式固定为 YYYY-MM-DD。
 * - 后端按自然日（UTC 00:00:00）落库，并按自然日范围过滤。
 *
 * 这类日期不要直接用 new Date(receivedAt) 或 toISOString() 推导，
 * 统一走这里的 helper，避免时区导致早/晚一天。
 */

import { isDateInputString, getTodayLocalDateInput } from "./date-input";

/**
 * 把前端传来的 YYYY-MM-DD 解析为 UTC 当天的 00:00:00。
 * 空值时默认取今天本地自然日。
 */
export function parseReceivedAtInput(value?: string | null): Date {
  const dateStr = value && value.trim() ? value.trim() : getTodayLocalDateInput();
  if (!isDateInputString(dateStr)) {
    throw new Error(`Invalid receivedAt: ${dateStr}`);
  }
  return new Date(`${dateStr}T00:00:00.000Z`);
}

/**
 * 构建按自然日过滤 receivedAt 的 Prisma 范围。
 * dateFrom/dateTo 均为 YYYY-MM-DD，闭区间。
 */
export function buildReceivedAtDayRange(
  dateFrom?: string | null,
  dateTo?: string | null,
): { gte?: Date; lte?: Date } {
  const range: { gte?: Date; lte?: Date } = {};

  if (dateFrom && dateFrom.trim()) {
    const from = dateFrom.trim();
    if (!isDateInputString(from)) {
      throw new Error(`Invalid dateFrom: ${from}`);
    }
    range.gte = new Date(`${from}T00:00:00.000Z`);
  }

  if (dateTo && dateTo.trim()) {
    const to = dateTo.trim();
    if (!isDateInputString(to)) {
      throw new Error(`Invalid dateTo: ${to}`);
    }
    range.lte = new Date(`${to}T23:59:59.999Z`);
  }

  return range;
}

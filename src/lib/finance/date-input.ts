/**
 * 财务回款日期输入统一工具。
 *
 * 系统约定：
 * - receivedAt 是“业务自然日”，不是精确时间戳。
 * - 前端传输格式固定为 YYYY-MM-DD。
 * - 默认值按用户本地自然日生成。
 *
 * 注意：这里不要和通用时间工具混在一起；只处理“日期输入值”这一件事。
 */

/**
 * 把本地 Date 稳定输出为 YYYY-MM-DD，避免 toISOString() 在时区下早一天。
 */
export function formatLocalDateInput(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * 所有 date input 默认值统一走这里。
 */
export function getTodayLocalDateInput(): string {
  return formatLocalDateInput(new Date());
}

/**
 * 校验是否是标准 YYYY-MM-DD 格式。
 */
export function isDateInputString(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/**
 * 把 YYYY-MM-DD 转回本地 Date（时刻为 00:00:00）。
 * 需要回显或比较时再用；写库建议走后端 receipt-date 的解析 helper。
 */
export function parseDateInputToLocalDate(value: string): Date {
  const [y, m, d] = value.split("-").map(Number);
  return new Date(y, m - 1, d);
}

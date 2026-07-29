/**
 * 金额精度工具函数
 *
 * 分层口径（见 docs/finance-currency-precision-strategy-2026-06-18.md）：
 * - 财务口径：整数分（Int）+ 银行家舍入 + 分摊尾差吸收
 * - 看板口径：Float + roundForDisplay 收尾
 *
 * 财务口径字段迁移到 Int（分）后，存储和计算全程整数，彻底杜绝浮点误差。
 * 看板口径保持 Float（元），仅在聚合/比例计算后用 roundForDisplay 消除浮点尾巴。
 */

/**
 * 银行家舍入（ROUND_HALF_EVEN）：0.5 向最近偶数舍入。
 * 金融标准，大量计算时舍入误差趋于零。
 * JS Math.round 是 HALF_UP，不适用财务。
 *
 * 负数行为（IEEE 754 标准）：
 *   -631.5 → -632（向偶数舍入，-632 是偶数）
 *   -630.5 → -630（-630 是偶数）
 */
export function bankerRound(n: number): number {
  const floor = Math.floor(n);
  const frac = n - floor;
  if (frac < 0.5) return floor;
  if (frac > 0.5) return floor + 1;
  // frac === 0.5：向偶数
  // floor 是 ≤n 的最大整数；若 floor 为偶数则取 floor，否则 floor+1
  // 对负数：Math.floor(-631.5) = -632（偶数）→ 取 -632 ✓
  //         Math.floor(-630.5) = -631（奇数）→ 取 -630 ✓
  return floor % 2 === 0 ? floor : floor + 1;
}

/**
 * 元(浮点) → 分(整数)，用银行家舍入消除浮点尾巴。
 * 用于数据迁移和输入转换。
 *   "2167.2" → 216720
 *   "2167.1999998" → 216720
 */
export function yuanToCents(yuan: number): number {
  return bankerRound(yuan * 100);
}

/**
 * 分(整数) → 元(浮点)，用于显示和 API 输出。
 * 整数除法，无精度损失。
 *   216720 → 2167.2
 */
export function centsToYuan(cents: number): number {
  return cents / 100;
}

/**
 * 财务口径比例计算：amount * numerator / denominator，银行家舍入到分。
 * 用整数分子分母，不用小数字面量（如不用 0.3，用 ratioCents(x, 3, 10)）。
 *   ratioCents(10000, 3, 10) = bankerRound(10000 * 3 / 10) = 3000
 */
export function ratioCents(
  amountCents: number,
  numerator: number,
  denominator: number,
): number {
  return bankerRound((amountCents * numerator) / denominator);
}

/**
 * 看板口径：Float 计算结果 round 到分（2位小数），消除浮点尾巴。
 * 非银行家舍入（看板不需要），普通 round 即可。
 *   roundForDisplay(631.4999999) = 631.5
 *   roundForDisplay(421893.24999999994) = 421893.25
 */
export function roundForDisplay(yuan: number): number {
  return Math.round(yuan * 100) / 100;
}

/**
 * 将整数分格式化为 ¥X.XX 标签（无千分位，避免 ¥50,660 歧义）。
 * 财务口径整数分 -> 展示口径字符串，供 Agent 预览/模型文本与 UI 共用。
 */
export function formatCentsAsYuanLabel(cents: number): string {
  if (!Number.isFinite(cents)) return "¥0.00";
  return `¥${(cents / 100).toFixed(2)}`;
}

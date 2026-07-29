/**
 * `namePinyin` 字段的唯一真相源（docs/agent-customer-name-resolution-hotload-pinyin-design-2026-07-18.md §4.2）。
 *
 * 本模块导出的 `toPinyinToneless` 是 CrmCustomerProfile.namePinyin 字段的规范化函数。
 * 下列路径必须且只能使用本函数，以保证同一姓名在任何路径下生成完全相同的索引值：
 *   - 所有 Profile 写路径（create / update / merge / unmerge）；
 *   - 回填脚本（scripts/backfill-profile-name-pinyin.ts）；
 *   - 热客户加载器（hot-customers）；
 *   - 拼音搜索工具（crm.search_customers_by_pinyin）。
 *
 * 规范化规则（docs §4.1）：
 *   - 去声调；
 *   - 小写；
 *   - 去空白与分隔符；
 *   - 非汉字字符原样保留（pinyin-pro 默认行为）；
 *   - 输出稳定字符串，例如 "王晓明" → "wangxiaoming"；
 *   - 空输入（null / undefined / ""）返回 ""。
 */

import { pinyin } from "pinyin-pro";

/**
 * 把姓名（或任意字符串）转换为去声调的全拼字符串。
 *
 * 调用方约定：写入 `namePinyin` 字段时，若结果为空串应写 `null`（保持字段可空语义）。
 *
 * @param name 任意字符串，null/undefined 视为空串。
 * @returns 小写、去声调、去空白的全拼；空输入返回 ""。
 */
export function toPinyinToneless(name: string): string {
  if (!name) return "";
  return pinyin(name, { toneType: "none", type: "array" })
    .join("")
    .replace(/\s+/g, "")
    .toLowerCase();
}

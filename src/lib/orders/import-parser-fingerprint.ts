/**
 * 确定性导入 parser 表头指纹（§6.1 AUTO）。
 *
 * 不调用 LLM 分类，只根据表头列名的标准化结果选择 parser：
 *   1. 标准化 BOM、空白、大小写、全/半角标点；
 *   2. 若命中拼好鼠必需列集合及其固定别名 → PINGOODMICE；
 *   3. 否则若命中通用订单必需列（至少外部订单号 + 可解析金额或明细列）→ ORDER_GENERIC；
 *   4. 两者都命中或都不满足 → needsColumnMapping。
 *
 * 列别名常量与 parser 共享：复用 external-order.ts 的 ORDER_HEADER_MAP，
 * 避免识别层与解析层漂移（§6.1 第 5 条）。
 */
import { ORDER_HEADER_MAP } from "@/lib/external-order";

/** 拼好鼠导出固定必需列（中文别名集合，来自 ORDER_HEADER_MAP 中拼好鼠常见列）。 */
const PINGOODMICE_REQUIRED_FIELDS = new Set<string>([
  "externalOrderNo",
  "receiverName",
  "paidAmount",
]);

/** 通用订单最小必需：外部订单号 + （金额或明细列其一）。 */
const ORDER_GENERIC_REQUIRED_FIELD = "externalOrderNo";
const ORDER_GENERIC_AMOUNT_FIELDS = new Set<string>([
  "grossAmount",
  "paidAmount",
  "priceAdjustment",
]);
const ORDER_GENERIC_ITEM_FIELDS = new Set<string>([
  "productNamesRaw",
  "itemCount",
]);

/**
 * 列映射 apply 阶段允许的目标字段白名单（NormalizedOrderRow 的可映射字段）。
 * 与 external-order.ts 的 NormalizedOrderRow 字段保持一致；禁止包含 rawJson/source。
 */
export const IMPORT_COLUMN_MAPPING_TARGETS: readonly string[] = Object.freeze(
  Object.entries(ORDER_HEADER_MAP)
    .map(([, field]) => field)
    .filter((field, index, arr) => field !== "source" && arr.indexOf(field) === index),
);

/** 标准化单个表头单元格：去 BOM、trim、全角→半角标点、统一大小写无关比较键。 */
function normalizeHeaderCell(raw: string): string {
  let v = raw;
  // 去 BOM
  if (v.charCodeAt(0) === 0xfeff) v = v.slice(1);
  v = v.trim();
  // 全角标点 → 半角（仅常见分隔/标点）
  v = v
    .replace(/\u3000/g, " ")
    .replace(/[，]/g, ",")
    .replace(/[：]/g, ":")
    .replace(/[（）]/g, (ch) => (ch === "（" ? "(" : ")"));
  return v;
}

/** 检测必需字段集合是否全部命中（基于 ORDER_HEADER_MAP 的中文别名）。 */
function fieldHits(normalizedHeaders: string[]): Set<string> {
  const hits = new Set<string>();
  for (const h of normalizedHeaders) {
    const field = ORDER_HEADER_MAP[h];
    if (field) hits.add(field);
  }
  return hits;
}

export type DetectImportParserResult =
  | { parserKey: "PINGOODMICE" }
  | { parserKey: "ORDER_GENERIC" }
  | { needsColumnMapping: true };

/**
 * 根据原始表头列数组，确定性选择 parser。
 * 输入为原始（未标准化）表头字符串数组；内部会做 BOM/空白/全角标点标准化。
 */
export function detectImportParser(headerColumns: string[]): DetectImportParserResult {
  const normalized = (headerColumns || []).map(normalizeHeaderCell).filter((h) => h.length > 0);
  if (normalized.length === 0) return { needsColumnMapping: true };

  const hits = fieldHits(normalized);

  const pingoodmiceOk = [...PINGOODMICE_REQUIRED_FIELDS].every((f) => hits.has(f));
  const hasExternalOrderNo = hits.has(ORDER_GENERIC_REQUIRED_FIELD);
  const hasAmount = [...ORDER_GENERIC_AMOUNT_FIELDS].some((f) => hits.has(f));
  const hasItem = [...ORDER_GENERIC_ITEM_FIELDS].some((f) => hits.has(f));
  const genericOk = hasExternalOrderNo && (hasAmount || hasItem);

  // §6.1 第 4 条：两者都命中或都不满足 → needsColumnMapping。
  if (pingoodmiceOk && genericOk) return { needsColumnMapping: true };
  if (!pingoodmiceOk && !genericOk) return { needsColumnMapping: true };
  if (pingoodmiceOk) return { parserKey: "PINGOODMICE" };
  return { parserKey: "ORDER_GENERIC" };
}

/**
 * 从原始文本首行提取表头列（CSV/TSV 自适应，与 parseOrderText 的 detectFormat 口径一致）。
 * 用于 needsColumnMapping 时返回 rawColumns + masked sampleRows。
 */
export function extractHeaderAndSampleRows(
  rawText: string,
  maxSamples = 3,
): { rawColumns: string[]; sampleRows: string[][] } {
  const firstLine = rawText.split(/\r?\n/)[0] || "";
  const isTsv = firstLine.includes("\t") && !firstLine.includes(",");
  const delimiter = isTsv ? "\t" : ",";
  const allLines = rawText.split(/\r?\n/).filter((l) => l.trim());
  if (allLines.length === 0) return { rawColumns: [], sampleRows: [] };

  const parseLine = (line: string) =>
    line.split(delimiter).map((c) => c.replace(/^"|"$/g, "").replace(/""/g, '"').trim());

  const rawColumns = parseLine(allLines[0]);
  const sampleRows = allLines.slice(1, 1 + Math.max(0, maxSamples)).map(parseLine);
  return { rawColumns, sampleRows };
}

/**
 * 脱敏样例行中的敏感字段（手机号、微信号/下单用户、地址、客户编号）。
 * 在 needsColumnMapping 输出前调用，避免把完整敏感文本注入模型上下文。
 */
export function maskSensitiveSampleRow(
  row: string[],
  columns: string[],
): string[] {
  const SENSITIVE_HEADER_HINTS = ["电话", "手机", "地址", "客户编号", "客户编码", "客户号", "客户ID", "openid", "微信"];
  const sensitiveIndexes = new Set<number>();
  columns.forEach((col, idx) => {
    if (SENSITIVE_HEADER_HINTS.some((hint) => col.includes(hint))) {
      sensitiveIndexes.add(idx);
    }
  });

  return row.map((cell, idx) => {
    if (!sensitiveIndexes.has(idx)) return cell;
    if (!cell) return cell;
    if (cell.length <= 4) return "****";
    return `${cell.slice(0, 2)}****${cell.slice(-2)}`;
  });
}

/**
 * 银行流水批量导入解析器（src/lib/finance/bank-flow-parser.ts）
 *
 * 纯函数，不碰数据库、不依赖 DOM/浏览器 API，供 API route / 脚本复用。
 * 支持 XLSX（首个 sheet，首行表头）与 CSV/TSV/TXT（自动探测分隔符 + 编码）。
 *
 * 流程：parseBankFlowFile（原始表 → 表头+行）→ guessBankFlowColumnMapping（猜列）
 *       → applyBankFlowMapping（按映射转出标准行，金额转分、日期转 ISO，跳过异常行）。
 */

import * as XLSX from "xlsx";
import iconv from "iconv-lite";
import { parse as csvParse } from "csv-parse/sync";

export type BankFlowEncoding = "utf-8" | "utf-8-bom" | "gb18030" | "unknown";

export type BankFlowParseResult = {
  headers: string[];
  rows: Record<string, string>[];
  encoding: BankFlowEncoding;
  rowCount: number;
};

export type BankFlowColumnMapping = {
  payerName: string;
  amount: string;
  date?: string;
  remark?: string;
  payerAccount?: string;
};

export type MappedBankFlowRow = {
  index: number;
  payerName: string;
  amountCents: number; // 负数 = 支出
  date?: string; // ISO 8601 date YYYY-MM-DD
  remark?: string;
  status: "PENDING" | "SKIPPED";
  skipReason?: string;
};

const MAX_ROWS = 500;
const MAX_COLUMNS = 100;

// ─── 文件类型判断 ────────────────────────────────────────────────

function isXlsxFile(fileName: string): boolean {
  return /\.xlsx?$/i.test(fileName);
}

// ─── 编码检测（顺序：UTF-8 BOM → UTF-8 → GB18030 → unknown） ──────

function decodeBufferToText(
  buffer: Buffer,
  forcedEncoding?: "utf-8" | "gb18030",
): { text: string; encoding: BankFlowEncoding } {
  if (forcedEncoding === "utf-8") {
    return { text: stripBom(buffer.toString("utf-8")), encoding: "utf-8" };
  }
  if (forcedEncoding === "gb18030") {
    return { text: iconv.decode(buffer, "gb18030"), encoding: "gb18030" };
  }

  // UTF-8 BOM
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return { text: buffer.subarray(3).toString("utf-8"), encoding: "utf-8-bom" };
  }

  // UTF-8（无 BOM）：严格解码，遇到非法序列则判定非 UTF-8
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const text = decoder.decode(buffer);
    return { text, encoding: "utf-8" };
  } catch {
    // fall through to GB18030
  }

  // GB18030：iconv-lite 对非法字节容错解码（不抛错），用替换字符占比粗略校验解码质量
  try {
    const text = iconv.decode(buffer, "gb18030");
    const replacementCount = (text.match(/\uFFFD/g) || []).length;
    if (replacementCount === 0 || replacementCount / Math.max(text.length, 1) < 0.02) {
      return { text, encoding: "gb18030" };
    }
  } catch {
    // fall through to unknown
  }

  // unknown：仍尝试 utf-8 解码供预览，不阻断流程
  return { text: buffer.toString("utf-8"), encoding: "unknown" };
}

function stripBom(text: string): string {
  return text.length > 0 && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

// ─── 分隔符探测（comma / tab / semicolon，按首行分隔数最多） ───────

function detectDelimiter(firstLine: string): "," | "\t" | ";" {
  const counts: Array<[",", number] | ["\t", number] | [";", number]> = [
    [",", (firstLine.match(/,/g) || []).length],
    ["\t", (firstLine.match(/\t/g) || []).length],
    [";", (firstLine.match(/;/g) || []).length],
  ];
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ",";
}

// ─── parseBankFlowFile ──────────────────────────────────────────

export function parseBankFlowFile(
  buffer: Buffer,
  fileName: string,
  options?: { encoding?: "utf-8" | "gb18030" },
): BankFlowParseResult {
  if (isXlsxFile(fileName)) {
    // XLSX 忽略 options.encoding（xlsx 库自行处理内部编码）
    const workbook = XLSX.read(buffer, { type: "buffer" });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) throw new Error("Excel 文件中未找到工作表");
    const sheet = workbook.Sheets[sheetName];
    const raw = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      defval: "",
      raw: true,
    });
    return buildParseResult(raw as unknown[][], "utf-8");
  }

  const { text, encoding } = decodeBufferToText(buffer, options?.encoding);
  const firstLine = text.split(/\r\n|\r|\n/).find((l) => l.trim() !== "") ?? "";
  const delimiter = detectDelimiter(firstLine);

  let records: string[][];
  try {
    records = csvParse(text, {
      delimiter,
      skip_empty_lines: true,
      relax_column_count: true,
      trim: true,
    }) as string[][];
  } catch (err) {
    throw new Error(`文件解析失败：${err instanceof Error ? err.message : String(err)}`);
  }

  return buildParseResult(records, encoding);
}

function buildParseResult(rawRows: unknown[][], encoding: BankFlowEncoding): BankFlowParseResult {
  const nonEmptyRows = rawRows.filter(
    (row) => Array.isArray(row) && row.some((c) => String(c ?? "").trim() !== ""),
  );

  if (nonEmptyRows.length === 0) {
    return { headers: [], rows: [], encoding, rowCount: 0 };
  }

  const headerRow = nonEmptyRows[0];
  if (headerRow.length > MAX_COLUMNS) {
    throw new Error(`列数超出上限（${MAX_COLUMNS}）`);
  }

  const dataRows = nonEmptyRows.slice(1);
  if (dataRows.length > MAX_ROWS) {
    throw new Error(`行数超出上限（${MAX_ROWS}）`);
  }

  const headers = headerRow.map((h, i) => {
    const s = String(h ?? "").trim();
    return s || `列${i + 1}`;
  });

  const rows: Record<string, string>[] = dataRows.map((row) => {
    const record: Record<string, string> = {};
    headers.forEach((h, i) => {
      record[h] = String(row[i] ?? "").trim();
    });
    return record;
  });

  return { headers, rows, encoding, rowCount: rows.length };
}

// ─── guessBankFlowColumnMapping ─────────────────────────────────

const COLUMN_KEYWORDS: Record<keyof BankFlowColumnMapping, string[]> = {
  payerName: ["付款", "对方户名", "户名", "付款人", "对方账号名", "单位", "客户"],
  amount: ["金额", "收入", "收款", "贷方金额", "入账金额"],
  date: ["日期", "时间", "交易日期", "记账日期"],
  remark: ["备注", "摘要", "用途", "附言"],
  payerAccount: ["对方账号", "付款账号"],
};

/**
 * 猜测表头 → 字段映射。同一表头可能同时命中多个字段的关键词（如"对方账号名"
 * 同时包含 payerAccount 的"对方账号"和 payerName 的"对方账号名"），取每个表头下
 * **最长**命中关键词所属字段，避免短关键词误抢更精确的长关键词命中的列；
 * 每个字段只取从左到右第一次被命中的列，一列不重复分配给两个字段。
 */
export function guessBankFlowColumnMapping(headers: string[]): Partial<BankFlowColumnMapping> {
  type FieldKey = keyof BankFlowColumnMapping;
  const perHeaderBest: Array<{ header: string; field: FieldKey } | null> = headers.map((raw) => {
    const h = String(raw ?? "").trim();
    if (!h) return null;
    let best: { field: FieldKey; keywordLen: number } | null = null;
    for (const [field, keywords] of Object.entries(COLUMN_KEYWORDS) as [FieldKey, string[]][]) {
      for (const kw of keywords) {
        if (h.includes(kw) && (!best || kw.length > best.keywordLen)) {
          best = { field, keywordLen: kw.length };
        }
      }
    }
    return best ? { header: h, field: best.field } : null;
  });

  const mapping: Partial<BankFlowColumnMapping> = {};
  for (const entry of perHeaderBest) {
    if (!entry) continue;
    if (mapping[entry.field]) continue; // 该字段已由更靠左的列命中
    mapping[entry.field] = entry.header;
  }
  return mapping;
}

// ─── applyBankFlowMapping ───────────────────────────────────────

function isValidYmd(y: number, m: number, d: number): boolean {
  return y >= 1900 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Excel serial（自 1899-12-30 起的天数）→ ISO 日期字符串，与 orders/contract-ledger-parser.ts 的换算口径一致。 */
function excelSerialToIsoDate(serial: number): string | null {
  if (!Number.isFinite(serial) || serial <= 0 || serial > 500000) return null;
  const days = Math.floor(serial);
  const ms = Math.round((days - 25569) * 86400 * 1000);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/** 解析日期为 ISO YYYY-MM-DD；支持 Excel serial、YYYY-MM-DD、YYYY/MM/DD、YYYYMMDD、MM-DD（补当年）。 */
function parseBankFlowDate(raw: string | undefined): string | undefined {
  if (raw == null) return undefined;
  const s = String(raw).trim();
  if (!s) return undefined;

  // YYYYMMDD（8 位纯数字）
  const compact = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact) {
    const y = Number(compact[1]);
    const m = Number(compact[2]);
    const d = Number(compact[3]);
    if (isValidYmd(y, m, d)) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  }

  // YYYY-MM-DD / YYYY/MM/DD（允许带时间后缀，忽略）
  const ymd = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (ymd) {
    const y = Number(ymd[1]);
    const m = Number(ymd[2]);
    const d = Number(ymd[3]);
    if (isValidYmd(y, m, d)) return `${ymd[1]}-${pad2(m)}-${pad2(d)}`;
  }

  // MM-DD / MM/DD（补当年）
  const md = s.match(/^(\d{1,2})[-/](\d{1,2})$/);
  if (md) {
    const m = Number(md[1]);
    const d = Number(md[2]);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      const year = new Date().getFullYear();
      return `${year}-${pad2(m)}-${pad2(d)}`;
    }
  }

  // Excel serial（纯数字，未命中以上任何格式）
  if (/^\d+(\.\d+)?$/.test(s)) {
    const serial = Number(s);
    if (Number.isFinite(serial) && serial > 1000 && serial < 500000) {
      const iso = excelSerialToIsoDate(serial);
      if (iso) return iso;
    }
  }

  return undefined;
}

/** 解析金额为分：去千分位逗号、括号负数、"元"/"万元"后缀（万元 ×10000），四舍五入到分。 */
function parseBankFlowAmountToCents(raw: string | undefined): number | null {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;

  let negative = false;

  // 括号负数：(1,234.56) / （1234.56）
  const parenMatch = s.match(/^[(（]\s*(.+?)\s*[)）]$/);
  if (parenMatch) {
    negative = true;
    s = parenMatch[1];
  }

  // 前置负号
  if (s.startsWith("-")) {
    negative = true;
    s = s.slice(1);
  } else if (s.startsWith("+")) {
    s = s.slice(1);
  }

  // 去千分位逗号 / 空格
  s = s.replace(/,/g, "").replace(/\s+/g, "");

  let multiplier = 1;
  if (s.endsWith("万元")) {
    multiplier = 10000;
    s = s.slice(0, -2);
  } else if (s.endsWith("元")) {
    s = s.slice(0, -1);
  } else if (s.endsWith("万")) {
    multiplier = 10000;
    s = s.slice(0, -1);
  }

  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;

  const yuan = n * multiplier * (negative ? -1 : 1);
  return Math.round(yuan * 100);
}

/**
 * 按列映射把原始行转换为标准化行：
 * - payerName 为空 → SKIPPED
 * - 金额解析失败 → SKIPPED
 * - 负金额（支出）→ SKIPPED，并产生 warning
 */
export function applyBankFlowMapping(
  parsed: BankFlowParseResult,
  mapping: BankFlowColumnMapping,
): { rows: MappedBankFlowRow[]; warnings: string[] } {
  const warnings: string[] = [];
  const rows: MappedBankFlowRow[] = [];

  parsed.rows.forEach((rawRow, i) => {
    const index = i + 1;
    const payerName = (rawRow[mapping.payerName] ?? "").trim();

    if (!payerName) {
      rows.push({ index, payerName: "", amountCents: 0, status: "SKIPPED", skipReason: "付款方为空" });
      warnings.push(`第 ${index} 行：付款方为空，已跳过`);
      return;
    }

    const amountRaw = rawRow[mapping.amount];
    const amountCents = parseBankFlowAmountToCents(amountRaw);
    const date = mapping.date ? parseBankFlowDate(rawRow[mapping.date]) : undefined;
    const remark = mapping.remark ? (rawRow[mapping.remark] ?? "").trim() || undefined : undefined;

    if (amountCents == null) {
      rows.push({
        index,
        payerName,
        amountCents: 0,
        date,
        remark,
        status: "SKIPPED",
        skipReason: "金额解析失败",
      });
      warnings.push(`第 ${index} 行：金额"${amountRaw ?? ""}"解析失败，已跳过`);
      return;
    }

    if (amountCents < 0) {
      rows.push({
        index,
        payerName,
        amountCents,
        date,
        remark,
        status: "SKIPPED",
        skipReason: "负金额（支出）",
      });
      warnings.push(`第 ${index} 行：金额为负（支出），已跳过`);
      return;
    }

    rows.push({
      index,
      payerName,
      amountCents,
      date,
      remark,
      status: "PENDING",
    });
  });

  return { rows, warnings };
}

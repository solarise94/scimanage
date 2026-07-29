/**
 * 预存款充值记录解析器（src/lib/orders/advance-records-parser.ts）
 *
 * 解析「预存款客户项目」sheet 中有「预存款立项金额」的行（充值记录），
 * 产出归一化的 AdvanceRecordRow[]，供 commitAdvanceRecords 落库 FinanceAdvance。
 *
 * 见 docs/history-orders-import-design.md（预存款充值导入扩展）。
 *
 * sheet 结构（18 列）：
 *   文本 | 项目编号 | 预存款立项时间 | 预存款立项金额 | 交付时间 | 客户团队 |
 *   总金额 | 总费用 | 余额 | 父记录 | 开票时间 | 发票号 | 我方开票单位 |
 *   对方开票单位 | 到款时间 | 流水号 | 到款金额 | 到款备注
 *
 * 充值记录判定：预存款立项金额非空（消费记录无此列，仅有到款金额）。
 * 客户匹配：「客户团队」列混合人名和机构名。人名匹配 buyerName，
 * 机构名同时作为 buyerOrgName 解析 Organization。匹配不到 CREATE_IF_MISSING。
 */

import * as XLSX from "xlsx";
import { parseAmount, parseLedgerDate } from "@/lib/orders/contract-ledger-parser";

export interface AdvanceRecordRow {
  rowIndex: number;
  projectNo: string | null; // 项目编号（可能是 2504015 / YCK2026007 等）
  customerTeam: string | null; // 客户团队（人名或机构名）
  advancedAt: Date | null; // 预存款立项时间
  amountCents: number; // 预存款立项金额（分）
  receivedAt: Date | null; // 到款时间
  receivedAmountCents: number | null; // 到款金额（分），可能与立项金额不同
  invoiceNo: string | null; // 发票号
  sellerName: string | null; // 我方开票单位
  buyerInvoiceOrgName: string | null; // 对方开票单位
  bankSerialNo: string | null; // 流水号
  remark: string | null; // 到款备注
}

export interface AdvanceRecordParseResult {
  rows: AdvanceRecordRow[];
  errors: Array<{ row: number; message: string }>;
  warnings: Array<{ row: number; message: string }>;
  summary: {
    totalRows: number;
    totalAmountCents: number;
    customerTeams: string[];
  };
}

const HEADER_ALIASES: Record<string, string[]> = {
  projectNo: ["项目编号"],
  advancedAt: ["预存款立项时间"],
  amount: ["预存款立项金额"],
  customerTeam: ["客户团队"],
  receivedAt: ["到款时间"],
  receivedAmount: ["到款金额"],
  invoiceNo: ["发票号"],
  sellerOrg: ["我方开票单位"],
  buyerInvoiceOrg: ["对方开票单位"],
  bankSerialNo: ["流水号"],
  remark: ["到款备注"],
};

function normalizeHeader(s: unknown): string {
  if (s == null) return "";
  return String(s).trim().replace(/\u3000/g, " ").replace(/（/g, "(").replace(/）/g, ")");
}

function buildColIdx(headerRow: unknown[]): Record<string, number> {
  const normalized = headerRow.map(normalizeHeader);
  const idx: Record<string, number> = {};
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    const aliasNorm = aliases.map(normalizeHeader);
    let found = -1;
    for (const a of aliasNorm) {
      const pos = normalized.indexOf(a);
      if (pos >= 0) { found = pos; break; }
    }
    idx[field] = found;
  }
  return idx;
}

function cellStr(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
}

/**
 * 解析「预存款客户项目」sheet → 充值记录（有立项金额的行）。纯函数。
 * @param buffer xlsx 文件 buffer
 * @param sheetName sheet 名，默认「预存款客户项目」
 */
export function parseAdvanceRecords(buffer: Buffer, sheetName = "预存款客户项目"): AdvanceRecordParseResult {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const ws = wb.Sheets[sheetName] ?? wb.Sheets[wb.SheetNames[0]];
  if (!ws) {
    return {
      rows: [],
      errors: [{ row: 0, message: `sheet "${sheetName}" 不存在` }],
      warnings: [],
      summary: { totalRows: 0, totalAmountCents: 0, customerTeams: [] },
    };
  }
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: null, raw: true });
  const cols = buildColIdx(matrix[0] ?? []);
  const g = (row: unknown[], field: string): unknown => {
    const i = cols[field];
    return i >= 0 ? row[i] : undefined;
  };

  const rows: AdvanceRecordRow[] = [];
  const errors: AdvanceRecordParseResult["errors"] = [];
  const warnings: AdvanceRecordParseResult["warnings"] = [];
  const customerTeams = new Set<string>();
  let totalAmountCents = 0;

  for (let i = 1; i < matrix.length; i++) {
    const r = matrix[i];
    if (!r) continue;
    // 空行跳过
    if (r.every((c) => c == null || c === "")) continue;

    const amountCents = parseAmount(g(r, "amount"));
    // 只取有立项金额的行（充值记录）。无金额的是消费/占位行，跳过。
    if (amountCents == null || amountCents <= 0) continue;

    const customerTeam = cellStr(g(r, "customerTeam"));
    const projectNo = cellStr(g(r, "projectNo"));
    if (!customerTeam && !projectNo) {
      warnings.push({ row: i, message: "客户团队和项目编号均为空，跳过" });
      continue;
    }
    if (customerTeam) customerTeams.add(customerTeam);

    const receivedAmountCents = parseAmount(g(r, "receivedAmount"));
    rows.push({
      rowIndex: i,
      projectNo,
      customerTeam,
      advancedAt: parseLedgerDate(g(r, "advancedAt")),
      amountCents,
      receivedAt: parseLedgerDate(g(r, "receivedAt")),
      receivedAmountCents,
      invoiceNo: cellStr(g(r, "invoiceNo")),
      sellerName: cellStr(g(r, "sellerOrg")),
      buyerInvoiceOrgName: cellStr(g(r, "buyerInvoiceOrg")),
      bankSerialNo: cellStr(g(r, "bankSerialNo")),
      remark: cellStr(g(r, "remark")),
    });
    totalAmountCents += amountCents;
  }

  return {
    rows,
    errors,
    warnings,
    summary: {
      totalRows: rows.length,
      totalAmountCents,
      customerTeams: Array.from(customerTeams).sort(),
    },
  };
}

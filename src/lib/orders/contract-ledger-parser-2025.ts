/**
 * 2025 历史数据解析器（src/lib/orders/contract-ledger-parser-2025.ts）
 *
 * 将 `2025-历史数据.xlsx` 的「生物收入情况」sheet（28 列）解析为与合同台账
 * 相同的 ContractLedgerRow 结构，复用 commitContractLedger 落库。
 * 见 docs/history-orders-import-design.md §3.2 / §5.1。
 *
 * 2025 与 2026/台账的关键语义差异：
 * - 「项目类型」列存的是采购渠道（笙源/高精/赛图…），非真·项目类型 → 重映射到 procurementSource，
 *   projectType 固定 SERVICE。
 * - 「父记录」列存的是日期（2025/07/24），非父项目编号 → 忽略。
 * - 无发票号/到款明细 → 发票只取单张「开票金额」，到款为空。
 * - 「季度超指标奖励」「打款/提成」是文本（+2%/无需），非金额 → 进 remark。
 * - 成本取「项目成本」（不含税），与 2026 口径一致。
 */

import * as XLSX from "xlsx";
import {
  parseAmount,
  parseLedgerDate,
  mapLedgerProgress,
  cleanRepresentativeName,
  cleanSellerName,
  resolveOrgSiteMapping,
  type ContractLedgerRow,
  type ContractLedgerParseResult,
} from "@/lib/orders/contract-ledger-parser";

// 2025「生物收入情况」sheet 的 28 列表头名称映射
const HISTORY2025_HEADER: Record<string, string[]> = {
  date: ["日期"],
  projectNo: ["项目编号"],
  orderNumber: ["高精立项编号"],
  organization: ["对方单位"],
  client: ["客户"],
  representative: ["代表"],
  techSupport: ["技术支持"],
  projectContent: ["项目内容"],
  // 「文本 10」是空占位列，忽略
  projectType: ["项目类型"], // ⚠️ 语义重映射：实际是采购渠道
  progress: ["项目进度"],
  quarterlyBonus: ["季度超指标奖励"],
  commissionPaid: ["打款/提成"],
  deliveredDate: ["交付时间"],
  projectAmount: ["项目金额（元）", "项目金额(元)", "项目金额"],
  projectCost: ["项目成本"], // ⚠️ 不含税，不用「总成本」
  // 平台费/税点/总成本/项目利润 均忽略
  invoiceAmount: ["开票金额"], // 单列汇总，非明细
  sellerOrg: ["开票单位"],
  month: ["月份"],
  remark: ["备注"],
  quantity: ["小鼠数量"], // 2025 无独立数量列，小鼠数量即数量
  // 包装成本/招标平台 忽略
  // 父记录忽略（日期非编号）
};

/** 表头归一化：与 contract-ledger-parser.buildColumnIndex 一致。 */
function normalizeHeader(s: unknown): string {
  if (s == null) return "";
  return String(s)
    .trim()
    .replace(/\u3000/g, " ")
    .replace(/（/g, "(")
    .replace(/）/g, ")");
}

function buildColIdx(headerRow: unknown[]): Record<string, number> {
  const normalized = headerRow.map(normalizeHeader);
  const idx: Record<string, number> = {};
  for (const [field, aliases] of Object.entries(HISTORY2025_HEADER)) {
    const aliasNorm = aliases.map(normalizeHeader);
    let found = -1;
    for (const a of aliasNorm) {
      const pos = normalized.indexOf(a);
      if (pos >= 0) {
        found = pos;
        break;
      }
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

// 开票单位黑名单：这些值不是真实机构，不建发票
const SELLER_BLACKLIST = new Set([
  "无需",
  "尚未开票",
  "内部",
  "预存款",
  "微信二维码",
]);

/**
 * 解析 2025 历史数据 xlsx buffer → ContractLedgerRow[]。纯函数，不碰数据库。
 */
export function parseHistory2025(buffer: Buffer): ContractLedgerParseResult {
  const wb = XLSX.read(buffer, { type: "buffer" });
  // 2025 数据在「生物收入情况」sheet（通常是第 1 个，但按名查找更稳）
  const ws = wb.Sheets["生物收入情况"] ?? wb.Sheets[wb.SheetNames[0]];
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(ws, {
    header: 1,
    defval: null,
    raw: true,
  });

  const cols = buildColIdx(matrix[0] ?? []);
  const g = (row: unknown[], field: string): unknown => {
    const i = cols[field];
    return i >= 0 ? row[i] : undefined;
  };

  const rows: ContractLedgerRow[] = [];
  const errors: ContractLedgerParseResult["errors"] = [];
  const warnings: ContractLedgerParseResult["warnings"] = [];
  const seenProjectNos = new Set<string>();
  const repsToBind = new Set<string>();
  const newOrgCandidates = new Set<string>();
  let invoiceCount = 0;
  let pureCostRows = 0;

  for (let i = 1; i < matrix.length; i++) {
    const r = matrix[i];
    if (!r) continue;
    const projectNo = cellStr(g(r, "projectNo"));
    if (!projectNo) {
      if (r.every((c) => c == null || c === "")) continue;
      errors.push({ row: i, message: "项目编号列为空" });
      continue;
    }
    if (seenProjectNos.has(projectNo)) {
      errors.push({ row: i, message: `项目编号重复: ${projectNo}` });
      continue;
    }
    seenProjectNos.add(projectNo);

    const orgRaw = cellStr(g(r, "organization"));
    const orgMapping = resolveOrgSiteMapping(orgRaw);
    if (orgRaw && !orgMapping) newOrgCandidates.add(orgRaw);

    const representative = cleanRepresentativeName(g(r, "representative"));
    if (representative) repsToBind.add(representative);

    const { status, progress } = mapLedgerProgress(g(r, "progress"));
    const projectAmountCents = parseAmount(g(r, "projectAmount"));
    const projectCostCents = parseAmount(g(r, "projectCost"));

    // 「项目类型」列实际是采购渠道 → procurementSource；projectType 固定 SERVICE
    const procurementSource = cellStr(g(r, "projectType"));
    const projectType = "SERVICE";

    // 发票：单张「开票金额」，需清洗开票单位
    const sellerNameRaw = cleanSellerName(g(r, "sellerOrg"));
    const invoiceAmountCents = parseAmount(g(r, "invoiceAmount"));
    const invoices = [];
    if (
      invoiceAmountCents != null &&
      invoiceAmountCents > 0 &&
      sellerNameRaw &&
      !SELLER_BLACKLIST.has(sellerNameRaw)
    ) {
      invoices.push({
        amountCents: invoiceAmountCents,
        issuedAt: parseLedgerDate(g(r, "deliveredDate")),
        invoiceNo: null,
      });
      invoiceCount++;
    }

    // 到款：2025 无到款明细，留空（后续手动补）
    const receipts: ContractLedgerRow["receipts"] = [];

    // remark 合并：季度超指标奖励 | 打款/提成 | 月份 | 备注
    const remarkParts = [
      cellStr(g(r, "quarterlyBonus")),
      cellStr(g(r, "commissionPaid")),
      cellStr(g(r, "month")),
      cellStr(g(r, "remark")),
    ].filter((x): x is string => !!x);
    // 负金额标注历史冲红/退款
    if (projectAmountCents != null && projectAmountCents < 0) {
      remarkParts.push("[历史冲红/退款]");
    }
    const remark = remarkParts.length > 0 ? remarkParts.join(" | ") : null;

    const quantity = (() => {
      const q = g(r, "quantity");
      if (q == null || q === "") return null;
      const n = typeof q === "number" ? q : parseInt(String(q).replace(/[^\d-]/g, ""), 10);
      return isNaN(n) ? null : n;
    })();

    const isPureCost =
      (projectAmountCents == null || projectAmountCents === 0) &&
      projectCostCents != null &&
      projectCostCents > 0;
    if (isPureCost) pureCostRows++;

    // 2025 无预存款抵扣标记
    const isAdvanceSettlement = false;
    // 2025 无合并到款
    const isMergedReceipt = false;
    // 2025 父记录是日期，忽略

    rows.push({
      rowIndex: i,
      projectNo,
      orderNumber: cellStr(g(r, "orderNumber")),
      organizationRaw: orgRaw,
      orgMapping,
      client: cellStr(g(r, "client")),
      representativeRaw: cellStr(g(r, "representative")),
      representative,
      techSupport: cellStr(g(r, "techSupport")),
      projectType,
      projectContent: cellStr(g(r, "projectContent")),
      quantity,
      procurementSource,
      brand: null, // 2025 无品牌列
      progressRaw: cellStr(g(r, "progress")),
      status,
      progress,
      startDate: parseLedgerDate(g(r, "date")),
      deliveredAt: parseLedgerDate(g(r, "deliveredDate")),
      terminatedAt: null, // 2025 无独立终止时间列
      projectAmountCents,
      projectCostCents,
      commissionPaidCents: null, // 文本非金额
      quarterlyBonusCents: null, // 文本非金额
      remark,
      sellerName: sellerNameRaw,
      buyerInvoiceOrgName: null, // 2025 无对方开票单位列
      invoices,
      receiptRemark: null,
      receipts,
      totalReceivableCents: null, // 2025 无此列
      finalReceivableCents: null,
      totalPayableCents: null,
      attachmentFileName: null, // 2025 无附件列
      parentProjectNo: null, // 忽略（日期非编号）
      isAdvanceSettlement,
      isPureCost,
      isMergedReceipt,
    });
  }

  return {
    rows,
    errors,
    warnings,
    summary: {
      totalRows: rows.length,
      projectCount: rows.length,
      invoiceCount,
      receiptCount: 0,
      parentChildRows: 0,
      pureCostRows,
      advanceSettlementRows: 0,
      repsToBind: Array.from(repsToBind).sort(),
      newOrgCandidates: Array.from(newOrgCandidates).sort(),
    },
  };
}

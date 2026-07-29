/**
 * 合同台账解析器（src/lib/orders/contract-ledger-parser.ts）
 *
 * 职责：将"生物收入-合同情况表"xlsx 解析为归一化行结构，**不碰数据库**，纯函数易测。
 * 见 docs/contract-ledger-import-export-design.md。
 *
 * 设计要点：
 * - Excel 金额列类型不统一（int 与 str:'0.00' 混存），统一走 parseAmount → 分。
 * - 日期列可能是 Excel serial（46026）或字符串，统一 parseLedgerDate（UTC-safe，避免时区漂移）。
 * - 代表名清洗：剥已知部门前缀/括号标记，"/" 占位留空。
 * - 对方单位 → 机构/校区映射表（§5），未命中走 CREATE_IF_MISSING。
 */

import * as XLSX from "xlsx";
import { yuanToCents } from "@/lib/finance/money";

// ─── 列索引（44 列，A=0 ... AR=43）────────────────────────────────
// 注：此常量保留为 44 列台账的列序文档参照。实际解析改用表头名称匹配
// (buildColumnIndex)，以兼容 46 列（2026 历史数据插入流水号1/2）等变体。
export const LEDGER_COL = {
  projectNo: 0, // A 项目编号
  orderNumber: 1, // B 高精立项编号
  organization: 2, // C 对方单位
  client: 3, // D 客户
  representative: 4, // E 代表
  techSupport: 5, // F 技术支持
  projectType: 6, // G 项目类型
  projectContent: 7, // H 项目内容
  quantity: 8, // I 数量
  procurementSource: 9, // J 采购渠道
  brand: 10, // K 品牌
  progress: 11, // L 项目进度
  startDate: 12, // M 立项时间
  deliveredDate: 13, // N 交付时间
  terminatedDate: 14, // O 终止时间
  projectAmount: 15, // P 项目金额
  depositProgress: 16, // Q 立项进度款
  finalProgress: 17, // R 交付进度款
  projectCost: 18, // S 项目成本
  depositCost: 19, // T 立项成本
  finalCost: 20, // U 交付成本
  profit: 21, // V 项目利润
  commissionPaid: 22, // W 打款|提成
  quarterlyBonus: 23, // X 季度超指标奖励
  remark: 24, // Y 备注
  sellerOrg: 25, // Z 我方开票单位
  buyerInvoiceOrg: 26, // AA 对方开票单位
  invoiceAmount1: 27, // AB 开票金额1
  invoiceTime1: 28, // AC 开票时间1
  invoiceAmount2: 29, // AD 开票金额2
  invoiceTime2: 30, // AE 开票时间2
  invoiceNo: 31, // AF 发票号
  receiptRemark: 32, // AG 到款备注
  receipt1: 33, // AH 到款1
  receiptTime1: 34, // AI 到款时间1
  receiptAccount1: 35, // AJ 到款账户1
  receipt2: 36, // AK 到款2
  receiptTime2: 37, // AL 到款时间2
  receiptAccount2: 38, // AM 到款账户2
  totalReceivable: 39, // AN 总应收款
  finalReceivable: 40, // AO 交付应收款
  totalPayable: 41, // AP 总应付款
  attachment: 42, // AQ 合同&出库单附件
  parentRecord: 43, // AR 父记录
} as const;

// ─── 表头名称 → 字段映射（兼容 44/46 列变体）──────────────────────
// 表头在不同年份文件中有细微别名（如 44 列「备注」vs 46 列「开票备注」），
// 此处按字段列出所有可接受表头名，按顺序回退匹配。
const HEADER_ALIASES: Record<string, string[]> = {
  projectNo: ["项目编号"],
  orderNumber: ["高精立项编号"],
  organization: ["对方单位"],
  client: ["客户"],
  representative: ["代表"],
  techSupport: ["技术支持"],
  projectType: ["项目类型"],
  projectContent: ["项目内容"],
  quantity: ["数量"],
  procurementSource: ["采购渠道"],
  brand: ["品牌"],
  progress: ["项目进度"],
  startDate: ["立项时间"],
  deliveredDate: ["交付时间"],
  terminatedDate: ["终止时间"],
  projectAmount: ["项目金额（元）", "项目金额(元)", "项目金额"],
  depositProgress: ["立项进度款（30%/0%）", "立项进度款(30%/0%)", "立项进度款"],
  finalProgress: ["交付进度款（70%/100%）", "交付进度款(70%/100%)", "交付进度款"],
  projectCost: ["项目成本（元）", "项目成本(元)", "项目成本"],
  depositCost: ["立项成本（30%/0%）", "立项成本(30%/0%)", "立项成本"],
  finalCost: ["交付成本（70%/100%）", "交付成本(70%/100%)", "交付成本"],
  profit: ["项目利润"],
  commissionPaid: ["打款|提成", "打款/提成"],
  quarterlyBonus: ["季度超指标奖励"],
  remark: ["开票备注", "备注"], // 46 列叫「开票备注」，44 列叫「备注」
  sellerOrg: ["我方开票单位"],
  buyerInvoiceOrg: ["对方开票单位"],
  invoiceAmount1: ["开票金额1"],
  invoiceTime1: ["开票时间1"],
  invoiceAmount2: ["开票金额2"],
  invoiceTime2: ["开票时间2"],
  invoiceNo: ["发票号"],
  receiptRemark: ["到款备注"],
  receipt1: ["到款1"],
  receiptTime1: ["到款时间1"],
  receiptAccount1: ["到款账户1"],
  receipt2: ["到款2"],
  receiptTime2: ["到款时间2"],
  receiptAccount2: ["到款账户2"],
  totalReceivable: ["总应收款"],
  finalReceivable: ["交付应收款"],
  totalPayable: ["总应付款"],
  attachment: ["合同&出库单附件"],
  parentRecord: ["父记录"],
  // 流水号1/2 仅 2026 有，本次不导入，登记用于识别后忽略
  bankSerial1: ["流水号1"],
  bankSerial2: ["流水号2"],
};

/** 表头归一化：trim + 全角空格→半角 + 全角括号→半角，便于匹配容错。 */
function normalizeHeader(s: unknown): string {
  if (s == null) return "";
  return String(s)
    .trim()
    .replace(/\u3000/g, " ") // 全角空格
    .replace(/（/g, "(")
    .replace(/）/g, ")");
}

/**
 * 按表头名称构建 字段→列索引 映射。支持别名回退。
 * 未命中的字段值为 -1（调用方需对 -1 容错）。
 */
export function buildColumnIndex(headerRow: unknown[]): Record<string, number> {
  const normalized = headerRow.map(normalizeHeader);
  const idx: Record<string, number> = {};
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
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

// ─── 金额/日期解析 ───────────────────────────────────────────────

/** 统一金额解析：int/str 混类型 → 分（Int）。空值返回 null。 */
export function parseAmount(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n =
    typeof v === "number" ? v : parseFloat(String(v).replace(/[¥￥,，\s]/g, ""));
  return isNaN(n) ? null : yuanToCents(n);
}

/**
 * 统一日期解析：Excel serial（数字）或字符串 → Date（UTC-safe）。
 * Excel serial 以 1899-12-30 为基准；用 UTC 计算避免本地时区漂移。
 */
export function parseLedgerDate(v: unknown): Date | null {
  if (v == null || v === "") return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  if (typeof v === "number") {
    if (!isFinite(v) || v <= 0) return null;
    // 取整数天 + 小数秒；用 UTC 午夜避免时区导致日期前移一天
    const days = Math.floor(v);
    const ms = Math.round((days - 25569) * 86400 * 1000);
    const d = new Date(ms);
    return isNaN(d.getTime()) ? null : d;
  }
  const s = String(v).trim();
  if (!s) return null;
  // 纯日期串（YYYY-MM-DD / YYYY/MM/DD）按 UTC 午夜解析，与 Excel serial 路径口径一致，避免本地时区漂移
  const ymd = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (ymd) {
    const d = new Date(Date.UTC(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3])));
    return isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

// ─── 项目进度 → status/progress ──────────────────────────────────
export function mapLedgerProgress(raw: unknown): { status: string; progress: number } {
  const s = raw == null ? "" : String(raw).trim();
  switch (s) {
    case "已交付":
      return { status: "COMPLETED", progress: 100 };
    case "已签单":
      return { status: "IN_PROGRESS", progress: 30 };
    case "实验中":
      return { status: "IN_PROGRESS", progress: 50 };
    case "预实验":
    case "询单/预实验":
      return { status: "IN_PROGRESS", progress: 10 };
    case "终止":
    case "坏账":
      return { status: "TERMINATED", progress: 0 };
    default:
      return { status: "NOT_STARTED", progress: 0 };
  }
}

// ─── 代表名清洗（§6.1）──────────────────────────────────────────
const KNOWN_REP_PREFIXES = ["医检"];

/** 清洗代表名：剥部门前缀/括号标记；"/"、"/客户自提" 等占位留空。 */
export function cleanRepresentativeName(raw: unknown): string {
  if (raw == null) return "";
  let s = String(raw).trim();
  if (!s) return "";
  // "/" 或 "/客户自提" → 占位，留空待手动绑定
  if (s.startsWith("/")) return "";
  // 剥括号标记，如 "覃美秋（医检）" → "覃美秋"
  s = s.replace(/[（(][^）)]*[）)]/g, "").trim();
  // 剥已知部门前缀，如 "医检郑力瑞" → "郑力瑞"
  for (const p of KNOWN_REP_PREFIXES) {
    if (s.startsWith(p) && s.length > p.length) {
      s = s.slice(p.length).trim();
      break;
    }
  }
  return s;
}

// ─── 我方开票单位归一化 ──────────────────────────────────────────
export function cleanSellerName(raw: unknown): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  return s || null;
}

// ─── 对方单位 → 机构/校区映射（§5）──────────────────────────────
export type SiteType = "CAMPUS" | "COLLEGE" | "BUILDING" | "OTHER";
export interface OrgSiteMapping {
  canonicalName: string;
  siteName?: string;
  siteType?: SiteType;
}

/**
 * 机构-校区映射表：原始值 → (canonicalName, siteName?, siteType?)。
 * 仅覆盖 §5 中明确登记的多校区/合并/独立机构；未命中走 CREATE_IF_MISSING。
 * key 为 trim 后原值。
 */
const ORG_SITE_MAP: Record<string, OrgSiteMapping> = {
  // ── 浙江大学系 ──
  "浙江大学": { canonicalName: "浙江大学" },
  "浙江大学(紫金港校区)": { canonicalName: "浙江大学", siteName: "紫金港校区", siteType: "CAMPUS" },
  "浙江大学紫金港校区": { canonicalName: "浙江大学", siteName: "紫金港校区", siteType: "CAMPUS" },
  "浙江大学（紫金港校区）": { canonicalName: "浙江大学", siteName: "紫金港校区", siteType: "CAMPUS" },
  "浙江大学(紫金港校区)药学院": { canonicalName: "浙江大学", siteName: "紫金港校区·药学院", siteType: "COLLEGE" },
  "浙江大学(紫金港校区) 药学院": { canonicalName: "浙江大学", siteName: "紫金港校区·药学院", siteType: "COLLEGE" },
  "浙江大学药学院": { canonicalName: "浙江大学", siteName: "紫金港校区·药学院", siteType: "COLLEGE" },
  "浙江大学紫金港校区药学院": { canonicalName: "浙江大学", siteName: "紫金港校区·药学院", siteType: "COLLEGE" },
  "浙江大学(紫金港校区)动物科学学院": { canonicalName: "浙江大学", siteName: "紫金港校区·动物科学学院", siteType: "COLLEGE" },
  "浙江大学紫金港校区生命科学学院": { canonicalName: "浙江大学", siteName: "紫金港校区·生命科学学院", siteType: "COLLEGE" },
  "浙江大学医学院": { canonicalName: "浙江大学", siteName: "医学院", siteType: "COLLEGE" },
  "浙江大学动物医学中心": { canonicalName: "浙江大学", siteName: "动物医学中心", siteType: "OTHER" },
  "浙大动物医院": { canonicalName: "浙江大学", siteName: "教学动物医院", siteType: "OTHER" },
  "浙江大学教学动物医院": { canonicalName: "浙江大学", siteName: "教学动物医院", siteType: "OTHER" },
  "浙江大学医学中心 良渚": { canonicalName: "浙江大学", siteName: "医学中心·良渚", siteType: "OTHER" },
  // 独立机构（浙大系但独立纳税）
  "浙江大学海宁国际校区": { canonicalName: "浙江大学海宁国际校区" },
  "浙江大学海宁校区": { canonicalName: "浙江大学海宁国际校区" },
  "浙大海宁校区": { canonicalName: "浙江大学海宁国际校区" },
  "浙江大学科创": { canonicalName: "浙江大学科创" },
  "浙江大学金华研究院": { canonicalName: "浙江大学金华研究院" },
  "浙江大学医学院附属儿童医院(莫干山院区)": { canonicalName: "浙江大学医学院附属儿童医院", siteName: "莫干山院区", siteType: "CAMPUS" },

  // ── 浙江中医药大学系 ──
  "浙江中医药大学": { canonicalName: "浙江中医药大学" },
  "浙江中医药大学(滨文校区)": { canonicalName: "浙江中医药大学", siteName: "滨文校区", siteType: "CAMPUS" },
  "浙江中医药大学滨文校区": { canonicalName: "浙江中医药大学", siteName: "滨文校区", siteType: "CAMPUS" },
  "浙江中医药大学金华研究院": { canonicalName: "浙江中医药大学金华研究院" },

  // ── 其余合并/独立机构 ──
  "浙江理工大学": { canonicalName: "浙江理工大学" },
  "浙江理工大学(下沙校区)": { canonicalName: "浙江理工大学", siteName: "下沙校区", siteType: "CAMPUS" },
  "南通大学": { canonicalName: "南通大学" },
  "南通大学(啬园校区)": { canonicalName: "南通大学", siteName: "啬园校区", siteType: "CAMPUS" },
  "温州医科大学": { canonicalName: "温州医科大学" },
  "温州医科大学(茶山校区)": { canonicalName: "温州医科大学", siteName: "茶山校区", siteType: "CAMPUS" },
  "浙大城市学院": { canonicalName: "浙大城市学院" },
  "浙大城市学院(南校区)": { canonicalName: "浙大城市学院", siteName: "南校区", siteType: "CAMPUS" },
  "浙大城市学院南校区": { canonicalName: "浙大城市学院", siteName: "南校区", siteType: "CAMPUS" },
  "浙大城市学院(北校区)": { canonicalName: "浙大城市学院", siteName: "北校区", siteType: "CAMPUS" },
  "浙大城市学院(南校区) 脑与认知研究院": { canonicalName: "浙大城市学院", siteName: "南校区·脑与认知研究院", siteType: "COLLEGE" },
  "浙江树人学院": { canonicalName: "浙江树人大学" },
  "浙江树人大学": { canonicalName: "浙江树人大学" },
  "浙江树人大学(北校区)": { canonicalName: "浙江树人大学", siteName: "北校区", siteType: "CAMPUS" },
  "重庆医科大学": { canonicalName: "重庆医科大学" },
  "重庆医科大学附属第一医院": { canonicalName: "重庆医科大学附属第一医院" },
  "温州医科大学附属第一医院": { canonicalName: "温州医科大学附属第一医院" },
  "温州医科大学附属第一医院(南白象院区)": { canonicalName: "温州医科大学附属第一医院", siteName: "南白象院区", siteType: "CAMPUS" },
  "浙江省人民医院": { canonicalName: "浙江省人民医院" },
  "浙江省人民医院(朝晖院区)": { canonicalName: "浙江省人民医院", siteName: "朝晖院区", siteType: "CAMPUS" },
  "浙江省人民医院实验动物中心": { canonicalName: "浙江省人民医院", siteName: "实验动物中心", siteType: "OTHER" },
  "温州市中医院": { canonicalName: "温州市中医院" },
  "温州市中医院急救中心": { canonicalName: "温州市中医院", siteName: "急救中心", siteType: "OTHER" },
  "温州市中医院(六虹桥院区)": { canonicalName: "温州市中医院", siteName: "六虹桥院区", siteType: "CAMPUS" },
  "浙江工商大学": { canonicalName: "浙江工商大学" },
  "浙江工商大学下沙校区": { canonicalName: "浙江工商大学", siteName: "下沙校区", siteType: "CAMPUS" },
  "上海市第六人民医院": { canonicalName: "上海市第六人民医院" },
  "上海六院": { canonicalName: "上海市第六人民医院" },
  "温医大附二院医学研究中心": { canonicalName: "温医大附二院医学研究中心" },
  "温医大附二院": { canonicalName: "温医大附二院医学研究中心" },
  "浙江省农业科学院": { canonicalName: "浙江省农业科学院" },
  "浙江省农科院": { canonicalName: "浙江省农业科学院" },
  "/": { canonicalName: "本部结算" },
  "企服（1月成本核对）": { canonicalName: "企服" },
  "云鸿": { canonicalName: "云鸿" },
};

/** 查机构-校区映射；未命中返回 null（调用方走 CREATE_IF_MISSING 用原值）。 */
export function resolveOrgSiteMapping(raw: unknown): OrgSiteMapping | null {
  if (raw == null) return null;
  const key = String(raw).trim();
  if (!key) return null;
  return ORG_SITE_MAP[key] ?? null;
}

// ─── 行结构 ──────────────────────────────────────────────────────
export interface LedgerInvoice {
  amountCents: number;
  issuedAt: Date | null;
  invoiceNo: string | null;
}
export interface LedgerReceipt {
  amountCents: number;
  receivedAt: Date | null;
  account: string | null;
}
export interface ContractLedgerRow {
  rowIndex: number; // 1-based data row (含跳过表头后)
  projectNo: string;
  orderNumber: string | null;
  organizationRaw: string | null;
  orgMapping: OrgSiteMapping | null;
  client: string | null;
  representativeRaw: string | null;
  representative: string; // 清洗后
  techSupport: string | null;
  projectType: string | null;
  projectContent: string | null;
  quantity: number | null;
  procurementSource: string | null;
  brand: string | null;
  progressRaw: string | null;
  status: string;
  progress: number;
  startDate: Date | null;
  deliveredAt: Date | null;
  terminatedAt: Date | null;
  projectAmountCents: number | null;
  projectCostCents: number | null;
  commissionPaidCents: number | null;
  quarterlyBonusCents: number | null;
  remark: string | null;
  sellerName: string | null;
  buyerInvoiceOrgName: string | null;
  invoices: LedgerInvoice[];
  receiptRemark: string | null;
  receipts: LedgerReceipt[];
  totalReceivableCents: number | null; // AN 总应收款
  finalReceivableCents: number | null; // AO 交付应收款
  totalPayableCents: number | null; // AP 总应付款
  attachmentFileName: string | null;
  parentProjectNo: string | null;
  // 派生标志
  isAdvanceSettlement: boolean; // 预存款抵扣类型
  isPureCost: boolean; // 金额0 成本>0
  isMergedReceipt: boolean; // 到款备注含"合并到款"
}

export interface ContractLedgerParseResult {
  rows: ContractLedgerRow[];
  errors: Array<{ row: number; message: string }>;
  warnings: Array<{ row: number; message: string }>;
  summary: {
    totalRows: number;
    projectCount: number;
    invoiceCount: number;
    receiptCount: number;
    parentChildRows: number;
    pureCostRows: number;
    advanceSettlementRows: number;
    repsToBind: string[]; // 待绑定代表清单（非空清洗名去重）
    newOrgCandidates: string[]; // 未命中映射表的对方单位原值（去重）
  };
}

function cellStr(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
}

/** 拆分发票号：AF 列 "A\B" → ["A","B"]，支持 \ / ，、; 分隔。 */
export function splitInvoiceNos(raw: unknown): string[] {
  const s = cellStr(raw);
  if (!s) return [];
  return s
    .split(/[\\/，,;；\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/**
 * 解析 xlsx buffer → 归一化行结构。纯函数，不碰数据库。
 * 兼容 44 列（合同台账）与 46 列（2026 历史数据，含流水号1/2）——按表头名称匹配列。
 *
 * @param sheetName 可选，指定 sheet 名。不传则用第 1 个 sheet。
 *                  2026 历史数据文件含多个 sheet，真实数据在「26年生物收入&成本」，
 *                  需显式传入；合同台账单 sheet 文件可省略。
 */
export function parseContractLedger(buffer: Buffer, sheetName?: string): ContractLedgerParseResult {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const ws = wb.Sheets[sheetName ?? wb.SheetNames[0]];
  if (!ws) {
    return {
      rows: [],
      errors: [{ row: 0, message: `sheet "${sheetName}" 不存在，可用: ${wb.SheetNames.join(", ")}` }],
      warnings: [],
      summary: {
        totalRows: 0,
        projectCount: 0,
        invoiceCount: 0,
        receiptCount: 0,
        parentChildRows: 0,
        pureCostRows: 0,
        advanceSettlementRows: 0,
        repsToBind: [],
        newOrgCandidates: [],
      },
    };
  }
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(ws, {
    header: 1,
    defval: null,
    raw: true,
  });

  // 表头名称 → 列索引（容错未命中：返回 -1，取值时按 undefined 处理）
  const cols = buildColumnIndex(matrix[0] ?? []);
  // 按字段名安全取单元格值
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
  let receiptCount = 0;
  let parentChildRows = 0;
  let pureCostRows = 0;
  let advanceSettlementRows = 0;

  // matrix[0] 是表头，从 1 开始
  for (let i = 1; i < matrix.length; i++) {
    const r = matrix[i];
    if (!r) continue;
    const projectNo = cellStr(g(r, "projectNo"));
    if (!projectNo) {
      // 空行跳过（不报错）
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
    const projectType = cellStr(g(r, "projectType"));

    // 发票（最多 2 张）
    const invoiceNos = splitInvoiceNos(g(r, "invoiceNo"));
    const invoices: LedgerInvoice[] = [];
    const amt1 = parseAmount(g(r, "invoiceAmount1"));
    if (amt1 != null && amt1 > 0) {
      invoices.push({
        amountCents: amt1,
        issuedAt: parseLedgerDate(g(r, "invoiceTime1")),
        invoiceNo: invoiceNos[0] ?? null,
      });
    }
    const amt2 = parseAmount(g(r, "invoiceAmount2"));
    if (amt2 != null && amt2 > 0) {
      invoices.push({
        amountCents: amt2,
        issuedAt: parseLedgerDate(g(r, "invoiceTime2")),
        invoiceNo: invoiceNos[invoices.length] ?? invoiceNos[1] ?? null,
      });
    }
    invoiceCount += invoices.length;

    // 到款（最多 2 笔）
    const receipts: LedgerReceipt[] = [];
    const rec1 = parseAmount(g(r, "receipt1"));
    if (rec1 != null && rec1 > 0) {
      receipts.push({
        amountCents: rec1,
        receivedAt: parseLedgerDate(g(r, "receiptTime1")),
        account: cellStr(g(r, "receiptAccount1")),
      });
    }
    const rec2 = parseAmount(g(r, "receipt2"));
    if (rec2 != null && rec2 > 0) {
      receipts.push({
        amountCents: rec2,
        receivedAt: parseLedgerDate(g(r, "receiptTime2")),
        account: cellStr(g(r, "receiptAccount2")),
      });
    }
    receiptCount += receipts.length;

    const parentProjectNo = cellStr(g(r, "parentRecord"));
    if (parentProjectNo) parentChildRows++;

    const isAdvanceSettlement = projectType === "预存款抵扣";
    if (isAdvanceSettlement) advanceSettlementRows++;

    const isPureCost =
      (projectAmountCents == null || projectAmountCents === 0) &&
      projectCostCents != null &&
      projectCostCents > 0;
    if (isPureCost) pureCostRows++;

    const receiptRemark = cellStr(g(r, "receiptRemark"));
    const isMergedReceipt = !!receiptRemark && receiptRemark.includes("合并到款");

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
      quantity: (() => {
        const q = g(r, "quantity");
        if (q == null || q === "") return null;
        const n = typeof q === "number" ? q : parseInt(String(q).replace(/[^\d-]/g, ""), 10);
        return isNaN(n) ? null : n;
      })(),
      procurementSource: cellStr(g(r, "procurementSource")),
      brand: cellStr(g(r, "brand")),
      progressRaw: cellStr(g(r, "progress")),
      status,
      progress,
      startDate: parseLedgerDate(g(r, "startDate")),
      deliveredAt: parseLedgerDate(g(r, "deliveredDate")),
      terminatedAt: parseLedgerDate(g(r, "terminatedDate")),
      projectAmountCents,
      projectCostCents,
      commissionPaidCents: parseAmount(g(r, "commissionPaid")),
      quarterlyBonusCents: parseAmount(g(r, "quarterlyBonus")),
      remark: cellStr(g(r, "remark")),
      sellerName: cleanSellerName(g(r, "sellerOrg")),
      buyerInvoiceOrgName: cellStr(g(r, "buyerInvoiceOrg")),
      invoices,
      receiptRemark,
      receipts,
      totalReceivableCents: parseAmount(g(r, "totalReceivable")),
      finalReceivableCents: parseAmount(g(r, "finalReceivable")),
      totalPayableCents: parseAmount(g(r, "totalPayable")),
      attachmentFileName: cellStr(g(r, "attachment")),
      parentProjectNo,
      isAdvanceSettlement,
      isPureCost,
      isMergedReceipt,
    });
  }

  // 父记录指向校验：父 projectNo 必须在本批次或留作 fallback warning
  for (const row of rows) {
    if (row.parentProjectNo && !seenProjectNos.has(row.parentProjectNo)) {
      warnings.push({
        row: row.rowIndex,
        message: `父记录 ${row.parentProjectNo} 不在本批次，commit 时将尝试查已存在订单，找不到则跳过该关联`,
      });
    }
  }

  return {
    rows,
    errors,
    warnings,
    summary: {
      totalRows: rows.length,
      projectCount: rows.length,
      invoiceCount,
      receiptCount,
      parentChildRows,
      pureCostRows,
      advanceSettlementRows,
      repsToBind: Array.from(repsToBind).sort(),
      newOrgCandidates: Array.from(newOrgCandidates).sort(),
    },
  };
}

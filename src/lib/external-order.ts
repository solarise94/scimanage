import type { PrismaClient } from "@prisma/client";
import { parse as csvParse } from "csv-parse/sync";
import iconv from "iconv-lite";

export interface NormalizedOrderRow {
  source: string;
  platform: string | null;
  externalOrderNo: string;
  merchantOrderNo: string | null;
  storeName: string | null;
  customerCode: string | null;
  orderType: string | null;
  receiverName: string | null;
  receiverPhone: string | null;
  receiverAddress: string | null;
  orderUser: string | null;
  orderUserTags: string | null;
  miniProgramId: string | null;
  productNamesRaw: string | null;
  productNamesJson: string | null;
  itemCount: number | null;
  itemTypeCount: number | null;
  orderAt: Date | null;
  paidAt: Date | null;
  scheduledDeliveryText: string | null;
  sellerMessage: string | null;
  merchantRemark: string | null;
  formNote: string | null;
  grossAmount: number | null;
  priceAdjustment: number | null;
  paidAmount: number | null;
  shippingFee: number | null;
  rawJson: string;
}

export interface ParseResult {
  rows: NormalizedOrderRow[];
  errors: Array<{ row: number; message: string }>;
}

export interface InvoicePrefill {
  contactName: string;
  buyerOrganizationName: string;
  invoiceType: string;
  contentSummary: string;
  remark: string;
  items: Array<{
    itemName: string;
    spec: string | null;
    unit: string | null;
    quantity: number | null;
    amount: number;
  }>;
}

/**
 * 通用订单表头 → NormalizedOrderRow 字段名别名表。
 * 同时被 parseOrderText（解析）和 import-parser-fingerprint.ts（AUTO 识别）共享，
 * 避免识别层与解析层漂移（§6.1 第 5 条）。禁止在别处复制本表。
 */
export const ORDER_HEADER_MAP: Record<string, string> = {
  "所属平台": "platform",
  "订单号": "externalOrderNo",
  "商户单号": "merchantOrderNo",
  "所属门店": "storeName",
  "客户编号": "customerCode",
  "客户编码": "customerCode",
  "客户号": "customerCode",
  "客户ID": "customerCode",
  "CRM客户编号": "customerCode",
  "CRM客户编码": "customerCode",
  "全部商品名称": "productNamesRaw",
  "商品总件数": "itemCount",
  "商品种类数": "itemTypeCount",
  "下单时间": "orderAt",
  "付款时间": "paidAt",
  "卖家留言": "sellerMessage",
  "商家备注": "merchantRemark",
  "预约配送时间": "scheduledDeliveryText",
  "订单类型": "orderType",
  "收件人": "receiverName",
  "收件人电话": "receiverPhone",
  "商品总额": "grossAmount",
  "下单用户": "orderUser",
  "下单用户标签": "orderUserTags",
  "小程序ID": "miniProgramId",
  "小程序用户ID": "miniProgramId",
  "下单用户ID": "miniProgramId",
  "用户openid": "miniProgramId",
  "openid": "miniProgramId",
  "备注/表单": "formNote",
  "收件人地址": "receiverAddress",
  "订单改价": "priceAdjustment",
  "订单实付金额": "paidAmount",
  "运费": "shippingFee",
};

function tryParseDate(s: string | undefined): Date | null {
  if (!s || !s.trim()) return null;
  const d = new Date(s.trim());
  return isNaN(d.getTime()) ? null : d;
}

function tryParseNumber(s: string | undefined): number | null {
  if (!s || !s.trim()) return null;
  const cleaned = s.replace(/[¥￥,，]/g, "").trim();
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
}

function tryParseInt(s: string | undefined): number | null {
  if (!s || !s.trim()) return null;
  const n = parseInt(s.trim(), 10);
  return isNaN(n) ? null : n;
}

function cleanCell(s: string): string {
  let v = s;
  if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
  v = v.replace(/""/g, '"');
  v = v.replace(/\t+$/, "");
  return v.trim();
}

function scoreHeaders(cells: string[]): number {
  return cells.filter((c) => ORDER_HEADER_MAP[cleanCell(c)] != null).length;
}

type DetectedFormat = { kind: "csv" } | { kind: "tsv" };

function detectFormat(rawText: string): DetectedFormat {
  const firstLine = rawText.split(/\r?\n/)[0] || "";

  let csvScore = 0;
  try {
    const parsed: string[][] = csvParse(firstLine + "\n", {
      relax_column_count: true,
      skip_empty_lines: true,
    });
    if (parsed.length > 0) csvScore = scoreHeaders(parsed[0]);
  } catch { /* not valid CSV */ }

  const tsvCells = firstLine.split("\t");
  const tsvScore = scoreHeaders(tsvCells);

  if (csvScore > 0 && csvScore >= tsvScore) return { kind: "csv" };
  if (tsvScore > 0) return { kind: "tsv" };
  // Both 0 hits — guess by structure
  if (firstLine.includes(",")) return { kind: "csv" };
  return { kind: "tsv" };
}

export interface FormatInfo {
  detected: "csv" | "tsv";
  headerHits: number;
  headerTotal: number;
  recognizedHeaders: string[];
}

function splitRows(rawText: string): { rows: string[][]; format: FormatInfo } {
  const fmt = detectFormat(rawText);

  let rows: string[][];
  if (fmt.kind === "csv") {
    const records: string[][] = csvParse(rawText, {
      relax_column_count: true,
      skip_empty_lines: true,
    });
    rows = records.map((row) => row.map(cleanCell));
  } else {
    rows = rawText
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .map((line) => line.split("\t").map((c) => cleanCell(c)));
  }

  const headers = rows[0] || [];
  const recognized = headers.filter((h) => ORDER_HEADER_MAP[h] != null);

  return {
    rows,
    format: {
      detected: fmt.kind,
      headerHits: recognized.length,
      headerTotal: headers.length,
      recognizedHeaders: recognized,
    },
  };
}

export function decodeImportFile(buffer: Buffer): string {
  if (buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) {
    return buffer.subarray(3).toString("utf-8");
  }
  if (buffer[0] === 0xFF && buffer[1] === 0xFE) {
    return iconv.decode(buffer.subarray(2), "utf-16le");
  }
  if (buffer[0] === 0xFE && buffer[1] === 0xFF) {
    return iconv.decode(buffer.subarray(2), "utf-16be");
  }
  const utf8 = buffer.toString("utf-8");
  if (!utf8.includes("�")) return utf8;
  return iconv.decode(buffer, "gb18030");
}

export interface ParseResultWithFormat extends ParseResult {
  format: FormatInfo;
}

export function parseOrderText(source: string, rawText: string): ParseResultWithFormat {
  const { rows: rows2d, format } = splitRows(rawText);

  if (rows2d.length < 2) {
    return { rows: [], errors: [{ row: 0, message: "无有效数据行" }], format };
  }

  if (format.headerHits === 0) {
    return {
      rows: [],
      errors: [{
        row: 1,
        message: `无法识别导入文件格式。检测到分隔符: ${format.detected}，识别到的表头: ${format.headerTotal > 0 ? rows2d[0].slice(0, 5).join(", ") + (format.headerTotal > 5 ? "..." : "") : "（空）"}`,
      }],
      format,
    };
  }

  const headers = rows2d[0];
  const fieldMap = headers.map((h) => ORDER_HEADER_MAP[h] || null);

  const rows: NormalizedOrderRow[] = [];
  const errors: Array<{ row: number; message: string }> = [];

  for (let i = 1; i < rows2d.length; i++) {
    const cols = rows2d[i];
    const raw: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      raw[headers[j]] = cols[j] || "";
    }

    const mapped: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      const field = fieldMap[j];
      if (field) mapped[field] = cols[j] || "";
    }

    if (!mapped.externalOrderNo) {
      errors.push({ row: i + 1, message: "缺少订单号" });
      continue;
    }

    const productNamesRaw = mapped.productNamesRaw || null;
    const productNames = productNamesRaw
      ? productNamesRaw.split(/[;；]/).map((s) => s.trim()).filter(Boolean)
      : [];

    rows.push({
      source,
      platform: mapped.platform || null,
      externalOrderNo: mapped.externalOrderNo,
      merchantOrderNo: mapped.merchantOrderNo || null,
      storeName: mapped.storeName || null,
      customerCode: mapped.customerCode || null,
      orderType: mapped.orderType || null,
      receiverName: mapped.receiverName || null,
      receiverPhone: mapped.receiverPhone || null,
      receiverAddress: mapped.receiverAddress || null,
      orderUser: mapped.orderUser || null,
      orderUserTags: mapped.orderUserTags || null,
      miniProgramId: mapped.miniProgramId || null,
      productNamesRaw,
      productNamesJson: productNames.length > 0 ? JSON.stringify(productNames) : null,
      itemCount: tryParseInt(mapped.itemCount),
      itemTypeCount: tryParseInt(mapped.itemTypeCount),
      orderAt: tryParseDate(mapped.orderAt),
      paidAt: tryParseDate(mapped.paidAt),
      scheduledDeliveryText: mapped.scheduledDeliveryText || null,
      sellerMessage: mapped.sellerMessage || null,
      merchantRemark: mapped.merchantRemark || null,
      formNote: mapped.formNote || null,
      grossAmount: tryParseNumber(mapped.grossAmount),
      priceAdjustment: tryParseNumber(mapped.priceAdjustment),
      paidAmount: tryParseNumber(mapped.paidAmount),
      shippingFee: tryParseNumber(mapped.shippingFee),
      rawJson: JSON.stringify(raw),
    });
  }

  return { rows, errors, format };
}

/** @deprecated Use parseOrderText instead */
export const parseTsvText = parseOrderText;

export function buildInvoicePrefillFromOrder(order: {
  receiverName: string | null;
  productNamesJson: string | null;
  productNamesRaw: string | null;
  itemCount: number | null;
  paidAmount: number | null;
  merchantRemark: string | null;
  formNote: string | null;
  scheduledDeliveryText: string | null;
  receiverAddress: string | null;
}): InvoicePrefill {
  const productNames: string[] = order.productNamesJson
    ? JSON.parse(order.productNamesJson)
    : [];

  let contentSummary: string;
  if (productNames.length === 1) {
    contentSummary = productNames[0];
  } else if (productNames.length > 1) {
    const preview = productNames.slice(0, 3).join("、");
    contentSummary = productNames.length <= 3 ? preview : `${preview}等`;
  } else {
    contentSummary = "商品销售";
  }

  const remarkParts = [
    order.merchantRemark,
    order.formNote,
    order.scheduledDeliveryText,
    order.receiverAddress,
  ].filter(Boolean);

  const itemName = productNames.length > 0
    ? productNames.join("、")
    : (order.productNamesRaw || "商品");

  return {
    contactName: order.receiverName || "",
    buyerOrganizationName: "",
    invoiceType: "NORMAL",
    contentSummary,
    remark: remarkParts.join("\n"),
    items: [{
      itemName,
      spec: null,
      unit: null,
      quantity: order.itemCount,
      amount: order.paidAmount || 0,
    }],
  };
}

export const DUPLICATE_STATUS = {
  UNREVIEWED: "UNREVIEWED",
  UNIQUE: "UNIQUE",
  DUPLICATE: "DUPLICATE",
  MERGED: "MERGED",
  IGNORED: "IGNORED",
} as const;

export const VALID_DUPLICATE_TRANSITIONS: Record<string, string[]> = {
  UNREVIEWED: ["UNIQUE", "DUPLICATE", "IGNORED"],
  UNIQUE: ["UNREVIEWED"],
  DUPLICATE: ["UNREVIEWED", "MERGED"],
  IGNORED: ["UNREVIEWED"],
  MERGED: [],
};

const STATUS_PRIORITY: Record<string, number> = {
  ISSUED: 4, REQUESTED: 3, DRAFT: 2, CANCELLED: 1, NONE: 0,
};

export async function syncOrderInvoiceStatus(
  prisma: PrismaClient,
  externalOrderId: string,
  orderId?: string | null,
): Promise<void> {
  // Direct invoices (via externalOrderId or orderId)
  const directInvoices = await prisma.externalOrderInvoiceRequest.findMany({
    where: {
      OR: [
        { externalOrderId },
        ...(orderId ? [{ orderId }] : []),
      ].filter(Boolean),
    },
    select: { status: true },
  });

  // Legacy coverage (via ExternalOrder)
  const legacyCoverageRecords = await prisma.externalOrderInvoiceCoverage.findMany({
    where: { externalOrderId },
    select: { invoiceRequest: { select: { status: true } } },
  });

  // New coverage (via Order)
  const newCoverageRecords = orderId ? await prisma.orderInvoiceCoverage.findMany({
    where: { orderId },
    select: { invoiceRequest: { select: { status: true } } },
  }) : [];

  const allStatuses = [
    ...directInvoices.map((i) => i.status),
    ...legacyCoverageRecords.map((c) => c.invoiceRequest.status),
    ...newCoverageRecords.map((c) => c.invoiceRequest.status),
  ];

  let highest = "NONE";
  for (const status of allStatuses) {
    if (status === "CANCELLED") continue;
    if ((STATUS_PRIORITY[status] || 0) > (STATUS_PRIORITY[highest] || 0)) {
      highest = status;
    }
  }

  // Update legacy ExternalOrder.invoiceStatus (new Orders don't have this field)
  const legacyExists = await prisma.externalOrder.count({ where: { id: externalOrderId } });
  if (legacyExists > 0) {
    await prisma.externalOrder.update({
      where: { id: externalOrderId },
      data: { invoiceStatus: highest },
    });
  }
}

// --- Dedup ---

export interface DuplicateGroup {
  groupKey: string;
  matchRule: string;
  confidence: number;
  orders: Array<{
    id: string;
    externalOrderNo: string;
    source: string;
    platform: string | null;
    receiverName: string | null;
    receiverPhone: string | null;
    paidAmount: number | null;
    orderAt: Date | null;
    productNamesRaw: string | null;
    duplicateStatus: string;
  }>;
}

function normalize(s: string | null): string {
  return (s || "").trim().toLowerCase().replace(/\s+/g, "");
}

function isClose(a: number | null, b: number | null, tolerance: number): boolean {
  if (a == null || b == null || a === 0 || b === 0) return false;
  return Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b)) <= tolerance;
}

function daysBetween(a: Date | null, b: Date | null): number | null {
  if (!a || !b) return null;
  return Math.abs(a.getTime() - b.getTime()) / (1000 * 60 * 60 * 24);
}

function productOverlap(a: string | null, b: string | null): number {
  if (!a || !b) return 0;
  const wordsA = new Set(a.split(/[,，;；、\s]+/).filter(Boolean));
  const wordsB = new Set(b.split(/[,，;；、\s]+/).filter(Boolean));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let overlap = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) overlap++;
  }
  return overlap / Math.min(wordsA.size, wordsB.size);
}

interface OrderPair {
  id: string;
  externalOrderNo: string;
  source: string;
  platform: string | null;
  merchantOrderNo: string | null;
  receiverName: string | null;
  receiverPhone: string | null;
  paidAmount: number | null;
  orderAt: Date | null;
  productNamesRaw: string | null;
  duplicateGroupId: string | null;
  duplicateStatus: string;
}

export async function computeDuplicateGroups(
  prisma: PrismaClient,
  forceScan: boolean,
): Promise<DuplicateGroup[]> {
  const orders = await prisma.externalOrder.findMany({
    where: { mergedIntoId: null },
    select: {
      id: true,
      externalOrderNo: true,
      source: true,
      platform: true,
      merchantOrderNo: true,
      receiverName: true,
      receiverPhone: true,
      paidAmount: true,
      orderAt: true,
      productNamesRaw: true,
      duplicateGroupId: true,
      duplicateStatus: true,
    },
  });

  // forceScan: re-scan UNREVIEWED orders only (skip manually reviewed ones)
  const manualStatuses = new Set(["UNIQUE", "IGNORED", "DUPLICATE", "MERGED"]);
  const reviewedIds = new Set(orders.filter((o) => manualStatuses.has(o.duplicateStatus)).map((o) => o.id));

  let ungrouped = orders.filter((o) => !o.duplicateGroupId && !reviewedIds.has(o.id));
  let rescanIds: string[] = [];
  if (forceScan) {
    // Also include UNREVIEWED orders that already have a group (re-scan them)
    rescanIds = orders.filter((o) => o.duplicateGroupId && o.duplicateStatus === "UNREVIEWED").map((o) => o.id);
    if (rescanIds.length > 0) {
      // Clear stale groupIds before re-scan
      await prisma.externalOrder.updateMany({
        where: { id: { in: rescanIds } },
        data: { duplicateGroupId: null },
      });
      ungrouped = [...ungrouped, ...orders.filter((o) => rescanIds.includes(o.id))];
    }
  }

  if (ungrouped.length === 0) {
    // Return existing groups
    const existing = orders.filter((o) => o.duplicateGroupId);
    return groupOrdersByKey(existing);
  }

  // Assign group slugs to ungrouped orders
  const ungroupedMutable = ungrouped.map((o) => ({ ...o, _group: "" })) as Array<OrderPair & { _group: string }>;
  const parent = new Map<string, string>();

  function find(k: string): string {
    let p = parent.get(k);
    while (p && parent.has(p)) {
      const gp = parent.get(p);
      if (!gp) break;
      p = gp;
    }
    return p || k;
  }

  function union(a: string, b: string) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }

  // Layer 1: Strong rules — same externalOrderNo across sources
  const byOrderNo = new Map<string, Array<typeof ungroupedMutable[0]>>();
  for (const o of ungroupedMutable) {
    const key = normalize(o.externalOrderNo);
    if (!byOrderNo.has(key)) byOrderNo.set(key, []);
    byOrderNo.get(key)!.push(o);
  }
  for (const [, group] of byOrderNo) {
    const distinctSources = new Set(group.map((o) => o.source));
    if (distinctSources.size > 1) {
      for (let i = 1; i < group.length; i++) union(group[0].id, group[i].id);
    }
  }

  // Layer 1 extra: merchantOrderNo matches another order's externalOrderNo
  for (const o of ungroupedMutable) {
    if (!o.merchantOrderNo) continue;
    const key = normalize(o.merchantOrderNo);
    const others = byOrderNo.get(key);
    if (others) {
      for (const other of others) {
        if (other.id !== o.id && other.source !== o.source) {
          union(o.id, other.id);
        }
      }
    }
  }

  // Layer 2: Weak rules
  for (let i = 0; i < ungroupedMutable.length; i++) {
    for (let j = i + 1; j < ungroupedMutable.length; j++) {
      const a = ungroupedMutable[i];
      const b = ungroupedMutable[j];
      if (a.source === b.source) continue;
      if (find(a.id) === find(b.id)) continue;

      let score = 0;
      const nameA = normalize(a.receiverName);
      const nameB = normalize(b.receiverName);
      const phoneA = normalize(a.receiverPhone);
      const phoneB = normalize(b.receiverPhone);

      if (nameA && nameA === nameB) {
        if (phoneA && phoneA === phoneB) {
          score = 0.9;
        } else if (isClose(a.paidAmount, b.paidAmount, 0.05) && daysBetween(a.orderAt, b.orderAt) !== null && daysBetween(a.orderAt, b.orderAt)! <= 7) {
          score = 0.7;
        } else {
          score = 0.4;
        }
      }
      if (score < 0.5 && phoneA && phoneA === phoneB && productOverlap(a.productNamesRaw, b.productNamesRaw) >= 0.5) {
        score = 0.6;
      }

      if (score >= 0.5) {
        union(a.id, b.id);
      }
    }
  }

  // Collect groups
  const groupMap = new Map<string, string[]>(); // rootId -> memberIds
  for (const o of ungroupedMutable) {
    const root = find(o.id);
    if (root !== o.id || parent.has(o.id)) {
      if (!groupMap.has(root)) groupMap.set(root, []);
      groupMap.get(root)!.push(o.id);
    }
  }

  // Persist groupIds
  const groupKeyMap = new Map<string, string>();
  for (const [root, members] of groupMap) {
    const all = [root, ...members];
    const groupKey = `dup_${all.sort().join("_").slice(0, 40)}`;
    for (const id of all) {
      groupKeyMap.set(id, groupKey);
    }
  }

  if (groupKeyMap.size > 0) {
    const updates: Array<Promise<unknown>> = [];
    for (const [id, gk] of groupKeyMap) {
      updates.push(
        prisma.externalOrder.update({
          where: { id },
          data: { duplicateGroupId: gk, duplicateStatus: "UNREVIEWED" },
        }),
      );
    }
    await Promise.all(updates);
  }

  // Merge existing + new groups and return
  // For orders that were scanned (ungrouped + rescanIds), only use newly assigned groupId;
  // orders not in this scan preserve their existing duplicateGroupId.
  const scannedIds = new Set(ungrouped.map((o) => o.id));
  if (rescanIds.length > 0) for (const rid of rescanIds) scannedIds.add(rid);

  const allOrders = orders.map((o) => ({
    ...o,
    duplicateGroupId: scannedIds.has(o.id)
      ? (groupKeyMap.get(o.id) || null)
      : o.duplicateGroupId,
  }));
  return groupOrdersByKey(allOrders);
}

function groupOrdersByKey(orders: Array<{ duplicateGroupId: string | null } & OrderPair>): DuplicateGroup[] {
  const map = new Map<string, DuplicateGroup>();
  for (const o of orders) {
    const gk = o.duplicateGroupId;
    if (!gk) continue;
    if (!map.has(gk)) {
      map.set(gk, {
        groupKey: gk,
        matchRule: "auto",
        confidence: 0.8,
        orders: [],
      });
    }
    const { duplicateGroupId: _gid, ...rest } = o;
    void _gid;
    map.get(gk)!.orders.push(rest);
  }
  return Array.from(map.values()).filter((g) => g.orders.length > 1);
}

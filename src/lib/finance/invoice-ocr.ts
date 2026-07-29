/**
 * 发票专用确定性 OCR 字段抽取。
 *
 * 只从 GLM-OCR markdown 抽取票面事实；不复用银行回单字段规则，
 * 不用订单/申请金额反向填补，不根据名称猜税号。
 */

import {
  GLM_OCR_MODEL,
  GlmOcrClientError,
  isGlmOcrConfigured,
  parseDocumentWithGlmOcr,
} from "@/lib/finance/glm-ocr-client";
import {
  claimStagingForAnalysis,
  completeStagingAnalysis,
  failStagingAnalysis,
  getOwnedStagingFile,
  INVOICE_STAGING_MAX_BYTES,
  InvoiceStagingError,
  verifyStagingFileIntegrity,
} from "@/lib/finance/invoice-staging";

export type ExtractedInvoiceType = "NORMAL" | "SPECIAL" | "UNKNOWN";

export type ExtractedIssuedInvoice = {
  schemaVersion: 1;
  invoiceNumber: string | null;
  invoiceCode: string | null;
  issuedAt: string | null;
  sellerName: string | null;
  sellerTaxId: string | null;
  buyerName: string | null;
  buyerTaxId: string | null;
  invoiceType: ExtractedInvoiceType;
  totalAmountCents: number | null;
  amountExcludingTaxCents: number | null;
  taxAmountCents: number | null;
  itemNames: string[];
  isRedInvoice: boolean | null;
  source: "GLM_OCR";
  model: typeof GLM_OCR_MODEL;
  analyzedAt: string;
  warnings: string[];
};

export class InvoiceOcrError extends Error {
  code: string;
  httpStatus: number;

  constructor(code: string, message: string, httpStatus: number) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
    this.name = "InvoiceOcrError";
  }
}

export function maskTaxId(taxId: string | null | undefined): string | null {
  if (!taxId) return null;
  const normalized = normalizeTaxId(taxId);
  if (!normalized) return null;
  if (normalized.length <= 6) return `${normalized.slice(0, 2)}****`;
  return `${normalized.slice(0, 4)}****${normalized.slice(-4)}`;
}

export function normalizeTaxId(value: string | null | undefined): string {
  return (value || "").replace(/\s+/g, "").toUpperCase();
}

export function normalizeInvoiceNumber(value: string | null | undefined): string | null {
  if (value == null) return null;
  const cleaned = value.replace(/[\s\-_.]/g, "").trim();
  return cleaned || null;
}

function normalizePartyName(value: string | null | undefined): string {
  return (value || "")
    .replace(/\s+/g, "")
    .replace(/[（(].*?[）)]/g, "")
    .replace(/(有限责任公司|股份有限公司|有限公司|集团|大学|医院)/g, "")
    .trim()
    .toLowerCase();
}

export { normalizePartyName };

/** UTC 年月日回读校验，拒绝 2026-02-31 等非法日。 */
export function toValidUtcIsoDate(yRaw: string, moRaw: string, dRaw: string): string | null {
  const y = Number(yRaw);
  const mo = Number(moRaw);
  const d = Number(dRaw);
  if (!Number.isInteger(y) || !Number.isInteger(mo) || !Number.isInteger(d)) return null;
  if (y < 1990 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    return null;
  }
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function yuanStringToCents(raw: string): number | null {
  const cleaned = raw.replace(/,/g, "").replace(/[￥¥元]/g, "").trim();
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(cleaned)) return null;
  const negative = cleaned.startsWith("-");
  const abs = cleaned.replace(/^-/, "");
  const [intPart, fracPart = ""] = abs.split(".");
  const frac = (fracPart + "00").slice(0, 2);
  const cents = Number(intPart) * 100 + Number(frac);
  if (!Number.isFinite(cents)) return null;
  return negative ? -cents : cents;
}

function pickLabeledValue(text: string, labels: string[]): string | null {
  const labelAlt = labels.map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const patterns = [
    new RegExp(`(?:${labelAlt})\\s*[:：]\\s*([^\\n|]+)`, "i"),
    new RegExp(`(?:${labelAlt})\\s+([^\\n|]+)`, "i"),
    // Markdown table cell: | 发票号码 | 123 |
    new RegExp(`\\|\\s*(?:${labelAlt})\\s*\\|\\s*([^|\\n]+)\\s*\\|`, "i"),
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (!m?.[1]) continue;
    const value = m[1].replace(/\*+/g, "").trim();
    if (value && value !== "-" && value !== "—") return value;
  }
  return null;
}

function pickInvoiceNumber(text: string, warnings: string[]): string | null {
  const labeled = pickLabeledValue(text, ["发票号码", "发票号", "Invoice Number", "发票编号"]);
  if (labeled) {
    const original = labeled.trim();
    const normalized = normalizeInvoiceNumber(original);
    if (normalized && normalized !== original.replace(/\s+/g, "")) {
      warnings.push(`发票号已去空格/分隔符：原值「${original.slice(0, 40)}」`);
    }
    return normalized;
  }
  // 电子发票常见：20 位数字发票号码
  const m = text.match(/(?<![0-9])(\d{20})(?![0-9])/);
  if (m?.[1]) return m[1];
  const m8 = text.match(/(?<![0-9])(\d{8})(?![0-9])/);
  if (m8?.[1] && /发票/.test(text)) return m8[1];
  warnings.push("未能识别发票号码");
  return null;
}

function pickInvoiceCode(text: string): string | null {
  const labeled = pickLabeledValue(text, ["发票代码", "Invoice Code"]);
  if (!labeled) return null;
  const digits = labeled.replace(/\D/g, "");
  return digits || null;
}

function pickIssuedAt(text: string, warnings: string[]): string | null {
  const labeled = pickLabeledValue(text, ["开票日期", "开具日期", "Invoice Date"]);
  const sources = [labeled, text].filter(Boolean) as string[];
  for (const src of sources) {
    const m = src.match(/(\d{4})\s*[年./-]\s*(\d{1,2})\s*[月./-]\s*(\d{1,2})/);
    if (!m) continue;
    const iso = toValidUtcIsoDate(m[1], m[2], m[3]);
    if (iso) return iso;
    warnings.push(`开票日期无效或无法校验：${m[0]}`);
  }
  warnings.push("未能识别开票日期");
  return null;
}

function pickTaxIdNearLabel(text: string, partyLabels: string[]): string | null {
  const partyAlt = partyLabels.map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const blockRe = new RegExp(
    `(?:${partyAlt})[\\s\\S]{0,220}?(?:纳税人识别号|税号|统一社会信用代码)\\s*[:：]?\\s*([0-9A-Za-z]{15,20})`,
    "i",
  );
  const m = text.match(blockRe);
  if (m?.[1]) return normalizeTaxId(m[1]);

  // Table layout: party header then tax id on nearby lines
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!(new RegExp(partyAlt)).test(lines[i])) continue;
    for (let j = i; j < Math.min(i + 8, lines.length); j++) {
      const tax = lines[j].match(/(?:纳税人识别号|税号|统一社会信用代码)\s*[:：]?\s*([0-9A-Za-z]{15,20})/i);
      if (tax?.[1]) return normalizeTaxId(tax[1]);
      const loose = lines[j].match(/\b([0-9A-Z]{15,20})\b/i);
      if (loose?.[1] && /税|识别/.test(lines[j])) return normalizeTaxId(loose[1]);
    }
  }
  return null;
}

function pickPartyName(text: string, labels: string[]): string | null {
  const labeled = pickLabeledValue(text, labels);
  if (!labeled) return null;
  const cleaned = labeled
    .replace(/(?:纳税人识别号|税号|地址|电话|开户行|账号).*$/i, "")
    .replace(/[|｜].*$/, "")
    .trim();
  if (cleaned.length < 2 || cleaned.length > 120) return null;
  return cleaned.slice(0, 120);
}

function pickAmountCents(
  text: string,
  labels: string[],
  warnings: string[],
  warningLabel: string,
): number | null {
  const labeled = pickLabeledValue(text, labels);
  if (labeled) {
    const cents = yuanStringToCents(labeled);
    if (cents != null) return cents;
    warnings.push(`${warningLabel}格式无效`);
  }
  return null;
}

function detectInvoiceType(text: string): ExtractedInvoiceType {
  if (/增值税专用发票|专用发票|专票/.test(text) && !/普通发票|电子普通/.test(text.slice(0, 80))) {
    if (/增值税专用发票|专用发票/.test(text)) return "SPECIAL";
  }
  if (/增值税普通发票|普通发票|电子发票\(普通发票\)|普票/.test(text)) return "NORMAL";
  if (/专用发票|专票/.test(text) && !/普通/.test(text)) return "SPECIAL";
  if (/普通发票|普票/.test(text)) return "NORMAL";
  return "UNKNOWN";
}

function detectRedInvoice(text: string): boolean | null {
  if (/红字|负数发票|红票|信息表编号/.test(text)) return true;
  if (/价税合计[^\n]{0,20}-\s*\d/.test(text)) return true;
  // Explicit blue/normal wording without red markers → false; otherwise unknown
  if (/蓝字|正数/.test(text)) return false;
  return null;
}

function detectMultipleInvoices(text: string): boolean {
  const numbers = text.match(/(?:发票号码|发票号)\s*[:：]?\s*[0-9A-Za-z\-_\s]{8,}/g);
  if (numbers && numbers.length >= 2) {
    const normalized = new Set(
      numbers
        .map((n) => normalizeInvoiceNumber(n.replace(/^.*[:：]?/, "")))
        .filter(Boolean),
    );
    if (normalized.size >= 2) return true;
  }
  // Multiple "发票联" / page title markers for separate invoices
  const titles = text.match(/电子发票|增值税[专普]用发票/g);
  return Boolean(titles && titles.length >= 3);
}

function pickItemNames(text: string): string[] {
  const names: string[] = [];
  const projectSection = text.match(/(?:项目名称|货物或应税劳务|商品名称)[^\n]*\n([\s\S]{0,800})/);
  if (projectSection?.[1]) {
    for (const line of projectSection[1].split(/\r?\n/).slice(0, 12)) {
      const cleaned = line.replace(/^[#*\-\s|]+/, "").replace(/\|.*$/, "").trim();
      if (!cleaned || cleaned.length < 2 || cleaned.length > 80) continue;
      if (/^[0-9.]+$/.test(cleaned)) continue;
      if (/合计|税额|税率|金额|数量|单价|单位|规格/.test(cleaned)) continue;
      names.push(cleaned);
      if (names.length >= 5) break;
    }
  }
  return names;
}

function isPlausibleTaxId(taxId: string | null): boolean {
  if (!taxId) return false;
  return /^[0-9A-Z]{15}$|^[0-9A-Z]{17}$|^[0-9A-Z]{18}$|^[0-9A-Z]{20}$/.test(taxId);
}

/**
 * 从 OCR markdown 确定性提取发票字段。
 */
export function extractInvoiceFields(ocrText: string): ExtractedIssuedInvoice {
  const warnings: string[] = [];
  const text = (ocrText || "").trim();
  if (!text) {
    throw new InvoiceOcrError("INVOICE_OCR_EMPTY_RESULT", "没有可解析的 OCR 文本", 422);
  }

  if (detectMultipleInvoices(text)) {
    throw new InvoiceOcrError(
      "INVOICE_OCR_MULTIPLE_INVOICES",
      "单个文件似乎包含多张独立发票，请拆分后重试",
      422,
    );
  }

  const invoiceNumber = pickInvoiceNumber(text, warnings);
  const invoiceCode = pickInvoiceCode(text);
  const issuedAt = pickIssuedAt(text, warnings);
  const buyerName = pickPartyName(text, ["购买方名称", "购买方", "买方名称", "购方名称", "Buyer"]);
  const sellerName = pickPartyName(text, ["销售方名称", "销售方", "销方名称", "Seller"]);
  const buyerTaxId = pickTaxIdNearLabel(text, ["购买方", "买方", "购方"]);
  const sellerTaxId = pickTaxIdNearLabel(text, ["销售方", "销方"]);

  if (buyerTaxId && !isPlausibleTaxId(buyerTaxId)) {
    warnings.push("购方税号格式可疑，已保留但需人工核对");
  }
  if (sellerTaxId && !isPlausibleTaxId(sellerTaxId)) {
    warnings.push("销方税号格式可疑，已保留但需人工核对");
  }
  if (!buyerTaxId) warnings.push("未能识别购方税号");
  if (!sellerTaxId) warnings.push("未能识别销方税号");
  if (!buyerName) warnings.push("未能识别购方名称");
  if (!sellerName) warnings.push("未能识别销方名称");

  const totalAmountCents = pickAmountCents(
    text,
    ["价税合计", "价税合计（小写）", "价税合计(小写)", "合计金额", "价税合计小写"],
    warnings,
    "价税合计",
  );
  const amountExcludingTaxCents = pickAmountCents(
    text,
    ["合计金额", "金额合计", "不含税金额", "金额"],
    warnings,
    "不含税金额",
  );
  const taxAmountCents = pickAmountCents(
    text,
    ["合计税额", "税额合计", "税额"],
    warnings,
    "税额",
  );

  if (totalAmountCents == null) warnings.push("未能识别价税合计");

  if (
    totalAmountCents != null
    && amountExcludingTaxCents != null
    && taxAmountCents != null
  ) {
    const delta = Math.abs(amountExcludingTaxCents + taxAmountCents - totalAmountCents);
    if (delta > 1) {
      warnings.push(
        `金额关系不一致：不含税+税额与价税合计相差 ${delta} 分`,
      );
    }
  }

  const invoiceType = detectInvoiceType(text);
  if (invoiceType === "UNKNOWN") warnings.push("未能可靠识别票种（普票/专票）");

  const isRedInvoice = detectRedInvoice(text);
  if (isRedInvoice === true) {
    warnings.push("检测到红字/负数发票特征");
  }

  const itemNames = pickItemNames(text);

  const hasAnyCore =
    invoiceNumber
    || issuedAt
    || totalAmountCents != null
    || buyerTaxId
    || sellerTaxId
    || buyerName
    || sellerName;

  if (!hasAnyCore) {
    throw new InvoiceOcrError("INVOICE_OCR_PARSE_FAILED", "无法从 OCR 文本形成有效发票结构", 422);
  }

  return {
    schemaVersion: 1,
    invoiceNumber,
    invoiceCode,
    issuedAt,
    sellerName,
    sellerTaxId,
    buyerName,
    buyerTaxId,
    invoiceType,
    totalAmountCents,
    amountExcludingTaxCents,
    taxAmountCents,
    itemNames,
    isRedInvoice,
    source: "GLM_OCR",
    model: GLM_OCR_MODEL,
    analyzedAt: new Date().toISOString(),
    warnings,
  };
}

export async function ocrInvoiceBuffer(
  buffer: Buffer,
  mimeType: string,
  signal?: AbortSignal,
): Promise<{ extracted: ExtractedIssuedInvoice; rawText: string }> {
  if (!isGlmOcrConfigured()) {
    throw new InvoiceOcrError("INVOICE_OCR_NOT_CONFIGURED", "未启用发票 OCR（缺少 ZHIPU_API_KEY）", 503);
  }

  let parseResult;
  try {
    parseResult = await parseDocumentWithGlmOcr(buffer, mimeType, signal, {
      maxBytes: INVOICE_STAGING_MAX_BYTES,
    });
  } catch (err) {
    if (err instanceof GlmOcrClientError) {
      throw new InvoiceOcrError(err.code, err.message, err.httpStatus);
    }
    throw err;
  }

  const extracted = extractInvoiceFields(parseResult.rawText);
  if (parseResult.truncated) {
    extracted.warnings.push("OCR 原文超过长度上限，已截断保存");
  }
  return { extracted, rawText: parseResult.rawText };
}

export type AnalyzeStagedInvoiceResult = {
  staging: {
    id: string;
    fileName: string;
    status: "ANALYZED";
    sha256: string;
    version: number;
  };
  extracted: {
    invoiceNumber: string | null;
    issuedAt: string | null;
    buyerName: string | null;
    buyerTaxIdMasked: string | null;
    sellerName: string | null;
    sellerTaxIdMasked: string | null;
    invoiceType: ExtractedInvoiceType;
    totalAmountCents: number | null;
    isRedInvoice: boolean | null;
    warnings: string[];
  };
  match: {
    status: string;
    candidates: Array<{
      invoiceRequestId: string;
      orderNo: string | null;
      orderTitle: string | null;
      projectName: string | null;
      buyerOrganizationName: string;
      totalAmountCents: number;
      invoiceType: string;
      score: number;
      reasons: string[];
      conflicts: string[];
      canSelect: boolean;
    }>;
    duplicate?: {
      kind: string;
      invoiceRequestId: string;
      actualInvoiceNo: string | null;
    };
  };
};

/**
 * 对私有 staging 执行 OCR + 候选匹配，并写回分析结果。
 * 绝不调用 registerIssuedInvoiceDocument。
 */
export async function analyzeStagedInvoice(opts: {
  userId: string;
  stagingFileId: string;
  expectedSha256: string;
  expectedStagingVersion: number;
  forceRetry?: boolean;
  signal?: AbortSignal;
}): Promise<AnalyzeStagedInvoiceResult> {
  const staging = await getOwnedStagingFile({
    stagingFileId: opts.stagingFileId,
    userId: opts.userId,
    requireActive: true,
  });

  if (staging.status !== "UPLOADED" && staging.status !== "ANALYZED") {
    throw new InvoiceStagingError(
      "INVOICE_STAGING_CHANGED",
      `staging 状态不可分析: ${staging.status}`,
      409,
    );
  }

  // forceRetry 仍必须通过所有权、hash、TTL、状态校验（claim 内完成）。
  void opts.forceRetry;

  const buffer = await verifyStagingFileIntegrity({
    staging,
    expectedSha256: opts.expectedSha256,
    expectedVersion: opts.expectedStagingVersion,
  });

  const claim = await claimStagingForAnalysis({
    stagingFileId: opts.stagingFileId,
    userId: opts.userId,
    expectedSha256: opts.expectedSha256,
    expectedVersion: opts.expectedStagingVersion,
  });
  if (!claim.claimed) {
    throw new InvoiceStagingError("INVOICE_STAGING_CHANGED", "staging 已被其他分析占用或已变化", 409);
  }

  const started = Date.now();
  try {
    const { extracted, rawText } = await ocrInvoiceBuffer(buffer, staging.mimeType, opts.signal);

    if (extracted.isRedInvoice === true) {
      // Still persist analysis so UI can show RED block; match returns CONFLICT.
    }

    const { matchInvoiceRequests } = await import("@/lib/finance/invoice-request-matcher");
    const match = await matchInvoiceRequests({
      extracted,
      stagingSha256: staging.sha256,
    });

    const persisted = {
      schemaVersion: 1 as const,
      extracted,
      match: {
        status: match.status,
        candidateIds: match.candidates.map((c) => c.invoiceRequestId),
        topScore: match.candidates[0]?.score ?? null,
        duplicate: match.duplicate ?? null,
      },
    };

    const row = await completeStagingAnalysis({
      stagingFileId: opts.stagingFileId,
      userId: opts.userId,
      expectedSha256: opts.expectedSha256,
      extractedJson: JSON.stringify(persisted),
      ocrRawText: rawText,
      ocrWarningsJson: JSON.stringify(extracted.warnings),
    });

    console.info(
      `[invoice-ocr] analyzed staging=${opts.stagingFileId.slice(0, 8)} mime=${staging.mimeType} size=${staging.fileSize} sha=${staging.sha256.slice(0, 12)} elapsedMs=${Date.now() - started} match=${match.status}`,
    );

    return {
      staging: {
        id: row.id,
        fileName: row.originalFileName,
        status: "ANALYZED",
        sha256: row.sha256,
        version: row.version,
      },
      extracted: {
        invoiceNumber: extracted.invoiceNumber,
        issuedAt: extracted.issuedAt,
        buyerName: extracted.buyerName,
        buyerTaxIdMasked: maskTaxId(extracted.buyerTaxId),
        sellerName: extracted.sellerName,
        sellerTaxIdMasked: maskTaxId(extracted.sellerTaxId),
        invoiceType: extracted.invoiceType,
        totalAmountCents: extracted.totalAmountCents,
        isRedInvoice: extracted.isRedInvoice,
        warnings: extracted.warnings,
      },
      match: {
        status: match.status,
        candidates: match.candidates,
        ...(match.duplicate ? { duplicate: match.duplicate } : {}),
      },
    };
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err
        ? String((err as { code: string }).code)
        : "INVOICE_OCR_PROVIDER_ERROR";
    const message = err instanceof Error ? err.message : "OCR 失败";
    await failStagingAnalysis({
      stagingFileId: opts.stagingFileId,
      userId: opts.userId,
      expectedSha256: opts.expectedSha256,
      errorSummary: `${code}: ${message}`.slice(0, 200),
    });
    console.warn(
      `[invoice-ocr] failed staging=${opts.stagingFileId.slice(0, 8)} code=${code} elapsedMs=${Date.now() - started}`,
    );
    throw err;
  }
}


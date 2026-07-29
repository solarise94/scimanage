/**
 * 智谱 GLM-OCR（layout_parsing）— 银行到款回单识别。
 *
 * 传输层见 glm-ocr-client.ts；本模块只保留银行回单字段抽取。
 * 发票字段抽取见 invoice-ocr.ts，禁止复用本文件的字段规则。
 */

import {
  isGlmOcrConfigured,
  parseDocumentWithGlmOcr,
} from "@/lib/finance/glm-ocr-client";

export { isGlmOcrConfigured };

export type GlmOcrVoucherFields = {
  payerName: string | null;
  /** 元，两位小数语义；UI 直接填入金额输入框 */
  amountYuan: number | null;
  /** YYYY-MM-DD */
  receivedAt: string | null;
  remark: string | null;
};

export type GlmOcrParseResult = {
  fields: GlmOcrVoucherFields;
  rawText: string;
  warnings: string[];
};

// ─── Field extraction (rule-based on OCR markdown) ───────────────

const CN_NUM: Record<string, number> = {
  零: 0, 〇: 0, 壹: 1, 贰: 2, 两: 2, 叁: 3, 肆: 4,
  伍: 5, 陆: 6, 柒: 7, 捌: 8, 玖: 9,
};

function parseChineseAmount(raw: string): number | null {
  const s = raw.replace(/整$/, "").replace(/圆/g, "元");
  if (!/[元]/.test(s) && !/角|分/.test(s)) return null;

  let yuan = 0;
  let section = 0;
  let num = 0;
  let sawYuanOrFraction = false;
  const units: Record<string, number> = { 拾: 10, 佰: 100, 仟: 1000 };
  const big: Record<string, number> = { 万: 10000, 亿: 100000000 };

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch in CN_NUM) {
      num = CN_NUM[ch];
    } else if (ch in units) {
      section += (num || 1) * units[ch];
      num = 0;
    } else if (ch in big) {
      section += num;
      yuan += section * big[ch];
      section = 0;
      num = 0;
    } else if (ch === "元") {
      section += num;
      yuan += section;
      section = 0;
      num = 0;
      sawYuanOrFraction = true;
    } else if (ch === "角") {
      yuan += (num || 0) * 0.1;
      num = 0;
      sawYuanOrFraction = true;
    } else if (ch === "分") {
      yuan += (num || 0) * 0.01;
      num = 0;
      sawYuanOrFraction = true;
    }
  }
  if (!sawYuanOrFraction) {
    yuan += section + num;
  }
  if (!Number.isFinite(yuan) || yuan <= 0) return null;
  return Math.round(yuan * 100) / 100;
}

function pickAmountYuan(text: string): { value: number | null; warning?: string } {
  const lines = text.split(/\r?\n/);
  const candidates: number[] = [];

  const labeled =
    /(?:交易金额|付款金额|到账金额|入账金额|金额|小写|￥|¥)\s*[:：]?\s*[￥¥]?\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?|[0-9]+(?:\.[0-9]{1,2})?)/g;
  let m: RegExpExecArray | null;
  while ((m = labeled.exec(text)) !== null) {
    const n = parseFloat(m[1].replace(/,/g, ""));
    if (Number.isFinite(n) && n > 0) candidates.push(Math.round(n * 100) / 100);
  }

  if (candidates.length === 0) {
    const loose = /[￥¥]?\s*([0-9]{1,3}(?:,[0-9]{3})+\.[0-9]{2}|[0-9]+\.[0-9]{2})\b/g;
    while ((m = loose.exec(text)) !== null) {
      const n = parseFloat(m[1].replace(/,/g, ""));
      if (Number.isFinite(n) && n > 0 && n < 1e9) candidates.push(Math.round(n * 100) / 100);
    }
  }

  if (candidates.length === 0) {
    for (const line of lines) {
      if (/大写|人民币/.test(line) || /[壹贰叁肆伍陆柒捌玖拾佰仟万亿]/.test(line)) {
        const cn = parseChineseAmount(line.replace(/.*?(人民币|大写金额|金额大写)[:：\s]*/, ""));
        if (cn != null) candidates.push(cn);
      }
    }
  }

  if (candidates.length === 0) return { value: null, warning: "未能识别金额" };
  const freq = new Map<number, number>();
  for (const c of candidates) freq.set(c, (freq.get(c) || 0) + 1);
  const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  return { value: sorted[0][0] };
}

/** 校验日历日：拒绝 JS Date 自动归一化（如 2026-02-31 → 3 月）。 */
function toValidIsoDate(yRaw: string, moRaw: string, dRaw: string): string | null {
  const y = Number(yRaw);
  const mo = Number(moRaw);
  const d = Number(dRaw);
  if (!Number.isInteger(y) || !Number.isInteger(mo) || !Number.isInteger(d)) return null;
  if (y < 1990 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function pickDate(text: string): { value: string | null; warning?: string } {
  const patterns: RegExp[] = [
    /((?:交易|记账|到账|入账|付款)?日期)\s*[:：]?\s*(\d{4})[年./-](\d{1,2})[月./-](\d{1,2})/,
    /(\d{4})[年./-](\d{1,2})[月./-](\d{1,2})/,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (!m) continue;
    let y: string, mo: string, d: string;
    if (m.length >= 5 && m[2] && m[3] && m[4] && !/^\d{4}$/.test(m[1] || "")) {
      y = m[2];
      mo = m[3];
      d = m[4];
    } else if (m.length >= 4) {
      y = m[1];
      mo = m[2];
      d = m[3];
    } else continue;
    const iso = toValidIsoDate(y, mo, d);
    if (iso) return { value: iso };
  }
  return { value: null, warning: "未能识别到款日期" };
}

function pickPayerName(text: string): { value: string | null; warning?: string } {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/^[#*\-\s]+/, "").trim())
    .filter(Boolean);

  const labelRes = [
    /(?:付款人(?:名称|全称)?|付款单位|付款账户名称|付方户名|汇款人(?:名称)?|转出方|对方户名|对方名称|账户名称)\s*[:：]?\s*(.+)$/,
    /(?:付款人(?:名称|全称)?|付款单位)\s+(.+)$/,
  ];

  for (const line of lines) {
    for (const re of labelRes) {
      const m = line.match(re);
      if (!m?.[1]) continue;
      let name = m[1].trim();
      name = name.replace(/\s+\d{6,}.*$/, "").replace(/[|｜].*$/, "").trim();
      if (!name || name.length < 2) continue;
      if (/银行|信用社|支行|金额|日期|账号|卡号/.test(name) && name.length < 6) continue;
      if (/^\d/.test(name)) continue;
      return { value: name.slice(0, 80) };
    }
  }

  for (const line of lines) {
    if (/(?:有限公司|股份公司|大学|医院|研究所|研究院|中心|学院)/.test(line) && line.length <= 40) {
      if (/收款|收款人|入账|本方/.test(line)) continue;
      const cleaned = line.replace(/^.*?(?:付款人|付款单位|汇款人)\s*[:：]?\s*/, "").trim();
      if (cleaned.length >= 2) return { value: cleaned.slice(0, 80) };
    }
  }

  return { value: null, warning: "未能识别付款单位" };
}

/**
 * 从 OCR markdown 抽取凭证字段（规则启发式，结果必须人工可改）。
 */
export function extractVoucherFields(ocrText: string): GlmOcrVoucherFields & { warnings: string[] } {
  const warnings: string[] = [];
  const amount = pickAmountYuan(ocrText);
  const date = pickDate(ocrText);
  const payer = pickPayerName(ocrText);
  if (amount.warning) warnings.push(amount.warning);
  if (date.warning) warnings.push(date.warning);
  if (payer.warning) warnings.push(payer.warning);

  let remark: string | null = null;
  const purpose = ocrText.match(/(?:摘要|用途|附言|备注)\s*[:：]?\s*(.+)/);
  if (purpose?.[1]) {
    remark = purpose[1].trim().slice(0, 120);
  }

  return {
    payerName: payer.value,
    amountYuan: amount.value,
    receivedAt: date.value,
    remark,
    warnings,
  };
}

/**
 * 一站式：图片 → OCR → 字段。
 *
 * 计费语义：至少一次（at-least-once）。GLM layout_parsing 无供应商侧幂等键，
 * 无法保证 exactly-once；调用方应在结果 CAS 落盘后再视为完成。
 */
export async function ocrVoucherImage(
  buffer: Buffer,
  mimeType: string,
  signal?: AbortSignal,
): Promise<GlmOcrParseResult> {
  const { rawText } = await parseDocumentWithGlmOcr(buffer, mimeType, signal);
  const extracted = extractVoucherFields(rawText);
  const { warnings, ...fields } = extracted;
  return { fields, rawText, warnings };
}

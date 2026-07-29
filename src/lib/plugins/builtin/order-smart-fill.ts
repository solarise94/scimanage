import { registerPlugin } from "../registry";
import type { FormDraftPlugin, FormDraftResult } from "../types";
import { parseSmartFill } from "@/lib/smart-fill";
import { normalizeProjectType } from "@/lib/project-type";

type OrderLineDraft = {
  itemName: string;
  spec: string;
  unit: string;
  quantity: number;
  unitPrice: number;
  amount: number;
};

function parseAmount(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const cleaned = value.replace(/[¥￥,\s元]/g, "").trim();
  if (!cleaned) return undefined;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : undefined;
}

function parseDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = value.match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  if (!match) return undefined;
  return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
}

function readLabeledValue(lines: string[], labels: string[]): string | undefined {
  for (const line of lines) {
    const normalized = line.trim();
    if (!normalized) continue;
    const parts = normalized.split(/[:：\t]/);
    if (parts.length >= 2) {
      const key = parts[0].trim();
      const value = parts.slice(1).join(":").trim();
      if (value && labels.some((label) => key.includes(label))) return value;
    }
    for (const label of labels) {
      if (!normalized.startsWith(label)) continue;
      const value = normalized.slice(label.length).replace(/^[\s:：,，-]+/, "").trim();
      if (value) return value;
    }
  }
  return undefined;
}

function parseQuantity(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = value.match(/(\d+)/);
  if (!match) return undefined;
  const n = Number(match[1]);
  return n > 0 ? n : undefined;
}

function buildLine(itemName: string, spec: string, unit: string, quantity: number, unitPrice: number, amount: number): OrderLineDraft {
  return { itemName, spec, unit, quantity, unitPrice, amount };
}

const orderSmartFill: FormDraftPlugin = {
  manifest: {
    key: "order.smart-fill",
    name: "订单智能填写",
    description: "从粘贴文本中解析订单标题、客户快照、金额和明细",
    capability: "form-draft",
    formKeys: ["order.create"],
  },
  async execute(input: string): Promise<FormDraftResult> {
    const text = input.trim();
    if (!text) throw new Error("请输入文本内容");

    const fields: Record<string, unknown> = {};
    const inputLines = text.split(/\n/).map((line) => line.trim()).filter(Boolean);

    try {
      const projectLike = parseSmartFill(text);
      const title = projectLike.name || projectLike.projectContent;
      const amount = projectLike.budgetAmount;
      const quantity = projectLike.quantity && projectLike.quantity > 0 ? projectLike.quantity : 1;

      if (title) fields.title = title;
      if (projectLike.description) fields.description = projectLike.description;
      if (projectLike.client) {
        fields.buyerNameSnapshot = projectLike.client;
        fields.customer = { name: projectLike.client, matched: false };
      }
      if (projectLike.organization) fields.buyerOrgNameSnapshot = projectLike.organization;
      if (projectLike.startDate) fields.orderedAt = projectLike.startDate;
      if (projectLike.projectType) fields.category = normalizeProjectType(projectLike.projectType) === "商品" ? "PRODUCT" : "SERVICE";
      if (amount != null) fields.totalAmount = amount;

      // Supplement project fields (non-derivable, user/AI to fill)
      if (projectLike.projectType) fields.projectType = normalizeProjectType(projectLike.projectType);
      if (projectLike.procurementSource) fields.procurementSource = projectLike.procurementSource;
      if (projectLike.brand) fields.brand = projectLike.brand;
      if (projectLike.techSupport) fields.techSupport = projectLike.techSupport;
      if (projectLike.budgetCost != null) fields.budgetCost = projectLike.budgetCost;

      // Structured parse lines with quantity/unitPrice from columns
      const lineName = projectLike.projectContent || title || "订单服务";
      const structuredSpec = projectLike.projectType || projectLike.brand || "";
      if (lineName) {
        const safeQty = quantity > 0 ? quantity : 1;
        fields.lines = [buildLine(lineName, structuredSpec, "项", safeQty, amount ? amount / safeQty : 0, amount ?? 0)];
      }
    } catch {
      // Continue with loose label parsing below.
    }

    // ── Loose label parsing ──────────────────────────────────────────
    const SECTION_HEADERS = ["立项信息", "项目信息", "订单信息", "客户信息", "基本信息"];
    const title =
      readLabeledValue(inputLines, ["订单标题", "订单名称", "项目名称", "服务内容", "内容"]) ||
      (inputLines.length > 0 &&
       !inputLines[0].includes("：") && !inputLines[0].includes(":") &&
       !SECTION_HEADERS.includes(inputLines[0])
        ? inputLines[0] : undefined);
    const buyerName = readLabeledValue(inputLines, ["客户", "客户姓名", "收件人", "姓名", "购买人"]);
    const buyerPhone = readLabeledValue(inputLines, ["电话", "手机号", "手机", "联系方式"]);
    const buyerWechat = readLabeledValue(inputLines, ["微信", "下单用户"]);
    const buyerOrg = readLabeledValue(inputLines, ["单位", "机构", "学校", "医院", "公司", "单位信息"]);
    const buyerAddress = readLabeledValue(inputLines, ["地址", "收货地址"]);
    const orderedAt = parseDate(readLabeledValue(inputLines, ["下单日期", "日期", "时间"]));
    const totalAmount = parseAmount(readLabeledValue(inputLines, ["项目总额", "总金额", "金额", "价格", "费用", "合计"]));
    const cost = parseAmount(readLabeledValue(inputLines, ["项目成本", "成本", "预算成本", "采购成本", "进货成本"]));
    const unitPrice = parseAmount(readLabeledValue(inputLines, ["项目单价", "单价", "服务单价", "测序单价"]));
    const parsedQuantity = parseQuantity(readLabeledValue(inputLines, ["送样例数", "样本数量", "样本数", "例数", "数量"]));
    const sampleType = readLabeledValue(inputLines, ["样本类型", "样本"]);
    const projectType = readLabeledValue(inputLines, ["项目类型", "服务类型"]);

    // ── Fill top-level fields ────────────────────────────────────────
    if (!fields.title && title) fields.title = title;
    if (!fields.buyerNameSnapshot && buyerName) {
      fields.buyerNameSnapshot = buyerName;
      fields.customer = { name: buyerName, matched: false };
    }
    if (!fields.buyerPhoneSnapshot && buyerPhone) fields.buyerPhoneSnapshot = buyerPhone;
    if (!fields.buyerWechatSnapshot && buyerWechat) fields.buyerWechatSnapshot = buyerWechat;
    if (!fields.buyerOrgNameSnapshot && buyerOrg) fields.buyerOrgNameSnapshot = buyerOrg;
    if (!fields.buyerAddressSnapshot && buyerAddress) fields.buyerAddressSnapshot = buyerAddress;
    if (!fields.orderedAt && orderedAt) fields.orderedAt = orderedAt;
    if (totalAmount != null) fields.totalAmount = totalAmount;
    if (!fields.category) fields.category = "SERVICE";
    if (!fields.projectType && projectType) fields.projectType = normalizeProjectType(projectType);
    if (sampleType) fields.sampleType = sampleType;
    if (parsedQuantity != null) fields.quantity = parsedQuantity;
    if (unitPrice != null) fields.unitPrice = unitPrice;
    if (cost != null) fields.budgetCost = cost;

    // ── Build order lines ────────────────────────────────────────────
    if (!fields.lines) {
      const qty = parsedQuantity || 1;
      const up = unitPrice ?? (totalAmount && qty ? totalAmount / qty : 0);
      const amt = totalAmount ?? up * qty;
      const quantityLabel = readLabeledValue(inputLines, ["送样例数", "样本数量", "样本数", "例数", "数量"]);
      const unit = quantityLabel && /例/.test(quantityLabel) ? "例" : "项";
      const itemName = String(fields.projectType || fields.title || title || "订单服务");
      const spec = sampleType || "";
      fields.lines = [buildLine(itemName, spec, unit, qty, up, amt)];
    }

    // ── Title fallback from parsed values ────────────────────────────
    if (!fields.title) {
      const lineItemName = (fields.lines as Array<Record<string, unknown>>)?.[0]?.itemName;
      if (lineItemName && typeof lineItemName === "string" && lineItemName !== "订单服务") {
        fields.title = lineItemName;
      } else if (projectType) {
        fields.title = normalizeProjectType(projectType);
      }
    }

    // Fill totalAmount from line sum if not already set
    if (fields.totalAmount == null && fields.lines) {
      const lineSum = (fields.lines as Array<Record<string, unknown>>).reduce((s, l) => s + (Number(l.amount) || 0), 0);
      if (lineSum > 0) fields.totalAmount = lineSum;
    }

    const warnings: string[] = [];
    if (!fields.title) warnings.push("未能解析出订单标题");
    if (fields.totalAmount == null) warnings.push("未能解析出订单金额");

    return {
      summary: fields.title ? `解析到订单：${fields.title}` : "解析完成，部分字段可能缺失",
      warnings: warnings.length > 0 ? warnings : undefined,
      draft: { fields },
    };
  },
};

registerPlugin(orderSmartFill);

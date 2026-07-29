/**
 * T8.2a - 合同草稿准备与生成预览 application service。
 *
 * Shared by Agent contracts.prepare_draft（execute）与 contracts.generate（buildProposal）。
 * 收敛 contracts.ts 内散落的订单加载/同买方校验/买方字段解析/默认模板与卖方推断/
 * 买方覆盖映射等 helper，确保 prepare 与 generate 共用同一套规则。
 *
 * - 仅 ADMIN/USER 可生成（canGenerateContract）；销售角色 -> ForbiddenError。
 * - 全量订单存在且未删除、全在 actor scope（loadOrdersForContractAction）。
 * - 同一结构化买方（assertSameBuyer -> ValidationError 保留 CROSS_BUYER 前缀）。
 * - 模板可用（未归档）；类别适配仅 warning 不阻止（C6 决策）。
 * - seller billing profile 存在且未归档。
 * - 金额/行项取当前数据库事实；已有合同只产提示不阻止。
 * - proposalId 非业务幂等键；intent 按 owner+digest 复用，存完整 normalized input。
 */
import type { BusinessActor } from "@/lib/application/actor";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/application/errors";
import { prisma } from "@/lib/prisma";
import { getOrderScopeWhere } from "@/lib/orders/permissions";
import { canGenerateContract } from "@/lib/contracts/permissions";
import { CONTRACT_CATEGORY } from "@/lib/contracts/constants";
import { amountToChineseWords } from "@/lib/contracts/amount-in-words";
import { assertSameBuyer, CONTRACT_ORDER_INCLUDE, sortOrdersByInputIds, type ContractOrder } from "@/lib/contracts/generate";
import { centsToYuan } from "@/lib/finance/money";
import { formatCentsAsYuanLabel } from "@/lib/finance/money";
import { prepareOrReuseGenerationIntent } from "@/lib/contracts/generation-intent";
import { loadValidCoverageByOrderId } from "@/lib/contracts/application/check-contract-coverage";
import {
  buildNormalizedContractInput,
  assertIntentInputUnchanged,
  loadOwnedActiveIntentForActor,
} from "@/lib/contracts/application/contract-generation-intent";

// ─── 买方覆盖字段 ───────────────────────────────────────────────────────────

export interface BuyerOverridesInput {
  buyerName?: string;
  buyerOrgName?: string;
  buyerTaxId?: string;
  buyerAddress?: string;
  buyerPhone?: string;
  buyerEmail?: string;
}

/** 映射到 generateContract() 的 GenerateInput 覆盖字段命名（...Override 后缀）。 */
export function buyerOverridesToGenerateFields(overrides: BuyerOverridesInput) {
  return {
    buyerNameOverride: overrides.buyerName,
    buyerOrgNameOverride: overrides.buyerOrgName,
    buyerTaxIdOverride: overrides.buyerTaxId,
    buyerAddressOverride: overrides.buyerAddress,
    buyerPhoneOverride: overrides.buyerPhone,
    buyerEmailOverride: overrides.buyerEmail,
  };
}

/** normalizedInput.buyerOverrides：剔除空值（generation-intent 内部再排序 key）。 */
export function buyerOverridesToRecord(overrides: BuyerOverridesInput): Record<string, string> {
  const record: Record<string, string> = {};
  for (const [key, value] of Object.entries(overrides)) {
    if (value) record[key] = value;
  }
  return record;
}

// ─── 订单加载与校验 ─────────────────────────────────────────────────────────

/**
 * §2.4 合同 Scope 规则：全量校验调用者对 orderIds 的每一笔都有访问权限。
 * 返回按 orderIds 顺序排列的订单（首项即 primaryOrderId），供 assertSameBuyer / buildBuyerFields 使用。
 * scope 内缺失 -> ForbiddenError（无权访问）；ADMIN（无 scope）缺失 -> ValidationError（不存在/已删除）。
 */
export async function loadOrdersForContractAction(
  orderIds: string[],
  actor: BusinessActor,
): Promise<ContractOrder[]> {
  const scopeWhere = await getOrderScopeWhere(actor.userId, actor.role, prisma, actor.department);
  const orders = await prisma.order.findMany({
    where: { AND: [scopeWhere ?? {}, { id: { in: orderIds } }, { deleted: false }] },
    include: CONTRACT_ORDER_INCLUDE,
  });
  if (orders.length !== orderIds.length) {
    if (scopeWhere) {
      throw new ForbiddenError(
        `部分订单不存在、已删除或无权访问（请求 ${orderIds.length} 笔，可访问 ${orders.length} 笔）`,
      );
    }
    throw new ValidationError(
      `部分订单不存在或已删除（请求 ${orderIds.length} 笔，找到 ${orders.length} 笔）`,
    );
  }
  // 与 generateContract（preflight/事务内重载）同口径重排，统一排序实现防漂移（P2 修复）
  return sortOrdersByInputIds(orders, orderIds);
}

/** §2.3 同买方校验；将 generate.ts 的纯 Error 转换为 ValidationError（保留 CROSS_BUYER 前缀）。 */
export function assertSameBuyerChecked(orders: ContractOrder[]): void {
  try {
    assertSameBuyer(orders);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("CROSS_BUYER_ORDERS")) {
      throw new ValidationError(err.message);
    }
    throw err;
  }
}

/** 买方字段解析链：覆盖 -> 机构(org) -> 客户档案(profile) -> 订单快照，与 generate.ts buildTemplateData 对齐。 */
export function buildBuyerFields(order: ContractOrder, overrides: BuyerOverridesInput) {
  const profile = order.profile;
  const org = profile?.org;
  const buyerName = overrides.buyerName || profile?.name || order.buyerNameSnapshot || "";
  const buyerOrgName =
    overrides.buyerOrgName || org?.canonicalName || profile?.organization || order.buyerOrgNameSnapshot || "";
  const buyerTaxId = overrides.buyerTaxId || org?.taxId || "";
  const buyerAddress =
    overrides.buyerAddress || org?.address || profile?.address || order.buyerAddressSnapshot || "";
  const buyerPhone = overrides.buyerPhone || order.buyerPhoneSnapshot || "";
  const buyerEmail = overrides.buyerEmail || profile?.email || "";
  return { buyerName, buyerOrgName, buyerTaxId, buyerAddress, buyerPhone, buyerEmail };
}

/** Order.category（SERVICE/PRODUCT/MIXED/UNKNOWN）-> ContractTemplate.category 推断。 */
export function inferContractCategoryFromOrder(orderCategory: string): string {
  if (orderCategory === "SERVICE") return CONTRACT_CATEGORY.SEQUENCING;
  if (orderCategory === "PRODUCT") return CONTRACT_CATEGORY.EQUIPMENT;
  return CONTRACT_CATEGORY.OTHER;
}

/** 默认模板：按首单类别推断 category，优先 isDefault，否则该类别下最新模板；均无则 null（要求显式指定）。 */
async function resolveDefaultTemplate(orderCategory: string) {
  const inferredCategory = inferContractCategoryFromOrder(orderCategory);
  const preferred = await prisma.contractTemplate.findFirst({
    where: { category: inferredCategory, archived: false, isDefault: true },
  });
  if (preferred) return preferred;
  return prisma.contractTemplate.findFirst({
    where: { category: inferredCategory, archived: false },
    orderBy: { createdAt: "desc" },
  });
}

/** 默认开票主体：仅当存在唯一 isDefault && !archived 的 BillingProfile 时才自动选用；否则要求显式指定。 */
async function resolveDefaultSellerProfile() {
  const profiles = await prisma.billingProfile.findMany({
    where: { isDefault: true, archived: false },
  });
  return profiles.length === 1 ? profiles[0] : null;
}

// ─── prepare draft ──────────────────────────────────────────────────────────

export type PrepareDraftInput = {
  orderIds: string[];
  templateId?: string;
  sellerProfileId?: string;
  buyerOverrides?: BuyerOverridesInput;
  remark?: string;
};

export type PrepareDraftResult = {
  generationIntentId: string;
  inputDigest: string;
  template: { id: string; name: string; category: string; isDefault: boolean };
  sellerProfile: { id: string; name: string; taxId: string };
  buyerFields: ReturnType<typeof buildBuyerFields>;
  totalAmountCents: number;
  totalAmountInWords: string;
  lineCount: number;
  coveredOrders: Array<{ orderId: string; orderNo: string; title: string }>;
  primaryOrderId: string;
  warnings: string[];
};

export async function prepareContractDraftForActor(
  actor: BusinessActor,
  input: PrepareDraftInput,
): Promise<PrepareDraftResult> {
  if (!canGenerateContract(actor.role)) {
    throw new ForbiddenError();
  }

  const orders = await loadOrdersForContractAction(input.orderIds, actor);
  assertSameBuyerChecked(orders);
  const primaryOrder = orders[0];

  // 解析模板（显式 or 默认推断）
  let template: { id: string; name: string; category: string; isDefault: boolean } | null = null;
  if (input.templateId) {
    template = await prisma.contractTemplate.findFirst({
      where: { id: input.templateId, archived: false },
    });
    if (!template) throw new NotFoundError("模板不存在或已归档");
  } else {
    template = await resolveDefaultTemplate(primaryOrder.category);
    if (!template) {
      throw new ValidationError("未指定模板，且无法按订单类别推断默认模板，请显式提供 templateId");
    }
  }

  // 解析开票主体（显式 or 默认）
  let sellerProfile: { id: string; name: string; taxId: string | null; archived: boolean } | null = null;
  if (input.sellerProfileId) {
    sellerProfile = await prisma.billingProfile.findUnique({ where: { id: input.sellerProfileId } });
    if (!sellerProfile || sellerProfile.archived) {
      throw new NotFoundError("开票主体不存在或已归档");
    }
  } else {
    sellerProfile = await resolveDefaultSellerProfile();
    if (!sellerProfile) {
      throw new ValidationError("未指定开票主体，且没有唯一的默认开票主体，请显式提供 sellerProfileId");
    }
  }

  const buyerFields = buildBuyerFields(primaryOrder, input.buyerOverrides ?? {});
  const totalCents = orders.reduce((sum, order) => sum + (order.totalAmount || 0), 0);

  // §2.2.2 构建规范化输入 -> 创建/复用 generation intent
  const normalizedInput = buildNormalizedContractInput({
    orderIds: input.orderIds,
    templateId: template.id,
    sellerProfileId: sellerProfile.id,
    buyerOverrides: buyerOverridesToRecord(input.buyerOverrides ?? {}),
    remark: input.remark,
  });
  const { generationIntentId, inputDigest } = await prepareOrReuseGenerationIntent({
    ownerUserId: actor.userId,
    normalizedInput,
  });

  // 数据质量提示
  const warnings: string[] = [];
  if (!buyerFields.buyerTaxId) warnings.push("买方税号缺失，合同将留空");
  if (!buyerFields.buyerOrgName) warnings.push("买方单位名称缺失，合同将留空");
  for (const order of orders) {
    if (!order.totalAmount) warnings.push(`订单 ${order.orderNo} 金额为 0`);
  }
  // C6：模板类别适配仅 warning 不阻止（显式指定跨类模板是合理操作）
  const inferredCategory = inferContractCategoryFromOrder(primaryOrder.category);
  if (template.category !== inferredCategory) {
    warnings.push(
      `模板类别「${template.category}」与订单推断类别「${inferredCategory}」不一致，请确认`,
    );
  }
  const coverageMap = await loadValidCoverageByOrderId(orders.map((order) => order.id));
  for (const order of orders) {
    const existing = coverageMap.get(order.id);
    if (existing && existing.length > 0) {
      warnings.push(`订单 ${order.orderNo} 已有合同 ${existing.map((c) => c.contractNo).join("、")}，将重复覆盖`);
    }
  }

  return {
    generationIntentId,
    inputDigest,
    template: { id: template.id, name: template.name, category: template.category, isDefault: template.isDefault },
    sellerProfile: { id: sellerProfile.id, name: sellerProfile.name, taxId: sellerProfile.taxId ?? "" },
    buyerFields,
    totalAmountCents: totalCents,
    totalAmountInWords: amountToChineseWords(centsToYuan(totalCents)),
    lineCount: orders.length,
    coveredOrders: orders.map((order) => ({ orderId: order.id, orderNo: order.orderNo, title: order.title })),
    primaryOrderId: primaryOrder.id,
    warnings,
  };
}

// ─── generate 预览（proposal card 构造） ─────────────────────────────────────

export type GenerateCommandInput = {
  generationIntentId: string;
  orderIds: string[];
  templateId: string;
  sellerProfileId: string;
  buyerOverrides?: BuyerOverridesInput;
  remark?: string;
};

export type GenerateContractPreview = {
  title: string;
  summary: string;
  target: { type: "order"; id: string };
  proposalInput: Record<string, unknown>;
  displayProps: Record<string, string | null>;
};

/**
 * contracts.generate 的 buildProposal：重新校验当前事实（不信 proposal 冻结内容），
 * 加载 intent 并比对 digest，构造 proposal card。
 * execute（T8.2b）会再次重新校验。
 */
export async function previewGenerateContractForActor(
  actor: BusinessActor,
  input: GenerateCommandInput,
): Promise<GenerateContractPreview> {
  if (!canGenerateContract(actor.role)) {
    throw new ForbiddenError();
  }

  const orders = await loadOrdersForContractAction(input.orderIds, actor);
  assertSameBuyerChecked(orders);
  const primaryOrder = orders[0];

  const template = await prisma.contractTemplate.findFirst({
    where: { id: input.templateId, archived: false },
  });
  if (!template) throw new NotFoundError("模板不存在或已归档");

  const sellerProfile = await prisma.billingProfile.findUnique({ where: { id: input.sellerProfileId } });
  if (!sellerProfile || sellerProfile.archived) {
    throw new NotFoundError("开票主体不存在或已归档");
  }

  const intent = await loadOwnedActiveIntentForActor(actor, input.generationIntentId);
  const normalizedInput = buildNormalizedContractInput({
    orderIds: input.orderIds,
    templateId: input.templateId,
    sellerProfileId: input.sellerProfileId,
    buyerOverrides: buyerOverridesToRecord(input.buyerOverrides ?? {}),
    remark: input.remark,
  });
  assertIntentInputUnchanged(intent, normalizedInput);

  const buyerFields = buildBuyerFields(primaryOrder, input.buyerOverrides ?? {});
  const totalCents = orders.reduce((sum, order) => sum + (order.totalAmount || 0), 0);
  const buyerLabel = buyerFields.buyerOrgName || buyerFields.buyerName || "未知买方";

  return {
    title: `生成合同：${template.name}`,
    summary:
      `将为 ${orders.length} 笔订单生成合同（模板「${template.name}」，卖方「${sellerProfile.name}」，`
      + `买方「${buyerLabel}」，金额 ${formatCentsAsYuanLabel(totalCents)}）。合同编号将在执行时生成（格式 HT-YYYYMMDD-xxx）。`,
    target: { type: "order", id: primaryOrder.id },
    proposalInput: {
      generationIntentId: input.generationIntentId,
      orderIds: input.orderIds,
      templateId: input.templateId,
      sellerProfileId: input.sellerProfileId,
      buyerOverrides: input.buyerOverrides,
      remark: input.remark,
      // 展示字段：不影响 parseInput（未在其读取字段白名单内会被忽略）
      totalAmountCents: totalCents,
      coveredOrderCount: orders.length,
    },
    displayProps: {
      templateName: template.name,
      buyerName: buyerFields.buyerName || null,
      buyerOrgName: buyerFields.buyerOrgName || null,
      sellerName: sellerProfile.name,
      totalAmount: formatCentsAsYuanLabel(totalCents),
      coveredOrderCount: String(orders.length),
    },
  };
}

/**
 * T2.2a — shared create-order preparation (no formal writes).
 *
 * Web `POST /api/orders` and Agent `orders.create` must call this before any
 * Order/Project write. Capability, active profile, authoritative customer
 * context, and input normalization live here once.
 */
import { prisma } from "@/lib/prisma";
import type { BusinessActor } from "@/lib/application/actor";
import {
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "@/lib/application/errors";
import { resolveCustomerBusinessContext } from "@/lib/business/customer-context";
import { findActiveProfile } from "@/lib/crm/ids";
import {
  ORDER_CATEGORY,
  ORDER_STATUS,
  OrderCategoryValidationError,
  assertValidOrderCategory,
  type OrderCategory,
  type OrderStatus,
} from "@/lib/orders/constants";
import type { CreateOrderLineInput, CreateOrderPayload } from "@/lib/orders/create-order-with-project";
import { yuanToCents } from "@/lib/finance/money";
import { resolveTechSupportDefault } from "@/lib/tech-support";

export type PrepareCreateOrderLineRaw = {
  itemName: string;
  spec?: string | null;
  unit?: string | null;
  quantity?: number | null;
  unitPrice?: number | null;
  /** Interpreted per `moneyUnit`. */
  amount: number;
  /**
   * Phase 1：真实 ProductSku id。新业务（Web/Agent）必填；
   * 服务端在 prepare 内校验 active+sellable 并生成展示/编号快照，
   * 客户端不可伪造 itemName/spec/unit（会以 SKU 事实覆盖）。
   * 历史导入的自由文本行可省略，落 OrderLine 但不创建目录绑定。
   */
  productSkuId?: string | null;
};

export type PrepareCreateOrderInput = {
  title: string;
  description?: string | null;
  category?: string | null;
  status?: string | null;
  orderedAt?: string | Date | null;
  profileId: string;
  /**
   * Client-supplied representative / buyerOrganizationId are intentionally
   * ignored for formal FKs — authority comes only from CRM profile context.
   */
  representativeId?: string | null;
  buyerOrganizationId?: string | null;
  lines?: PrepareCreateOrderLineRaw[] | null;
  totalAmount?: number | null;
  /** How numeric money fields on this input are denominated. */
  moneyUnit: "yuan" | "cents";
  projectAction?: "GENERATE" | "LINK" | null;
  projectId?: string | null;
  financeTreatment?: string | null;
  financeNote?: string | null;
  buyerNameSnapshot?: string | null;
  buyerPhoneSnapshot?: string | null;
  buyerWechatSnapshot?: string | null;
  buyerOrgNameSnapshot?: string | null;
  buyerAddressSnapshot?: string | null;
  /** 订单技术支持（订单主权字段）。为空时内部员工默认当前操作者。 */
  techSupport?: string | null;
  projectDraft?: Record<string, unknown> | null;
  initialCost?: number | null;
  initialCostType?: string | null;
  initialCostRemark?: string | null;
  source?: string | null;
  sourcePlatform?: string | null;
  sourceRemark?: string | null;
  externalOrderNo?: string | null;
  merchantOrderNo?: string | null;
  orderNoRefDate?: Date | null;
  confirmedAt?: string | Date | null;
  deliveredAt?: string | Date | null;
  customerMatchStatus?: string | null;
  customerMatchScore?: number | null;
  customerMatchReason?: string | null;
  buyerMiniProgramIdSnapshot?: string | null;
};

export type PreparedCreateOrder = {
  /** Payload ready for `createOrderWithProject` (amounts in cents). */
  payload: CreateOrderPayload;
  /** Convenience flags for adapters (retry / CRM). */
  meta: {
    profileId: string;
    profileName: string;
    orderCategory: OrderCategory;
    orderStatus: OrderStatus;
    projectAction: "GENERATE" | "LINK" | null;
    autoProjectNoInDraft: boolean;
    totalAmountCents: number;
  };
};

function assertCanCreateOrder(actor: BusinessActor): void {
  if (actor.role !== "ADMIN") {
    throw new ForbiddenError("仅管理员可创建订单");
  }
}

function toCents(value: number, moneyUnit: "yuan" | "cents"): number {
  if (!Number.isFinite(value)) {
    throw new ValidationError("金额必须是有效数字");
  }
  return moneyUnit === "yuan" ? yuanToCents(value) : Math.round(value);
}

/** Formal buyer snapshot: CRM authority only; empty CRM → null (never client/import text). */
function crmOnlySnapshot(authority: string | null | undefined): string | null {
  const a = typeof authority === "string" ? authority.trim() : "";
  return a || null;
}

function assertValidOrderStatus(raw: string): asserts raw is OrderStatus {
  const allowed = Object.values(ORDER_STATUS) as string[];
  if (!allowed.includes(raw)) {
    throw new ValidationError(
      `订单状态无效：${raw}（允许 ${allowed.join(" / ")}）`,
    );
  }
}

/**
 * Normalize and authorize a create-order intent. Does not write Order/Project.
 */
export async function prepareCreateOrderForActor(
  actor: BusinessActor,
  input: PrepareCreateOrderInput,
): Promise<PreparedCreateOrder> {
  assertCanCreateOrder(actor);

  const title = input.title?.trim();
  if (!title) {
    throw new ValidationError("title is required");
  }

  const profileIdRaw = input.profileId?.trim();
  if (!profileIdRaw) {
    throw new ValidationError("订单必须关联客户，请先选择或新建客户（profileId 必填）");
  }

  const active = await findActiveProfile(profileIdRaw);
  if (!active) {
    throw new ValidationError("指定的客户不存在或已归档");
  }

  const ctx = await resolveCustomerBusinessContext(active.profileId);
  if (!ctx.profileId) {
    throw new ValidationError("指定的客户不存在或已归档");
  }

  // Formal org FK: only from CRM. Reject client attempts to forge a different org.
  if (
    input.buyerOrganizationId &&
    input.buyerOrganizationId.trim() &&
    ctx.organizationId &&
    input.buyerOrganizationId.trim() !== ctx.organizationId
  ) {
    throw new ValidationError("购买方单位必须以客户档案绑定为准，请先在 CRM 完成单位绑定");
  }
  if (
    input.representativeId &&
    input.representativeId.trim() &&
    ctx.representativeId &&
    input.representativeId.trim() !== ctx.representativeId
  ) {
    throw new ValidationError("代表必须以客户档案有效代表为准，请先在 CRM 完成代表绑定");
  }

  let orderCategory: OrderCategory;
  try {
    const candidate =
      typeof input.category === "string" && input.category.trim()
        ? input.category.trim()
        : ORDER_CATEGORY.SERVICE;
    assertValidOrderCategory(candidate);
    orderCategory = candidate;
  } catch (e) {
    if (e instanceof OrderCategoryValidationError) {
      throw new ValidationError(e.message);
    }
    throw e;
  }

  const orderStatusRaw =
    typeof input.status === "string" && input.status.trim() ? input.status.trim() : ORDER_STATUS.DRAFT;
  assertValidOrderStatus(orderStatusRaw);
  const orderStatus: OrderStatus = orderStatusRaw;

  const rawLines = Array.isArray(input.lines) ? input.lines : [];
  // Phase 1：对带 productSkuId 的行，服务端校验 active+sellable 并以 SKU 事实生成展示/编号快照。
  // 客户端不可伪造 itemName/spec/unit——有 productSkuId 时一律以 SKU 覆盖。
  //
  // P1 修正（review #2）：区分新业务与 legacy import。
  //  - 新业务（source=MANUAL 的 Web/API、Agent 草稿）：每行必须带 productSkuId；
  //    不允许自由文本行绕过产品目录。
  //  - legacy import（source=OTHER_IMPORT/PINGOODMICE）：允许自由文本行（历史数据无 SKU），
  //    落 OrderLine 但不创建目录绑定，进入未映射治理队列。
  const effectiveSource = input.source?.toString().trim() || "MANUAL";
  const LEGACY_IMPORT_SOURCES = new Set(["OTHER_IMPORT", "PINGOODMICE"]);
  const isLegacyImport = LEGACY_IMPORT_SOURCES.has(effectiveSource);
  if (!isLegacyImport && rawLines.length > 0) {
    const linesWithoutSku = rawLines.filter((l) => !l?.productSkuId?.toString().trim());
    if (linesWithoutSku.length > 0) {
      throw new ValidationError(
        `新业务订单每行必须绑定产品 SKU（productSkuId）；检测到 ${linesWithoutSku.length} 行未绑定。` +
          `历史导入请使用 source=OTHER_IMPORT。`,
      );
    }
  }
  const skuIds = Array.from(
    new Set(
      rawLines
        .map((l) => l?.productSkuId?.toString().trim())
        .filter((v): v is string => !!v),
    ),
  );
  const skuMap = new Map<string, {
    id: string;
    skuCode: string;
    name: string;
    spec: string | null;
    standardUnit: string;
    status: string;
    sellable: boolean;
    product: { id: string; productCode: string; name: string };
  }>();
  if (skuIds.length > 0) {
    const skus = await prisma.productSku.findMany({
      where: { id: { in: skuIds } },
      include: { product: { select: { id: true, productCode: true, name: true } } },
    });
    for (const s of skus) skuMap.set(s.id, s);
  }
  const lineItems: CreateOrderLineInput[] = rawLines
    .filter((l) => l?.itemName?.toString().trim() || l?.productSkuId)
    .map((l, i) => {
      const amountCents = toCents(Number(l.amount) || 0, input.moneyUnit);
      const skuId = l.productSkuId?.toString().trim() || null;
      const sku = skuId ? skuMap.get(skuId) : null;
      if (skuId && !sku) {
        throw new ValidationError(`产品 SKU 不存在：${skuId}`);
      }
      if (sku && (sku.status !== "ACTIVE" || !sku.sellable)) {
        throw new ValidationError(`产品 SKU 不可销售：${sku.skuCode}`);
      }
      return {
        // 有 SKU 时以 SKU 名称覆盖（防客户端伪造）；无 SKU 时用传入 itemName（历史自由文本）
        itemName: sku ? sku.name : String(l.itemName).trim(),
        spec: sku ? sku.spec : (l.spec?.toString().trim() || null),
        unit: sku ? sku.standardUnit : (l.unit?.toString().trim() || null),
        quantity: l.quantity != null ? Number(l.quantity) : null,
        unitPrice:
          l.unitPrice != null ? toCents(Number(l.unitPrice), input.moneyUnit) : null,
        amount: amountCents,
        category: orderCategory,
        sortOrder: i,
        productSkuId: sku ? sku.id : null,
        productCodeSnapshot: sku ? sku.product.productCode : null,
        skuCodeSnapshot: sku ? sku.skuCode : null,
      };
    });

  const totalAmountCents =
    lineItems.length > 0
      ? lineItems.reduce((s, l) => s + (Number(l.amount) || 0), 0)
      : toCents(Number(input.totalAmount) || 0, input.moneyUnit);

  const projectAction =
    input.projectAction === "GENERATE" || input.projectAction === "LINK"
      ? input.projectAction
      : null;

  if (projectAction === "GENERATE" && !ctx.profileId) {
    throw new ValidationError("生成项目需要先选择或新建客户");
  }

  if (projectAction === "LINK") {
    const projectId = input.projectId?.trim();
    if (!projectId) {
      throw new ValidationError("绑定已有项目需要提供项目ID");
    }
    const linkTarget = await prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true },
    });
    if (!linkTarget) {
      throw new NotFoundError("指定的项目不存在");
    }
  }

  const techSupport = resolveTechSupportDefault(input.techSupport, {
    role: actor.role,
    name: actor.name,
    email: actor.email,
  });
  if (!techSupport) {
    throw new ValidationError("订单必须提供技术支持");
  }

  const draft: Record<string, unknown> = { ...(input.projectDraft || {}) };
  if (projectAction === "GENERATE") {
    // Project only copies the order-owned value during generation.
    draft.techSupport = techSupport;
  }
  const autoProjectNoInDraft =
    projectAction === "GENERATE" && !(draft.projectNo as string)?.trim();

  const initialCostCents =
    input.initialCost != null ? toCents(Number(input.initialCost), input.moneyUnit) : 0;

  const orderedAt =
    input.orderedAt == null || input.orderedAt === ""
      ? null
      : input.orderedAt instanceof Date
        ? input.orderedAt
        : new Date(input.orderedAt);

  const payload: CreateOrderPayload = {
    title,
    description: input.description?.toString().trim() || null,
    category: orderCategory,
    status: orderStatus,
    orderedAt,
    profileId: ctx.profileId,
    // Authority only — never trust client-supplied rep/org for formal FKs.
    representativeId: ctx.representativeId,
    buyerOrganizationId: ctx.organizationId,
    totalAmount: totalAmountCents,
    financeTreatment:
      projectAction === "GENERATE" || projectAction === "LINK"
        ? "PROJECT_INCLUDED"
        : input.financeTreatment?.toString().trim() || null,
    financeNote: input.financeNote?.toString().trim() || null,
    // Formal buyer snapshots are CRM-only. Client/import text never fills gaps —
    // raw import text stays in OrderSourceRecord.rawJson / staging.
    buyerNameSnapshot: crmOnlySnapshot(ctx.clientName),
    buyerPhoneSnapshot: crmOnlySnapshot(ctx.buyerPhone),
    buyerWechatSnapshot: crmOnlySnapshot(ctx.buyerWechat),
    buyerOrgNameSnapshot: crmOnlySnapshot(ctx.organizationName),
    buyerAddressSnapshot: crmOnlySnapshot(ctx.buyerAddress),
    techSupport,
    lines: lineItems,
    createdById: actor.userId,
    source: input.source?.toString().trim() || "MANUAL",
    sourcePlatform: input.sourcePlatform?.toString().trim() || null,
    sourceRemark: input.sourceRemark?.toString().trim() || null,
    externalOrderNo: input.externalOrderNo?.toString().trim() || null,
    merchantOrderNo: input.merchantOrderNo?.toString().trim() || null,
    orderNoRefDate: input.orderNoRefDate ?? null,
    confirmedAt: input.confirmedAt ?? null,
    deliveredAt: input.deliveredAt ?? null,
    customerMatchStatus: input.customerMatchStatus?.toString().trim() || null,
    customerMatchScore: input.customerMatchScore ?? null,
    customerMatchReason: input.customerMatchReason?.toString().trim() || null,
    buyerMiniProgramIdSnapshot: input.buyerMiniProgramIdSnapshot?.toString().trim() || null,
    projectAction,
    projectId: input.projectId?.toString().trim() || null,
    projectDraft: draft,
    initialCost: initialCostCents > 0 ? initialCostCents : null,
    initialCostType: input.initialCostType?.toString().trim() || null,
    initialCostRemark: input.initialCostRemark?.toString().trim() || null,
  };

  return {
    payload,
    meta: {
      profileId: ctx.profileId,
      profileName: ctx.clientName || "未命名客户",
      orderCategory,
      orderStatus,
      projectAction,
      autoProjectNoInDraft,
      totalAmountCents,
    },
  };
}

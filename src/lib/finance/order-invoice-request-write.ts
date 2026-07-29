/**
 * 订单开票申请共享写入服务
 *
 * 页面 POST /api/finance/order-invoices、Agent finance.prepare_invoice_draft、
 * Agent finance.submit_invoice_request 三条路径共用此模块，避免规则漂移。
 *
 * 设计文档：docs/finance-natural-language-order-invoice-request-phase-3-implementation-2026-07-21.md §5
 *
 * 购方校验分两种模式：
 * - 兼容模式（默认，页面 / prepare_invoice_draft）：buyerOrganizationId 可选，只要求名称；
 *   跨机构合票由 allowCrossOrgInvoice + validateTouchedOrders 控制。
 * - 严格模式（strictBuyerOrg=true，submit_invoice_request）：buyerOrganizationId 必填，
 *   快照来自 Organization，且覆盖订单购方必须与之一致；订单 DRAFT 状态禁止开票。
 */

import { prisma } from "@/lib/prisma";
import { validateTouchedOrders } from "@/lib/finance/order-invoices";
import { syncOrderInvoiceStatus } from "@/lib/external-order";
import { sendInvoiceRequestedEmail } from "@/lib/business-email/notify";
import type { Prisma } from "@prisma/client";

// ─── Error ────────────────────────────────────────────────────────────────────

export class OrderInvoiceRequestWriteError extends Error {
  code: string;
  httpStatus: number;

  constructor(code: string, message: string, httpStatus: number) {
    super(message);
    this.name = "OrderInvoiceRequestWriteError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/**
 * Prisma 唯一约束冲突（P2002）检测。
 * 用于并发重入兜底：两个请求同时创建同一 sourceAgentProposalId 时，后者命中唯一约束。
 */
function isPrismaUniqueConstraintViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: string };
  return e.code === "P2002";
}

// ─── Types ────────────────────────────────────────────────────────────────────

export type InvoiceRequestItemInput = {
  itemName: string;
  spec?: string | null;
  unit?: string | null;
  quantity?: number | null;
  amountCents: number;
};

export type InvoiceCoverageInput = {
  orderId: string;
  amountCents: number;
};

/**
 * 创建开票申请输入。
 *
 * `buyerOrganizationId` 在兼容模式下可选（页面只填名称即可）；
 * 严格模式（`strictBuyerOrg: true`）下运行时必填——调用方应传非空字符串。
 */
export type CreateOrderInvoiceRequestInput = {
  mainOrderId: string;
  coverageAllocations: InvoiceCoverageInput[];
  /** 兼容模式可选；严格模式（strictBuyerOrg）必填。 */
  buyerOrganizationId?: string | null;
  buyerOrganizationName: string;
  buyerTaxId?: string | null;
  buyerTaxIdFromLookup?: boolean;
  sellerProfileId?: string | null;
  sellerName?: string | null;
  invoiceType: "NORMAL" | "SPECIAL";
  contactName?: string | null;
  contentSummary?: string | null;
  remark?: string | null;
  items: InvoiceRequestItemInput[];
  targetStatus: "DRAFT" | "REQUESTED";
  createdById: string;
  sourceAgentProposalId?: string | null;
  allowCrossOrgInvoice?: boolean;
  /**
   * Phase 3 / submit_invoice_request 严格购方校验。
   * false（默认）= 页面兼容：不强制 ID、不强制订单购方等于发票购方、尊重 allowCrossOrgInvoice。
   * true = 必须 buyerOrganizationId，Organization 快照，覆盖订单购方一致，禁止 DRAFT 订单。
   */
  strictBuyerOrg?: boolean;
  /**
   * Phase E：Agent channel 在最终写事务内复核 technicalOwner（防 TOCTOU）。
   * Web channel 不传。orderIds 为 coverage 触达的全部订单。
   */
  agentOwnerRecheck?: {
    actor: { userId: string; role: string };
    invocation: { channel: string; proposalId?: string | null };
    orderIds: string[];
  };
};

export type CreateOrderInvoiceRequestResult = {
  invoice: {
    id: string;
    orderId: string | null;
    buyerOrganizationName: string;
    totalAmount: number;
    status: string;
    createdAt: Date;
  };
  coveredOrderCount: number;
  idempotentHit: boolean;
};

type ResolvedBuyer = {
  buyerOrganizationId: string | null;
  buyerOrganizationName: string;
  buyerTaxId: string | null;
  buyerTaxIdFromLookup: boolean;
};

/**
 * 在给定 client（事务内外均可）上解析购方快照并做严格/兼容校验。
 * 导出供 buildProposal 只读预检复用，避免「确认卡可展示、confirm 才失败」。
 */
export async function resolveInvoiceBuyerSnapshot(
  client: Prisma.TransactionClient | typeof prisma,
  input: CreateOrderInvoiceRequestInput,
  touchedOrderIds: string[],
): Promise<ResolvedBuyer> {
  const strict = !!input.strictBuyerOrg;

  if (strict) {
    if (!input.buyerOrganizationId) {
      throw new OrderInvoiceRequestWriteError(
        "BUYER_ORG_REQUIRED",
        "必须提供结构化购方机构 ID（buyerOrganizationId）",
        400,
      );
    }
    const buyerOrg = await client.organization.findUnique({
      where: { id: input.buyerOrganizationId },
      select: { id: true, canonicalName: true, taxId: true, isInvoiceSubject: true, deleted: true },
    });
    if (!buyerOrg || buyerOrg.deleted) {
      throw new OrderInvoiceRequestWriteError("BUYER_ORG_NOT_FOUND", "指定的买方单位不存在", 400);
    }
    if (!buyerOrg.isInvoiceSubject) {
      throw new OrderInvoiceRequestWriteError(
        "BUYER_ORG_NOT_INVOICE_SUBJECT",
        "指定的买方单位未完成税务验真，不能作开票买方",
        400,
      );
    }

    const orderOrgRows = await client.order.findMany({
      where: { id: { in: touchedOrderIds }, deleted: false },
      select: { id: true, buyerOrganizationId: true, status: true },
    });
    const orderOrgMap = new Map(orderOrgRows.map((o) => [o.id, o]));
    for (const oid of touchedOrderIds) {
      const co = orderOrgMap.get(oid);
      if (!co) {
        throw new OrderInvoiceRequestWriteError("ORDER_NOT_FOUND", `订单 ${oid.slice(-6)} 不存在`, 404);
      }
      if (co.buyerOrganizationId !== input.buyerOrganizationId) {
        throw new OrderInvoiceRequestWriteError(
          "BUYER_ORG_MISMATCH",
          `订单 ${oid.slice(-6)} 的购方机构与指定购方不一致，不允许跨机构合票`,
          400,
        );
      }
      if (co.status === "DRAFT") {
        throw new OrderInvoiceRequestWriteError(
          "ORDER_STATUS_BLOCKED",
          `订单 ${oid.slice(-6)} 状态为草稿（DRAFT），不允许开票`,
          400,
        );
      }
    }

    return {
      buyerOrganizationId: buyerOrg.id,
      buyerOrganizationName: buyerOrg.canonicalName || input.buyerOrganizationName.trim(),
      buyerTaxId: buyerOrg.taxId || null,
      buyerTaxIdFromLookup: true,
    };
  }

  // 兼容模式：不强制 ID、不强制订单购方一致；但若给了 ID，仍校验存在 + isInvoiceSubject（3A 回归）
  if (input.buyerOrganizationId) {
    const buyerOrg = await client.organization.findUnique({
      where: { id: input.buyerOrganizationId },
      select: { id: true, deleted: true, isInvoiceSubject: true },
    });
    if (!buyerOrg || buyerOrg.deleted) {
      throw new OrderInvoiceRequestWriteError("BUYER_ORG_NOT_FOUND", "指定的买方单位不存在", 400);
    }
    if (!buyerOrg.isInvoiceSubject) {
      throw new OrderInvoiceRequestWriteError(
        "BUYER_ORG_NOT_INVOICE_SUBJECT",
        "指定的买方单位未完成税务验真，不能作开票买方",
        400,
      );
    }
  }

  const name = input.buyerOrganizationName.trim();
  if (!name) {
    throw new OrderInvoiceRequestWriteError("BUYER_NAME_REQUIRED", "对方公司名称不能为空", 400);
  }

  return {
    buyerOrganizationId: input.buyerOrganizationId || null,
    buyerOrganizationName: name,
    buyerTaxId: input.buyerTaxId?.trim() || null,
    buyerTaxIdFromLookup: !!input.buyerTaxIdFromLookup,
  };
}

/** @deprecated 使用 resolveInvoiceBuyerSnapshot；保留内部别名避免大范围重命名。 */
const resolveBuyerSnapshot = resolveInvoiceBuyerSnapshot;

// ─── Core Service ─────────────────────────────────────────────────────────────

/**
 * 创建单张订单开票申请（DRAFT 或 REQUESTED）。
 *
 * 事务内完成：幂等检查 → 校验 → 创建申请 + items + coverage。
 * 事务后 best-effort：同步订单开票状态、发送通知。
 */
export async function createOrderInvoiceRequest(
  input: CreateOrderInvoiceRequestInput,
): Promise<CreateOrderInvoiceRequestResult> {
  // ── 0. 幂等：sourceAgentProposalId 非空时先查已有记录 ──
  if (input.sourceAgentProposalId) {
    const existing = await prisma.externalOrderInvoiceRequest.findUnique({
      where: { sourceAgentProposalId: input.sourceAgentProposalId },
      select: { id: true, orderId: true, buyerOrganizationName: true, totalAmount: true, status: true, createdAt: true },
    });
    if (existing) {
      return {
        invoice: existing,
        coveredOrderCount: 0, // 不重新计算，调用方不需要
        idempotentHit: true,
      };
    }
  }

  // ── 1. 规范化 coverage ──
  const itemRows = input.items.filter((it) => it.itemName.trim());
  const totalAmount = itemRows.reduce((sum, it) => sum + it.amountCents, 0);
  if (totalAmount <= 0) {
    throw new OrderInvoiceRequestWriteError("INVALID_AMOUNT", "发票金额必须大于 0", 400);
  }

  const allocByOrder = new Map<string, number>();
  for (const a of input.coverageAllocations) {
    allocByOrder.set(a.orderId, (allocByOrder.get(a.orderId) || 0) + a.amountCents);
  }
  // 单主订单恒等派生：未传 coverageAllocations 时，按发票全额归属主订单
  if (input.coverageAllocations.length === 0) {
    allocByOrder.set(input.mainOrderId, totalAmount);
  }

  const touchedOrderIds = [...allocByOrder.keys()];
  if (!touchedOrderIds.includes(input.mainOrderId)) {
    throw new OrderInvoiceRequestWriteError(
      "COVERAGE_MISSING_MAIN_ORDER",
      "coverageAllocations 必须包含主订单 orderId",
      400,
    );
  }

  // ── 2. 校验 coverage 合计 = items 合计 = totalAmount ──
  const coverageTotal = [...allocByOrder.values()].reduce((s, v) => s + v, 0);
  if (coverageTotal !== totalAmount) {
    throw new OrderInvoiceRequestWriteError(
      "COVERAGE_TOTAL_MISMATCH",
      `coverageAllocations 合计 ${(coverageTotal / 100).toFixed(2)} 元与发票金额 ${(totalAmount / 100).toFixed(2)} 元不一致`,
      400,
    );
  }

  // ── 3. 校验主订单存在 ──
  const order = await prisma.order.findUnique({
    where: { id: input.mainOrderId, deleted: false },
    select: { id: true, legacyExternalOrderId: true },
  });
  if (!order) {
    throw new OrderInvoiceRequestWriteError("ORDER_NOT_FOUND", "主订单不存在", 404);
  }

  // ── 4. 事务外预校验（快速失败，改善 UX；权威复核在事务内） ──
  const preValidation = await validateTouchedOrders(touchedOrderIds, allocByOrder, {
    allowCrossOrgInvoice: !!input.allowCrossOrgInvoice,
    allowProjectIncludedInvoice: false,
  });
  if (!preValidation.ok) {
    throw new OrderInvoiceRequestWriteError(
      (preValidation.body.code as string) || "VALIDATION_FAILED",
      String(preValidation.body.error || preValidation.body.message || "开票前置校验失败"),
      preValidation.status,
    );
  }

  // 事务外购方预检（严格模式快速失败）；权威结果仍以事务内 resolve 为准
  if (input.strictBuyerOrg) {
    await resolveBuyerSnapshot(prisma, input, touchedOrderIds);
  } else if (!input.buyerOrganizationName.trim()) {
    throw new OrderInvoiceRequestWriteError("BUYER_NAME_REQUIRED", "对方公司名称不能为空", 400);
  }

  // ── 5. 解析销方 BillingProfile 快照（档案本身较少并发变更，可在事务外） ──
  let sellerSnapshot: Record<string, unknown> = {};
  if (input.sellerProfileId) {
    const profile = await prisma.billingProfile.findUnique({
      where: { id: input.sellerProfileId },
    });
    if (!profile || profile.archived) {
      throw new OrderInvoiceRequestWriteError(
        "SELLER_PROFILE_INVALID",
        "销方主体不存在或已归档",
        400,
      );
    }
    sellerSnapshot = {
      sellerProfileId: profile.id,
      sellerName: profile.name,
      sellerTaxId: profile.taxId || null,
      sellerBankName: profile.bankName || null,
      sellerBankAccount: profile.bankAccount || null,
      sellerAddress: profile.address || null,
      sellerPhone: profile.phone || null,
    };
  }
  if (!sellerSnapshot.sellerName && input.sellerName?.trim()) {
    sellerSnapshot = { ...sellerSnapshot, sellerName: input.sellerName.trim() };
  }

  // ── 6. 事务内创建：额度 + 购方/状态权威复核 ──
  const invoice = await prisma.$transaction(async (tx) => {
    // Phase E：Agent channel 技术负责人最终写事务内复核（防 TOCTOU）。
    if (input.agentOwnerRecheck) {
      const { assertAgentCanWriteOrders } = await import(
        "@/lib/orders/application/technical-owner-gate"
      );
      await assertAgentCanWriteOrders(
        input.agentOwnerRecheck.actor as import("@/lib/application/actor").BusinessActor,
        input.agentOwnerRecheck.invocation as import("@/lib/application/actor").InvocationContext,
        input.agentOwnerRecheck.orderIds,
        { tx },
      );
    }

    const txValidation = await validateTouchedOrders(touchedOrderIds, allocByOrder, {
      allowCrossOrgInvoice: !!input.allowCrossOrgInvoice,
      allowProjectIncludedInvoice: false,
      tx,
    });
    if (!txValidation.ok) {
      throw new OrderInvoiceRequestWriteError(
        (txValidation.body.code as string) || "INVOICEABLE_EXCEEDED",
        String(txValidation.body.error || txValidation.body.message || "开票前置校验失败"),
        txValidation.status,
      );
    }

    // 购方一致性 / DRAFT 状态在事务内复核，避免 TOCTOU
    const resolvedBuyer = await resolveBuyerSnapshot(tx, input, touchedOrderIds);

    const created = await tx.externalOrderInvoiceRequest.create({
      data: {
        orderId: input.mainOrderId,
        externalOrderId: order.legacyExternalOrderId,
        contactName: input.contactName?.trim() || null,
        ...sellerSnapshot,
        buyerOrganizationId: resolvedBuyer.buyerOrganizationId,
        buyerOrganizationName: resolvedBuyer.buyerOrganizationName,
        buyerTaxId: resolvedBuyer.buyerTaxId,
        buyerTaxIdFromLookup: resolvedBuyer.buyerTaxIdFromLookup,
        invoiceType: input.invoiceType === "SPECIAL" ? "SPECIAL" : "NORMAL",
        contentSummary: input.contentSummary?.trim() || null,
        totalAmount,
        remark: input.remark?.trim() || null,
        status: input.targetStatus,
        submittedAt: input.targetStatus === "REQUESTED" ? new Date() : null,
        sourceAgentProposalId: input.sourceAgentProposalId || null,
        createdById: input.createdById,
        items: itemRows.length > 0
          ? {
              create: itemRows.map((item, index) => ({
                itemName: item.itemName.trim(),
                spec: item.spec?.trim() || null,
                unit: item.unit?.trim() || null,
                quantity: item.quantity ?? null,
                amount: item.amountCents,
                sortOrder: index,
              })),
            }
          : undefined,
      },
    });

    // 为所有 touched order（含主订单）写 coverage 行
    for (const [oid, amount] of allocByOrder.entries()) {
      await tx.orderInvoiceCoverage.create({
        data: { invoiceRequestId: created.id, orderId: oid, amount },
      });
    }

    return created;
  }).catch((err: unknown) => {
    // 并发重入兜底：两个重入请求都查不到已有记录时，唯一约束 sourceAgentProposalId 会触发 P2002。
    // 此时按 proposalId 回读已有记录并返回幂等结果，而不是抛出未映射错误。
    if (input.sourceAgentProposalId && isPrismaUniqueConstraintViolation(err)) {
      return null; // 信号：事务因唯一冲突失败，下方走回读
    }
    throw err;
  });

  // 并发冲突时回读已有记录
  if (invoice === null && input.sourceAgentProposalId) {
    const existing = await prisma.externalOrderInvoiceRequest.findUnique({
      where: { sourceAgentProposalId: input.sourceAgentProposalId },
      select: { id: true, orderId: true, buyerOrganizationName: true, totalAmount: true, status: true, createdAt: true },
    });
    if (existing) {
      return {
        invoice: existing,
        coveredOrderCount: 0,
        idempotentHit: true,
      };
    }
    // 极端情况：回读也查不到（可能被并发删除），抛出让调用方重试
    throw new OrderInvoiceRequestWriteError("IDEMPOTENT_RETRY", "幂等回读失败，请重试", 409);
  }

  // 到此 invoice 已确定非 null（null 分支已在上方 return 或 throw）。
  // TS 无法跨 catch 回调收窄类型，用断言明确。
  const createdInvoice = invoice!;

  // ── 7. 事务后 best-effort ──
  // 同步所有被覆盖订单的 invoice status
  for (const oid of touchedOrderIds) {
    try {
      const currentOrder = await prisma.order.findUnique({
        where: { id: oid },
        select: { legacyExternalOrderId: true },
      });
      if (currentOrder?.legacyExternalOrderId) {
        await syncOrderInvoiceStatus(prisma, currentOrder.legacyExternalOrderId, oid);
      }
      await syncOrderInvoiceStatus(prisma, oid, oid);
    } catch {
      // best-effort，不影响已创建申请
    }
  }

  // REQUESTED 时发送通知（失败不回滚）
  if (input.targetStatus === "REQUESTED") {
    try {
      await sendInvoiceRequestedEmail(createdInvoice.id);
    } catch {
      // best-effort，记录 warning 但不影响结果
    }
  }

  return {
    invoice: {
      id: createdInvoice.id,
      orderId: createdInvoice.orderId,
      buyerOrganizationName: createdInvoice.buyerOrganizationName,
      totalAmount: createdInvoice.totalAmount,
      status: createdInvoice.status,
      createdAt: createdInvoice.createdAt,
    },
    coveredOrderCount: touchedOrderIds.length,
    idempotentHit: false,
  };
}

// ─── Error Mapper ─────────────────────────────────────────────────────────────

/**
 * 将 OrderInvoiceRequestWriteError 映射为 HTTP 响应体。
 * 非本模块错误返回 null（由调用方处理）。
 */
export function mapOrderInvoiceRequestWriteError(err: unknown): {
  status: number;
  body: { error: string; code?: string };
} | null {
  if (err instanceof OrderInvoiceRequestWriteError) {
    return { status: err.httpStatus, body: { error: err.message, code: err.code } };
  }
  return null;
}

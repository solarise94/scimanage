/**
 * Allocation-based receipt creation (凭证匹配核销).
 *
 * Shared by POST /api/finance/receipts and Agent finance.create_receipt so
 * both paths enforce the same domain invariants:
 * - ADMIN/USER write gate is caller's responsibility (canWriteFinance)
 * - object-level order scope on every coverage order
 * - ISSUED + not RED/REISSUE + complete coverage table
 *   (adjustment state is re-checked inside the write transaction: a REISSUE
 *   committed between bank-flow matching and confirmation must block write-off)
 * - amounts from coverage rows (no proportional split)
 * - full-invoice settlement only; concurrent overpayment guard in-tx
 */

import { prisma } from "@/lib/prisma";
import { getOrderScopeWhere } from "@/lib/orders/permissions";
import { yuanToCents, centsToYuan } from "@/lib/finance/money";
import { parseReceivedAtInput } from "@/lib/finance/receipt-date";
import {
  ReceiptMissingProfileError,
  resolveAllocationReceiptProfileId,
} from "@/lib/finance/receipt-profile";

export class AllocationReceiptError extends Error {
  status: number;
  body: Record<string, unknown>;

  constructor(message: string, status: number, body?: Record<string, unknown>) {
    super(message);
    this.name = "AllocationReceiptError";
    this.status = status;
    this.body = body ?? { error: message };
  }
}

export type CreateAllocationReceiptInput = {
  userId: string;
  role: string;
  /** 部门归属；未提供时下游 getOrderScopeWhere 从 DB 实时解析（fail-closed）。 */
  department?: string;
  /** Receipt amount in yuan (caller-facing unit). */
  amountYuan: number;
  /** YYYY-MM-DD preferred; also accepts ISO strings whose first 10 chars form a date. */
  receivedAt?: string;
  source?: string;
  remark?: string | null;
  organizationId: string;
  allocations: Array<{ invoiceId: string; amountYuan: number }>;
  /** Agent 银行流水批次幂等键（workspaceId + rowIndex）。 */
  sourceWorkspaceId?: string;
  sourceRowIndex?: number;
  /**
   * Agent proposal 级幂等键（finance.create_receipt 单回款确认链）。只能由
   * 服务端从 ctx.invocation.proposalId 注入，不得来自模型/客户端输入。
   * 与 workspace+row 键互不重叠：批量确认一个 proposal 多笔回款，不用此键。
   */
  sourceAgentProposalId?: string | null;
  /** T6.5: caller already enforced full touched-order scope via createReceiptForActor. */
  skipOrderScopeCheck?: boolean;
  /**
   * Phase E：Agent channel 在最终写事务内复核 technicalOwner（防 TOCTOU）。
   * Web channel 不传。
   */
  agentOwnerRecheck?: {
    actor: { userId: string; role: string; department?: string };
    invocation: { channel: string; proposalId?: string | null };
    orderIds: string[];
  };
};

export type CreateAllocationReceiptResult = {
  receipt: {
    id: string;
    amountCents: number;
    receivedAt: Date;
    source: string;
  };
  allocations: Array<{
    invoiceId: string;
    orderId: string;
    amountCents: number;
    newOutstandingCents: number;
  }>;
  crossOrder: boolean;
  orderBreakdown: Array<{ orderId: string; sumCents: number }>;
  /** true 表示命中唯一约束，返回已有回款（幂等成功）。 */
  idempotentReplay?: boolean;
};

async function resolveOrderAndCheckScope(
  userId: string,
  role: string,
  department: string | undefined,
  orderId: string,
): Promise<{ valid: boolean; profileId: string | null }> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { id: true, profileId: true },
  });
  if (!order) return { valid: false, profileId: null };

  if (role === "ADMIN") return { valid: true, profileId: order.profileId };

  const orderScope = await getOrderScopeWhere(userId, role, prisma, department);
  if (!orderScope) return { valid: false, profileId: null };
  const inScope = await prisma.order.count({ where: { id: orderId, AND: [orderScope] } });
  if (inScope === 0) return { valid: false, profileId: null };

  return { valid: true, profileId: order.profileId };
}

function normalizeReceivedAtInput(value?: string | null): string | undefined {
  if (!value || !value.trim()) return undefined;
  const trimmed = value.trim();
  // Already YYYY-MM-DD, or ISO / datetime whose date prefix is usable.
  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return trimmed.slice(0, 10);
  return trimmed;
}

/**
 * Create a FinanceReceipt with per-coverage-row FinanceReceiptAllocation rows.
 * Throws AllocationReceiptError (400/403/409) or ReceiptMissingProfileError.
 */
/** 幂等回放：从已有回款行重建与首次创建同形的结果（newOutstanding 归 0）。 */
function buildReplayResult(existing: {
  id: string;
  amount: number;
  receivedAt: Date;
  source: string;
  allocations: Array<{ invoiceId: string; orderId: string; amount: number }>;
}): CreateAllocationReceiptResult {
  const orderBreakdownMap = new Map<string, number>();
  for (const a of existing.allocations) {
    orderBreakdownMap.set(a.orderId, (orderBreakdownMap.get(a.orderId) || 0) + a.amount);
  }
  return {
    receipt: {
      id: existing.id,
      amountCents: existing.amount,
      receivedAt: existing.receivedAt,
      source: existing.source,
    },
    allocations: existing.allocations.map((a) => ({
      invoiceId: a.invoiceId,
      orderId: a.orderId,
      amountCents: a.amount,
      newOutstandingCents: 0,
    })),
    crossOrder: orderBreakdownMap.size > 1,
    orderBreakdown: Array.from(orderBreakdownMap.entries()).map(([orderId, sumCents]) => ({
      orderId,
      sumCents,
    })),
    idempotentReplay: true,
  };
}

const REPLAY_INCLUDE = {
  allocations: { select: { invoiceId: true, orderId: true, amount: true } },
} as const;

export async function createAllocationReceipt(
  input: CreateAllocationReceiptInput,
): Promise<CreateAllocationReceiptResult> {
  const {
    userId,
    role,
    department,
    amountYuan,
    receivedAt,
    source,
    remark,
    organizationId,
    allocations,
    sourceWorkspaceId,
    sourceRowIndex,
    sourceAgentProposalId,
    skipOrderScopeCheck = false,
    agentOwnerRecheck,
  } = input;

  const hasIdempotencyKey =
    typeof sourceWorkspaceId === "string" &&
    sourceWorkspaceId.length > 0 &&
    typeof sourceRowIndex === "number" &&
    Number.isInteger(sourceRowIndex) &&
    sourceRowIndex >= 0;
  const hasProposalKey =
    typeof sourceAgentProposalId === "string" && sourceAgentProposalId.length > 0;

  /** 按本次调用携带的幂等键查已有回款（软删的不算，允许删后重建）。 */
  const findExistingByIdempotencyKey = () => {
    if (hasProposalKey) {
      return prisma.financeReceipt.findFirst({
        where: { sourceAgentProposalId: sourceAgentProposalId!, deleted: false },
        include: REPLAY_INCLUDE,
      });
    }
    if (hasIdempotencyKey) {
      return prisma.financeReceipt.findFirst({
        where: {
          sourceWorkspaceId: sourceWorkspaceId!,
          sourceRowIndex: sourceRowIndex!,
          deleted: false,
        },
        include: REPLAY_INCLUDE,
      });
    }
    return Promise.resolve(null);
  };

  {
    const existing = await findExistingByIdempotencyKey();
    if (existing) {
      return buildReplayResult(existing);
    }
  }

  if (!amountYuan || typeof amountYuan !== "number" || amountYuan <= 0) {
    throw new AllocationReceiptError("金额必须大于 0", 400);
  }
  if (!Array.isArray(allocations) || allocations.length === 0) {
    throw new AllocationReceiptError("allocations 不能为空", 400);
  }
  if (!organizationId || typeof organizationId !== "string") {
    throw new AllocationReceiptError("凭证匹配必须提供 organizationId（付款机构）", 400);
  }

  const amountCents = yuanToCents(amountYuan);
  const allocationsCents = allocations.map((a) => ({
    invoiceId: a.invoiceId,
    amount: yuanToCents(a.amountYuan),
  }));

  for (const alloc of allocations) {
    if (!alloc.invoiceId || typeof alloc.invoiceId !== "string") {
      throw new AllocationReceiptError("每条 allocation 必须包含 invoiceId", 400);
    }
    if (!alloc.amountYuan || typeof alloc.amountYuan !== "number" || alloc.amountYuan <= 0) {
      throw new AllocationReceiptError("每条 allocation 的 amount 必须大于 0", 400);
    }
  }

  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { id: true },
  });
  if (!org) {
    throw new AllocationReceiptError("付款机构不存在", 400);
  }

  const invoiceIds = allocations.map((a) => a.invoiceId);
  const invoices = await prisma.externalOrderInvoiceRequest.findMany({
    where: { id: { in: invoiceIds } },
    include: {
      orderCoverage: { select: { orderId: true, amount: true } },
      adjustmentsAsOriginal: { select: { kind: true } },
    },
  });

  if (invoices.length !== invoiceIds.length) {
    const foundIds = new Set(invoices.map((i) => i.id));
    const missing = invoiceIds.filter((id) => !foundIds.has(id));
    throw new AllocationReceiptError(`发票不存在: ${missing.join(", ")}`, 400);
  }

  const invoiceMap = new Map(invoices.map((i) => [i.id, i]));

  // §3.2 / §4.1：有效 coverage 分摊行；金额一律来自 coverage.amount，禁止比例推导。
  const coverageRowsByInvoice = new Map<string, Array<{ orderId: string; amount: number }>>();
  for (const inv of invoices) {
    let rows = inv.orderCoverage.map((c) => ({ orderId: c.orderId, amount: c.amount }));
    if (rows.length === 0 && inv.orderId) {
      rows = [{ orderId: inv.orderId, amount: inv.totalAmount }];
    }
    coverageRowsByInvoice.set(inv.id, rows);
  }

  for (const alloc of allocations) {
    const inv = invoiceMap.get(alloc.invoiceId)!;

    if (inv.status !== "ISSUED") {
      throw new AllocationReceiptError(
        `发票 ${inv.id} 状态不是 ISSUED（当前: ${inv.status}）`,
        400,
      );
    }

    const isRed = inv.adjustmentsAsOriginal?.some((a) => a.kind === "RED");
    if (isRed) {
      throw new AllocationReceiptError(`发票 ${inv.id} 已冲红`, 400);
    }

    const isReissued = inv.adjustmentsAsOriginal?.some((a) => a.kind === "REISSUE");
    if (isReissued) {
      throw new AllocationReceiptError(
        `发票 ${inv.id} 已重开，不能作为回款目标`,
        409,
        { error: "INVOICE_REISSUED", invoiceId: inv.id },
      );
    }

    const covRows = coverageRowsByInvoice.get(inv.id)!;
    if (covRows.length === 0) {
      throw new AllocationReceiptError(
        `发票 ${inv.id} 缺少订单分摊记录，无法核销（请先补齐 coverage）`,
        400,
      );
    }
    const covSum = covRows.reduce((s, r) => s + r.amount, 0);
    if (covSum !== inv.totalAmount) {
      throw new AllocationReceiptError(
        `发票 ${inv.id} 分摊合计 (¥${centsToYuan(covSum)}) 与票面金额 (¥${centsToYuan(inv.totalAmount)}) 不一致，请检查分摊表`,
        400,
      );
    }

    if (inv.buyerOrganizationId !== organizationId) {
      throw new AllocationReceiptError(
        `发票 ${inv.id} 的付款机构 (${inv.buyerOrganizationId || "未设置"}) 与凭证机构 (${organizationId}) 不一致`,
        400,
      );
    }
  }

  const orderIds = [...new Set(
    invoices.flatMap((i) => (coverageRowsByInvoice.get(i.id) || []).map((r) => r.orderId)),
  )];
  if (!skipOrderScopeCheck && role !== "ADMIN") {
    for (const oid of orderIds) {
      const { valid } = await resolveOrderAndCheckScope(userId, role, department, oid);
      if (!valid) {
        throw new AllocationReceiptError(
          `Forbidden: 订单 ${oid} 不可见，无法对其发票创建回款`,
          403,
        );
      }
    }
  }

  const totalAllocated = allocationsCents.reduce((s, a) => s + a.amount, 0);
  if (totalAllocated !== amountCents) {
    throw new AllocationReceiptError(
      `分摊金额合计 (¥${centsToYuan(totalAllocated).toLocaleString()}) 与凭证金额 (¥${centsToYuan(amountCents).toLocaleString()}) 不一致`,
      400,
    );
  }

  const orders = await prisma.order.findMany({
    where: { id: { in: orderIds } },
    select: { id: true, profileId: true },
  });
  let primaryProfileId: string | null;
  try {
    primaryProfileId = resolveAllocationReceiptProfileId(orders, orderIds);
  } catch (err) {
    if (err instanceof ReceiptMissingProfileError) throw err;
    throw err;
  }

  const rowKey = (invoiceId: string, orderId: string) => `${invoiceId}::${orderId}`;
  const receivedAtDate = parseReceivedAtInput(normalizeReceivedAtInput(receivedAt));

  try {
    const result = await prisma.$transaction(async (tx) => {
      // Phase E：Agent channel 技术负责人最终写事务内复核（防 TOCTOU）。
      if (agentOwnerRecheck && agentOwnerRecheck.orderIds.length > 0) {
        const { assertAgentCanWriteOrders } = await import(
          "@/lib/orders/application/technical-owner-gate"
        );
        await assertAgentCanWriteOrders(
          agentOwnerRecheck.actor as import("@/lib/application/actor").BusinessActor,
          agentOwnerRecheck.invocation as import("@/lib/application/actor").InvocationContext,
          agentOwnerRecheck.orderIds,
          { tx },
        );
      }

      // 占用口径与 `@/lib/finance/invoice-outstanding` 一致：
      // allocation（未删回款）+ 无 allocation 的 legacy receipt；此处再按 (invoiceId, orderId) 拆行校验。
      const [allocRowSums, legacySums] = await Promise.all([
        tx.financeReceiptAllocation.groupBy({
          by: ["invoiceId", "orderId"],
          where: {
            invoiceId: { in: invoiceIds },
            receipt: { deleted: false },
          },
          _sum: { amount: true },
        }),
        tx.financeReceipt.groupBy({
          by: ["externalOrderInvoiceRequestId"],
          where: {
            externalOrderInvoiceRequestId: { in: invoiceIds },
            deleted: false,
            allocations: { none: {} },
          },
          _sum: { amount: true },
        }),
      ]);

      const rowOccupied = new Map<string, number>();
      for (const s of allocRowSums) {
        rowOccupied.set(
          rowKey(s.invoiceId, s.orderId),
          (rowOccupied.get(rowKey(s.invoiceId, s.orderId)) || 0) + (s._sum.amount || 0),
        );
      }
      const legacyByInvoice = new Map<string, number>();
      for (const s of legacySums) {
        if (s.externalOrderInvoiceRequestId) {
          legacyByInvoice.set(
            s.externalOrderInvoiceRequestId,
            (legacyByInvoice.get(s.externalOrderInvoiceRequestId) || 0) + (s._sum.amount || 0),
          );
        }
      }

      // Race guard: the pre-tx adjustment read may be stale — bank-flow matching
      // creates no occupancy, so a RED/REISSUE committed between the pre-check
      // and this transaction (e.g. an old workspace confirming after reissue)
      // would otherwise write off the original invoice. Re-read and reject
      // inside the write tx, mirroring register-issued-invoice.ts's in-tx
      // re-validation. @@unique([originalInvoiceId]) ⇒ ≤1 adjustment per invoice.
      const freshAdjustments = await tx.invoiceAdjustment.findMany({
        where: { originalInvoiceId: { in: invoiceIds } },
        select: { originalInvoiceId: true, kind: true },
      });
      for (const adj of freshAdjustments) {
        if (adj.kind === "RED") {
          throw new AllocationReceiptError(`发票 ${adj.originalInvoiceId} 已冲红`, 400);
        }
        if (adj.kind === "REISSUE") {
          throw new AllocationReceiptError(
            `发票 ${adj.originalInvoiceId} 已重开，不能作为回款目标`,
            409,
            { error: "INVOICE_REISSUED", invoiceId: adj.originalInvoiceId },
          );
        }
      }

      const receipt = await tx.financeReceipt.create({
        data: {
          amount: amountCents,
          receivedAt: receivedAtDate,
          source: source || "BANK",
          remark: remark?.trim() || null,
          createdById: userId,
          profileId: primaryProfileId,
          organizationId: organizationId || null,
          orderId: null,
          externalOrderInvoiceRequestId: null,
          projectInvoiceId: null,
          externalOrderId: null,
          projectId: null,
          ...(hasIdempotencyKey
            ? {
                sourceWorkspaceId: sourceWorkspaceId!,
                sourceRowIndex: sourceRowIndex!,
              }
            : {}),
          ...(hasProposalKey ? { sourceAgentProposalId: sourceAgentProposalId! } : {}),
        },
      });

      const createdAllocations: Array<{
        invoiceId: string;
        orderId: string;
        amount: number;
        newOutstanding: number;
      }> = [];
      const orderBreakdown = new Map<string, number>();

      for (const alloc of allocationsCents) {
        const inv = invoiceMap.get(alloc.invoiceId)!;
        const covRows = coverageRowsByInvoice.get(inv.id)!;
        const legacyOcc = legacyByInvoice.get(inv.id) || 0;

        const invRowOccTotal = covRows.reduce(
          (s, r) => s + (rowOccupied.get(rowKey(inv.id, r.orderId)) || 0),
          0,
        );
        const invoiceOutstanding = inv.totalAmount - invRowOccTotal - legacyOcc;

        if (invoiceOutstanding < alloc.amount) {
          throw new AllocationReceiptError(
            `发票 ${inv.id} 剩余可核销金额 (¥${centsToYuan(invoiceOutstanding)}) 不足本次分摊 (¥${centsToYuan(alloc.amount)})`,
            409,
            {
              error: "CONCURRENT_OVERPAYMENT",
              invoiceId: alloc.invoiceId,
              outstanding: invoiceOutstanding,
              requested: alloc.amount,
            },
          );
        }
        if (alloc.amount !== invoiceOutstanding) {
          throw new AllocationReceiptError(
            `发票 ${inv.id} 分摊金额 (¥${centsToYuan(alloc.amount)}) 必须等于其剩余金额 (¥${centsToYuan(invoiceOutstanding)})，本轮不支持部分核销`,
            400,
            {
              error: "PARTIAL_ALLOCATION_NOT_ALLOWED",
              invoiceId: alloc.invoiceId,
              outstanding: invoiceOutstanding,
              requested: alloc.amount,
            },
          );
        }

        let rowRemainingSum = 0;
        for (const row of covRows) {
          const occ = rowOccupied.get(rowKey(inv.id, row.orderId)) || 0;
          const rowLegacy = covRows.length === 1 ? legacyOcc : 0;
          const rowRemaining = row.amount - occ - rowLegacy;
          if (rowRemaining < 0) {
            throw new AllocationReceiptError(
              `发票 ${inv.id} 订单 ${row.orderId.slice(-6)} 的已核销金额超过分摊额，数据异常`,
              409,
              { error: "COVERAGE_ROW_OVERPAID", invoiceId: inv.id, orderId: row.orderId },
            );
          }
          if (rowRemaining === 0) continue;
          rowRemainingSum += rowRemaining;

          const created = await tx.financeReceiptAllocation.create({
            data: {
              receiptId: receipt.id,
              invoiceId: inv.id,
              orderId: row.orderId,
              amount: rowRemaining,
              createdById: userId,
            },
          });
          rowOccupied.set(rowKey(inv.id, row.orderId), occ + rowRemaining);
          orderBreakdown.set(row.orderId, (orderBreakdown.get(row.orderId) || 0) + rowRemaining);
          createdAllocations.push({
            invoiceId: created.invoiceId,
            orderId: created.orderId,
            amount: created.amount,
            newOutstanding: 0,
          });
        }

        if (rowRemainingSum !== invoiceOutstanding) {
          throw new AllocationReceiptError(
            `发票 ${inv.id} 各订单剩余合计 (¥${centsToYuan(rowRemainingSum)}) 与发票剩余 (¥${centsToYuan(invoiceOutstanding)}) 不一致，无法核销`,
            400,
            {
              error: "COVERAGE_ALLOCATION_MISMATCH",
              invoiceId: inv.id,
              rowRemainingSum,
              invoiceOutstanding,
            },
          );
        }
      }

      const finalAllocRowSums = await tx.financeReceiptAllocation.groupBy({
        by: ["invoiceId", "orderId"],
        where: {
          invoiceId: { in: invoiceIds },
          receipt: { deleted: false },
        },
        _sum: { amount: true },
      });
      const finalRowOccupied = new Map<string, number>();
      for (const s of finalAllocRowSums) {
        finalRowOccupied.set(
          rowKey(s.invoiceId, s.orderId),
          (finalRowOccupied.get(rowKey(s.invoiceId, s.orderId)) || 0) + (s._sum.amount || 0),
        );
      }
      for (const inv of invoices) {
        const covRows = coverageRowsByInvoice.get(inv.id)!;
        for (const row of covRows) {
          const occ = finalRowOccupied.get(rowKey(inv.id, row.orderId)) || 0;
          const legacyOcc = covRows.length === 1 ? (legacyByInvoice.get(inv.id) || 0) : 0;
          if (occ + legacyOcc > row.amount) {
            throw new AllocationReceiptError(
              "并发核销冲突：coverage 行累计核销金额超过分摊金额",
              409,
              {
                error: "CONCURRENT_OVERPAYMENT",
                invoiceId: inv.id,
                orderId: row.orderId,
                totalOccupied: occ + legacyOcc,
                coverageAmount: row.amount,
              },
            );
          }
        }
      }

      return { receipt, allocations: createdAllocations, orderBreakdown };
    });

    return {
      receipt: {
        id: result.receipt.id,
        amountCents: result.receipt.amount,
        receivedAt: result.receipt.receivedAt,
        source: result.receipt.source,
      },
      allocations: result.allocations.map((a) => ({
        invoiceId: a.invoiceId,
        orderId: a.orderId,
        amountCents: a.amount,
        newOutstandingCents: a.newOutstanding,
      })),
      crossOrder: result.orderBreakdown.size > 1,
      orderBreakdown: Array.from(result.orderBreakdown.entries()).map(([orderId, sum]) => ({
        orderId,
        sumCents: sum,
      })),
    };
  } catch (err: unknown) {
    if (err instanceof AllocationReceiptError) throw err;

    // 唯一约束冲突 → 幂等返回已有回款（跨 proposal 重试安全）。
    // P2002 可能命中 workspace+row 复合键或 sourceAgentProposalId 唯一键，
    // 统一按本次调用携带的键回查。
    const prismaErr = err as { code?: string; meta?: { target?: string | string[] } };
    if (prismaErr.code === "P2002" && (hasIdempotencyKey || hasProposalKey)) {
      const existing = await findExistingByIdempotencyKey();
      if (existing) {
        return buildReplayResult(existing);
      }
    }

    const e = err as { status?: number; body?: Record<string, unknown>; message?: string };
    if (e.status === 400 || e.status === 409) {
      throw new AllocationReceiptError(e.message || "核销失败", e.status, e.body);
    }
    throw err;
  }
}

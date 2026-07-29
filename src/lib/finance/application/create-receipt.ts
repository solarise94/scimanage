/**
 * Canonical actor-aware create receipt command (T6.5).
 *
 * Shared by Web POST /api/finance/receipts (allocation branch) and Agent
 * `finance.create_receipt`. All invoice-linked paths require full touched-order
 * scope before allocation write.
 *
 * P1-2 #5（propose_receipt 断链修复）：create_receipt 支持两条等价输入路径：
 *  1. allocations（原始路径，Web 直传 / Agent 旧路径）：caller 显式提供每张发票的核销金额；
 *  2. selectedOptionId（Agent propose_receipt 路径）：caller 只传发票 id，service 内部
 *     按 (actor, organizationId, amountYuan) **重跑确定性 match**，校验该发票 id ∈ 本次
 *     匹配候选集（不在 → 404；outstanding 不足 → 400），由候选推导 allocations。
 *
 * match 确定性论证（重跑与上次结果一致）：
 *  - queryPaymentMatchForActor(actor, {organizationId, amountCents}) 是纯查询，输入相同
 *    则候选发票集相同（Prisma where 子句固定 + orderBy actualIssuedAt asc nulls last）；
 *  - subsetSumMatch 是确定性算法（items 排序后 DP + DFS 固定遍历序）；
 *  - outstanding 来自 loadInvoiceOutstandingAmounts（基于 DB 当前事实的确定性计算）。
 *  因此在 match→create_receipt 的短时间窗内（proposal PENDING 期间），只要没有并发核销
 *  改变候选集，重跑 match 必然得到与上次相同的候选列表。若并发核销导致 selectedOptionId
 *  不再 ∈ 候选集，service 层 fail-closed 拒绝（404/400），agent 重新 match 即可。
 */
import type { BusinessActor, InvocationContext } from "@/lib/application/actor";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/application/errors";
import {
  AllocationReceiptError,
  createAllocationReceipt,
  type CreateAllocationReceiptResult,
} from "@/lib/finance/create-allocation-receipt";
import { canWriteFinance } from "@/lib/finance/permissions";
import { resolveInvoiceTouchedOrderIds } from "@/lib/finance/order-invoice-access";
import { yuanToCents, centsToYuan } from "@/lib/finance/money";
import { prisma } from "@/lib/prisma";
import { assertFullOrderScopeForActor } from "@/lib/finance/application/invoice-order-scope";
import { queryPaymentMatchForActor } from "@/lib/finance/application/query-payment-match";

export type CreateReceiptAllocationInput = {
  invoiceId: string;
  /** 分配金额，单位：元 */
  amountYuan: number;
};

export type CreateReceiptCommandInput = {
  /** 回款金额，单位：元 */
  amountYuan: number;
  receivedAt?: string;
  source?: string;
  remark?: string | null;
  organizationId: string;
  /**
   * 发票分配明细。与 selectedOptionId 互斥（二者必居其一）：
   *  - 显式 allocations（Web 直传 / Agent 旧路径）：caller 提供每张发票核销金额；
   *  - selectedOptionId（Agent propose_receipt 路径）：只传发票 id，service 重跑 match 推导。
   */
  allocations?: CreateReceiptAllocationInput[];
  /**
   * Agent propose_receipt 路径：发票 id。service 按 (actor, organizationId, amountYuan)
   * 重跑确定性 match，校验该 id ∈ 候选集后推导 allocations。与 allocations 互斥。
   */
  selectedOptionId?: string;
  sourceWorkspaceId?: string;
  sourceRowIndex?: number;
  /**
   * Agent proposal 级幂等键。只能由服务端从 ctx.invocation.proposalId 注入
   * （见 finance.create_receipt action execute），不得来自客户端输入。
   */
  sourceAgentProposalId?: string | null;
};

export type CreateReceiptPreview = {
  title: string;
  summary: string;
  target: { type: "organization"; id: string };
  displayProps: { organizationName: string };
};

const INVOICE_ACCESS_DENIED = "发票不存在或不可访问";

function assertCreateReceiptCapability(actor: BusinessActor): void {
  if (!canWriteFinance(actor.role)) {
    throw new ForbiddenError("无权创建回款");
  }
}

/**
 * 校验 input 的 allocations / selectedOptionId 互斥与必居其一。
 * 返回归一化后的有效输入（含 allocations 数组，selectedOptionId 路径已解析）。
 */
function assertAllocationsOrOption(input: CreateReceiptCommandInput): {
  hasAllocations: boolean;
  hasOption: boolean;
} {
  const hasAllocations = Array.isArray(input.allocations) && input.allocations.length > 0;
  const hasOption = typeof input.selectedOptionId === "string" && input.selectedOptionId.trim().length > 0;
  if (hasAllocations && hasOption) {
    throw new ValidationError("allocations 与 selectedOptionId 互斥，不可同时提供");
  }
  if (!hasAllocations && !hasOption) {
    throw new ValidationError("必须提供 allocations 或 selectedOptionId 之一");
  }
  return { hasAllocations, hasOption };
}

/**
 * P1-2 #5：selectedOptionId → allocations 解析（service 权威）。
 *
 * 按 (actor, organizationId, amountYuan) 重跑确定性 match，校验 selectedOptionId ∈ 候选集：
 *  - 候选集中无该发票 id → NotFoundError（候选不存在或不在本次匹配结果中）；
 *  - 候选 outstanding < amountCents → ValidationError（该候选可核销金额不足）；
 *  - 通过 → allocations = [{ invoiceId: selectedOptionId, amountYuan: min(outstanding, amountYuan) }]。
 *
 * 单候选精确匹配时 amountYuan === outstanding，全额核销；用户在多候选中选定某张时
 * 按其 outstanding 核销（若 outstanding > amountYuan 则只核销 amountYuan）。
 */
export async function resolveAllocationsFromMatch(
  actor: BusinessActor,
  input: CreateReceiptCommandInput,
): Promise<CreateReceiptAllocationInput[]> {
  const amountCents = yuanToCents(input.amountYuan);
  const matchResult = await queryPaymentMatchForActor(actor, {
    organizationId: input.organizationId,
    amountCents,
  });

  const candidate = matchResult.candidateInvoices.find((c) => c.id === input.selectedOptionId);
  if (!candidate) {
    throw new NotFoundError(
      `选定的发票不在本次匹配候选中（可能已被核销或不在可见范围），请重新发起匹配`,
    );
  }
  if (candidate.outstanding < amountCents) {
    throw new ValidationError(
      `选定发票可核销余额 ${centsToYuan(candidate.outstanding).toFixed(2)} 元不足回款金额 ${input.amountYuan.toFixed(2)} 元`,
    );
  }
  return [
    {
      invoiceId: candidate.id,
      amountYuan: input.amountYuan,
    },
  ];
}

function validateAllocationTotals(allocations: CreateReceiptAllocationInput[], amountYuan: number): void {
  const amountCents = yuanToCents(amountYuan);
  const allocTotalCents = allocations.reduce(
    (sum, row) => sum + yuanToCents(row.amountYuan),
    0,
  );
  if (allocTotalCents !== amountCents) {
    throw new ValidationError(
      `分配合计 ${amountYuan.toFixed(2)} 元与回款金额不一致`,
    );
  }
}

async function assertCreateReceiptInvoiceScope(
  actor: BusinessActor,
  invoiceIds: string[],
): Promise<void> {
  const uniqueIds = [...new Set(invoiceIds)];
  const invoices = await prisma.externalOrderInvoiceRequest.findMany({
    where: { id: { in: uniqueIds } },
    select: { id: true },
  });
  if (invoices.length !== uniqueIds.length) {
    throw new NotFoundError(INVOICE_ACCESS_DENIED);
  }

  for (const invoiceId of uniqueIds) {
    const touchedOrderIds = await resolveInvoiceTouchedOrderIds(invoiceId);
    try {
      await assertFullOrderScopeForActor(actor, touchedOrderIds);
    } catch (err) {
      if (err instanceof NotFoundError) {
        throw new NotFoundError(INVOICE_ACCESS_DENIED);
      }
      throw err;
    }
  }
}

export async function previewCreateReceiptForActor(
  actor: BusinessActor,
  input: CreateReceiptCommandInput,
): Promise<CreateReceiptPreview> {
  assertCreateReceiptCapability(actor);
  assertAllocationsOrOption(input);

  // selectedOptionId 路径：service 重跑确定性 match 解析为 allocations（校验候选归属）。
  let allocations = input.allocations;
  if (!allocations || allocations.length === 0) {
    allocations = await resolveAllocationsFromMatch(actor, input);
  }
  validateAllocationTotals(allocations, input.amountYuan);

  const invoiceIds = allocations.map((row) => row.invoiceId);
  await assertCreateReceiptInvoiceScope(actor, invoiceIds);

  const org = await prisma.organization.findUnique({
    where: { id: input.organizationId },
    select: { canonicalName: true },
  });
  if (!org) {
    throw new NotFoundError("付款机构不存在");
  }

  // P1-2 #8：proposal 内容展示最终选定的候选发票与金额。
  const invoiceLabels = await prisma.externalOrderInvoiceRequest.findMany({
    where: { id: { in: invoiceIds } },
    select: { id: true, actualInvoiceNo: true, buyerOrganizationName: true },
  });
  const labelById = new Map(invoiceLabels.map((inv) => [inv.id, inv]));
  const invoiceSummary = allocations
    .map((row) => {
      const inv = labelById.get(row.invoiceId);
      const no = inv?.actualInvoiceNo || row.invoiceId.slice(-6);
      return `${no}（¥${row.amountYuan.toFixed(2)}）`;
    })
    .join("、");

  return {
    title: `创建回款：${org.canonicalName}`,
    summary:
      `将为「${org.canonicalName}」创建回款记录 ${input.amountYuan.toFixed(2)} 元，` +
      `核销 ${allocations.length} 张发票：${invoiceSummary}。`,
    target: { type: "organization", id: input.organizationId },
    displayProps: { organizationName: org.canonicalName ?? "未知单位" },
  };
}

export async function createReceiptForActor(
  actor: BusinessActor,
  input: CreateReceiptCommandInput,
  opts: { invocation?: InvocationContext } = {},
): Promise<CreateAllocationReceiptResult> {
  assertCreateReceiptCapability(actor);
  assertAllocationsOrOption(input);

  // selectedOptionId 路径：service 重跑确定性 match 解析为 allocations（校验候选归属）。
  // 注意：execute 是 confirm 后的最终写入，此时重跑 match 会反映 confirm 期间的最新事实；
  // 若并发核销导致 selectedOptionId 不再 ∈ 候选，这里 fail-closed 拒绝（404/400）。
  let allocations = input.allocations;
  if (!allocations || allocations.length === 0) {
    allocations = await resolveAllocationsFromMatch(actor, input);
  }
  // 注意：execute 路径不做 validateAllocationTotals（总额校验由 createAllocationReceipt
  // 内部完成，且 scope check 必须先于总额校验——见 create-receipt.test.ts 跨 scope 场景）。

  const invoiceIds = allocations.map((row) => row.invoiceId);
  await assertCreateReceiptInvoiceScope(actor, invoiceIds);

  // Phase E（P0-3）：Agent 回款核销——early pre-check + 最终写事务内复核。
  let agentTouchedOrderIds: string[] = [];
  if (opts.invocation?.channel === "agent") {
    const touchedOrderIds = new Set<string>();
    for (const invoiceId of invoiceIds) {
      const ids = await resolveInvoiceTouchedOrderIds(invoiceId);
      for (const oid of ids) touchedOrderIds.add(oid);
    }
    agentTouchedOrderIds = [...touchedOrderIds];
    if (agentTouchedOrderIds.length > 0) {
      const { assertAgentCanWriteOrders } = await import("@/lib/orders/application/technical-owner-gate");
      await assertAgentCanWriteOrders(actor, opts.invocation, agentTouchedOrderIds);
    }
  }

  try {
    return await createAllocationReceipt({
      userId: actor.userId,
      role: actor.role,
      // Fail-closed（设计 §6.1）：actor.department 缺失时留 undefined，由下游从 DB 实时解析；
      // 不再兜底 FIELD_SALES。
      department: actor.department,
      amountYuan: input.amountYuan,
      receivedAt: input.receivedAt,
      source: input.source,
      remark: input.remark,
      organizationId: input.organizationId,
      allocations,
      sourceWorkspaceId: input.sourceWorkspaceId,
      sourceRowIndex: input.sourceRowIndex,
      sourceAgentProposalId: input.sourceAgentProposalId,
      skipOrderScopeCheck: true,
      agentOwnerRecheck:
        opts.invocation?.channel === "agent"
          ? { actor, invocation: opts.invocation, orderIds: agentTouchedOrderIds }
          : undefined,
    });
  } catch (err) {
    if (err instanceof AllocationReceiptError && err.status === 403) {
      throw new NotFoundError(INVOICE_ACCESS_DENIED);
    }
    throw err;
  }
}

export type { CreateAllocationReceiptResult };
export { AllocationReceiptError };

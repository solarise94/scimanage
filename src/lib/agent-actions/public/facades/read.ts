/**
 * Phase B: public read facade handlers（find/get）。
 *
 * 每个 handler：
 *  1. 直接读 publicInput 中的真实 id（*Id 字段），不再做 ref 解密；
 *  2. 调 internal action（runAgentToolForActor），绝不直连 canonical service/Prisma；
 *  3. 透传结果实体真实 id 给模型（不再做 id 包装）；
 *  4. 歧义 → needs_selection + options（不让模型猜 profileId/orderId）。
 *
 * 授权边界完全留给 canonical service（id AND actorScope gate）。资源不存在或越权
 * 在 service 层合并成同一 NotFoundError，由 public-executor.errorToOutcome 翻译为 404。
 *
 * REP/RM 投影：
 *  - get_order（REP）：只返回 scoped 订单 + receiptState（UNPAID|PARTIAL|PAID），剥金额/invoice。
 *  - get_order（RM/内部员工）：完整财务摘要。
 *
 * 本文件被 public-executor.ts 在 Phase B 初始化时 registerPublicFacade。
 * 本文件零 Prisma（经 internal action 调度）。
 */
import type { AgentExecutionContext } from "@/lib/agent-actions/types";
import type { BusinessActor } from "@/lib/application/actor";
import { isRepresentative } from "@/lib/role-guards";
import { runAgentToolForActor } from "@/lib/agent-actions/execute-tool-for-run";
import type { PublicFacadeResult } from "../public-executor";

/** 读 publicInput 中的字符串 id 字段；空/缺失返回 ""（由下游 service 校验存在性 → 404）。 */
function readId(input: Record<string, unknown>, field: string): string {
  const v = input[field];
  return typeof v === "string" ? v : "";
}

/**
 * P2-1：统一 find_* 的 resolution 字段。
 *  - 0 命中 → NO_MATCH（模型应补搜索条件）
 *  - 1 命中 → UNIQUE（读操作可自动继续 get）
 *  - >1 命中 → AMBIGUOUS（必须用户点选）
 */
function resolutionOf(itemCount: number): "NO_MATCH" | "UNIQUE" | "AMBIGUOUS" {
  if (itemCount === 0) return "NO_MATCH";
  if (itemCount === 1) return "UNIQUE";
  return "AMBIGUOUS";
}

// ── find_customers ──

export async function findCustomersFacade(
  ctx: AgentExecutionContext,
  input: Record<string, unknown>,
): Promise<PublicFacadeResult> {
  const query = typeof input.query === "string" ? input.query : "";
  const stage = typeof input.stage === "string" ? input.stage : undefined;
  const outcome = await runAgentToolForActor(ctx, "crm.search_customers", { query, stage });
  // crm.search_customers 统一 CRM profile 口径：items 字段为 profileId/customerName/organization
  // （2026-07-27 demo flag-on 实测：误读 id/name 导致模型侧 customerId 全空、无法点选）。
  const result = outcome.result as {
    items?: Array<{ profileId?: string; customerName?: string; organization?: string }>;
    resolution?: string;
  };
  const items = result.items ?? [];
  const resolution = result.resolution ?? resolutionOf(items.length);
  return {
    mode: resolution === "AMBIGUOUS" ? "needs_input" : "result",
    modelFacing: {
      resolution,
      items: items.map((c) => ({
        customerId: c.profileId ?? "",
        name: c.customerName,
        organization: c.organization,
      })),
      ...(resolution === "AMBIGUOUS"
        ? { needsSelection: true, optionType: "customer" as const }
        : {}),
    },
    needsSelection: resolution === "AMBIGUOUS",
    optionType: resolution === "AMBIGUOUS" ? "customer" : undefined,
    internalActionsCalled: ["crm.search_customers"],
  };
}

// ── get_customer ──

export async function getCustomerFacade(
  ctx: AgentExecutionContext,
  input: Record<string, unknown>,
): Promise<PublicFacadeResult> {
  const profileId = readId(input, "customerId");
  const outcome = await runAgentToolForActor(ctx, "crm.get_customer_context", { profileId });
  return {
    mode: "result",
    modelFacing: { customer: outcome.result },
    internalActionsCalled: ["crm.get_customer_context"],
  };
}

// ── find_projects ──

export async function findProjectsFacade(
  ctx: AgentExecutionContext,
  input: Record<string, unknown>,
): Promise<PublicFacadeResult> {
  const outcome = await runAgentToolForActor(ctx, "projects.search", {
    query: typeof input.query === "string" ? input.query : undefined,
    status: typeof input.status === "string" ? input.status : undefined,
  });
  const result = outcome.result as { items?: Array<{ id?: string; name?: string }> };
  const items = result.items ?? [];
  const resolution = resolutionOf(items.length);
  return {
    mode: "result",
    modelFacing: {
      resolution,
      items: items.map((p) => ({
        projectId: p.id ?? "",
        name: p.name,
      })),
    },
    internalActionsCalled: ["projects.search"],
  };
}

// ── get_project ──

export async function getProjectFacade(
  ctx: AgentExecutionContext,
  input: Record<string, unknown>,
): Promise<PublicFacadeResult> {
  const projectId = readId(input, "projectId");
  const outcome = await runAgentToolForActor(ctx, "projects.get_summary", { projectId });
  return {
    mode: "result",
    modelFacing: { project: outcome.result },
    internalActionsCalled: ["projects.get_summary"],
  };
}

// ── find_orders ──

export async function findOrdersFacade(
  ctx: AgentExecutionContext,
  input: Record<string, unknown>,
): Promise<PublicFacadeResult> {
  const actor: BusinessActor = ctx.actor;

  // REPRESENTATIVE：不接 financialView，走受限投影（粗粒度收款状态，剥金额）。
  if (isRepresentative(actor.role)) {
    const outcome = await runAgentToolForActor(ctx, "orders.search", {
      query: typeof input.query === "string" ? input.query : undefined,
      status: typeof input.status === "string" ? input.status : undefined,
    });
    const result = outcome.result as { items?: Array<{ id?: string; orderNo?: string; title?: string }> };
    const items = result.items ?? [];
    const resolution = resolutionOf(items.length);
    return {
      mode: "result",
      modelFacing: {
        resolution,
        items: items.map((o) => ({
          orderId: o.id ?? "",
          orderNo: o.orderNo,
          title: o.title,
        })),
        // REP 投影：financialView 不返回；receiptState 由 get_order 计算。
      },
      internalActionsCalled: ["orders.search"],
    };
  }

  // 内部员工 / RM：走 orders.find_with_financial_view。
  const financialView =
    input.financialView === "pending_receipt" || input.financialView === "settled"
      ? (input.financialView as "pending_receipt" | "settled")
      : "any";
  const outcome = await runAgentToolForActor(ctx, "orders.find_with_financial_view", {
    query: typeof input.query === "string" ? input.query : undefined,
    status: typeof input.status === "string" ? input.status : undefined,
    financialView,
  });
  const result = outcome.result as {
    items?: Array<{ id?: string; orderNo?: string; title?: string; status?: string }>;
    outstandingAmount?: number;
    truncated?: boolean;
  };
  const items = result.items ?? [];
  const resolution = resolutionOf(items.length);
  return {
    mode: "result",
    modelFacing: {
      resolution,
      financialView,
      items: items.map((o) => ({
        orderId: o.id ?? "",
        orderNo: o.orderNo,
        title: o.title,
        status: o.status,
      })),
      ...(financialView === "pending_receipt"
        ? { outstandingAmount: result.outstandingAmount, truncated: result.truncated }
        : {}),
    },
    internalActionsCalled: ["orders.find_with_financial_view"],
  };
}

// ── get_order（含 REP 受限投影 / RM 完整财务摘要）──

export async function getOrderFacade(
  ctx: AgentExecutionContext,
  input: Record<string, unknown>,
): Promise<PublicFacadeResult> {
  const orderId = readId(input, "orderId");
  const outcome = await runAgentToolForActor(ctx, "orders.get_detail", { orderId });
  const detail = outcome.result as Record<string, unknown>;

  if (isRepresentative(ctx.actor.role)) {
    // REP 投影：剥金额/invoice/allocation/financialView；只保留 receiptState 粗粒度。
    return {
      mode: "result",
      modelFacing: projectReceiptStateForRep(detail),
      internalActionsCalled: ["orders.get_detail"],
    };
  }

  return {
    mode: "result",
    modelFacing: { order: detail },
    internalActionsCalled: ["orders.get_detail"],
  };
}

/**
 * REP 受限 receiptState 投影（§4.1.2）。
 *
 * 口径（独立于 settled）：
 *  - 有效财务金额 ≤ 0 → 不返回 badge（不把"无应收"误标为已付款）；
 *  - 有效财务金额 > 0 且有效回款 = 0 → UNPAID；
 *  - 0 < 有效回款 < 有效财务金额 → PARTIAL；
 *  - 有效回款 ≥ 有效财务金额 → PAID。
 *
 * PAID 只表示订单应收已收齐；不等价 settled（后者还要求开票完整）。
 * 输出不含用于计算的金额、发票、allocation 或原因明细。
 *
 * 计算所需金额字段来自 internal orders.get_detail 的财务摘要（内部员工可见）；
 * REP 投影只暴露 badge，金额字段在投影中被剥除。
 */
function projectReceiptStateForRep(detail: Record<string, unknown>): Record<string, unknown> {
  const finance = (detail.finance ?? detail.financeSummary ?? {}) as Record<string, unknown>;
  const financeAmountCents = typeof finance.financeAmount === "number" ? finance.financeAmount : 0;
  const receivedAmountCents = typeof finance.receiptAmount === "number" ? finance.receiptAmount : 0;

  let receiptState: string | null = null;
  if (financeAmountCents > 0) {
    if (receivedAmountCents <= 0) receiptState = "UNPAID";
    else if (receivedAmountCents < financeAmountCents) receiptState = "PARTIAL";
    else receiptState = "PAID";
  }

  // 剥除金额/invoice/allocation/financialView/finance 明细。
  const stripped: Record<string, unknown> = {};
  const FORBIDDEN_FOR_REP = new Set([
    "finance",
    "financeSummary",
    "financialView",
    "totalAmount",
    "invoicedAmount",
    "receivedAmount",
    "invoiceRequests",
    "invoices",
    "allocations",
    "receipts",
    "unpaidAmount",
    "outstandingAmount",
    "financeAmount",
  ]);
  for (const [key, value] of Object.entries(detail)) {
    if (!FORBIDDEN_FOR_REP.has(key)) {
      stripped[key] = value;
    }
  }
  if (receiptState) {
    stripped.receiptState = receiptState;
  }
  return { order: stripped };
}

// ── find_tickets ──

export async function findTicketsFacade(
  ctx: AgentExecutionContext,
  input: Record<string, unknown>,
): Promise<PublicFacadeResult> {
  const projectId = readId(input, "projectId");
  const outcome = await runAgentToolForActor(ctx, "tickets.list", {
    projectId,
    status: typeof input.status === "string" ? input.status : undefined,
  });
  const result = outcome.result as {
    items?: Array<{ id?: string; title?: string; status?: string }>;
  };
  const items = result.items ?? [];
  const resolution = resolutionOf(items.length);
  return {
    mode: "result",
    modelFacing: {
      resolution,
      items: items.map((t) => ({
        ticketId: t.id ?? "",
        title: t.title,
        status: t.status,
      })),
    },
    internalActionsCalled: ["tickets.list"],
  };
}

// ── find_contracts ──

export async function findContractsFacade(
  ctx: AgentExecutionContext,
  input: Record<string, unknown>,
): Promise<PublicFacadeResult> {
  const payload: Record<string, unknown> = {};
  const orderId = readId(input, "orderId");
  const customerId = readId(input, "customerId");
  if (orderId) payload.orderId = orderId;
  if (customerId) payload.profileId = customerId;
  if (typeof input.status === "string") payload.status = input.status;
  const outcome = await runAgentToolForActor(ctx, "contracts.list", payload);
  const result = outcome.result as {
    contracts?: Array<{ id?: string; contractNo?: string; status?: string; buyerOrgName?: string | null }>;
  };
  const items = result.contracts ?? [];
  const resolution = resolutionOf(items.length);
  return {
    mode: "result",
    modelFacing: {
      resolution,
      items: items.map((c) => ({
        contractId: c.id ?? "",
        contractNo: c.contractNo,
        status: c.status,
        buyerOrgName: c.buyerOrgName,
      })),
    },
    internalActionsCalled: ["contracts.list"],
  };
}

// ── get_contract ──

export async function getContractFacade(
  ctx: AgentExecutionContext,
  input: Record<string, unknown>,
): Promise<PublicFacadeResult> {
  const contractId = readId(input, "contractId");
  const outcome = await runAgentToolForActor(ctx, "contracts.get_detail", { contractId });
  return {
    mode: "result",
    modelFacing: { contract: outcome.result },
    internalActionsCalled: ["contracts.get_detail"],
  };
}

// ── get_invoice ──

export async function getInvoiceFacade(
  ctx: AgentExecutionContext,
  input: Record<string, unknown>,
): Promise<PublicFacadeResult> {
  const invoiceId = readId(input, "invoiceId");
  const outcome = await runAgentToolForActor(ctx, "finance.get_invoice_detail", { invoiceId });
  return {
    mode: "result",
    modelFacing: { invoice: outcome.result },
    internalActionsCalled: ["finance.get_invoice_detail"],
  };
}

// ── list_contract_templates（contextual：用户要换模板时返回 options）──

export async function listContractTemplatesFacade(
  ctx: AgentExecutionContext,
  input: Record<string, unknown>,
): Promise<PublicFacadeResult> {
  const outcome = await runAgentToolForActor(ctx, "contracts.list_templates", {
    category: typeof input.category === "string" ? input.category : undefined,
  });
  return {
    mode: "result",
    modelFacing: { templates: outcome.result },
    internalActionsCalled: ["contracts.list_templates"],
  };
}

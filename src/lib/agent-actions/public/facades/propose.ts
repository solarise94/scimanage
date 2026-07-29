/**
 * Phase C: public propose facade handlers。
 *
 * 修正 7 关键：propose_order 不在 propose 阶段落订单。链路：
 *   prepare_order → GenUI PATCH → propose_order(orderDraftId) → createAgentProposal
 *   → confirm → internal orders.create_from_draft → canonical createOrderFromDraftForActor。
 *
 * P0-3c：facade 只调已登记 internal action（orders.prepare_draft/get_draft/create_from_draft），
 * 绝不直连 canonical service。
 *
 * 所有 propose_* 经 runAgentToolForActor（confirm action → createAgentProposal）。
 * 本文件零 Prisma（经 internal action）。
 *
 * 授权边界留给 canonical service（id AND actorScope gate）；public layer 直接透传真实 id。
 */
import type { AgentExecutionContext } from "@/lib/agent-actions/types";
import { runAgentToolForActor } from "@/lib/agent-actions/execute-tool-for-run";
import type { PublicFacadeResult } from "../public-executor";

/** 读 publicInput 中的字符串 id 字段；空/缺失返回 ""（由下游 service 校验存在性 → 404）。 */
function readId(input: Record<string, unknown>, field: string): string {
  const v = input[field];
  return typeof v === "string" ? v : "";
}

// ── prepare_order（preview/agent-owned draft）──

export async function prepareOrderFacade(
  ctx: AgentExecutionContext,
  input: Record<string, unknown>,
): Promise<PublicFacadeResult> {
  const customerProfileId = readId(input, "customerId");

  // P0-3c：经 internal orders.prepare_draft action（不直连 canonical service）。
  const outcome = await runAgentToolForActor(ctx, "orders.prepare_draft", { customerProfileId });
  const draft = outcome.result as {
    orderDraftId: string;
    version: number;
    productOptions: unknown[];
    projectTypeOptions: unknown[];
    needsSelection: boolean;
  };

  return {
    mode: "preview",
    modelFacing: {
      orderDraftId: draft.orderDraftId,
      version: draft.version,
      productOptions: draft.productOptions,
      projectTypeOptions: draft.projectTypeOptions,
      needsSelection: draft.needsSelection,
      patchEndpoint: `/api/agent/order-drafts/${draft.orderDraftId}`,
      nextStep: "用户在 GenUI 卡片选产品/项目类型/数量/单价后，调 propose_order(orderDraftId)",
    },
    // GenUI 填表 ≠ 多候选选卡；用 needsUserInput 暂停自动链，避免注入错误 domain propose。
    needsUserInput: draft.needsSelection,
    internalActionsCalled: ["orders.prepare_draft"],
  };
}

// ── propose_order（propose；不在 propose 阶段落单）──

export async function proposeOrderFacade(
  ctx: AgentExecutionContext,
  input: Record<string, unknown>,
): Promise<PublicFacadeResult> {
  const orderDraftId = readId(input, "orderDraftId");

  // P0-3c：经 internal orders.get_draft 只读校验草稿状态/行（不落单）。
  const getOutcome = await runAgentToolForActor(ctx, "orders.get_draft", { orderDraftId });
  const draft = getOutcome.result as {
    id: string;
    version: number;
    status: string;
    titleSnapshot: string | null;
    lines?: unknown[];
  };
  if (draft.status !== "DRAFT") {
    return {
      mode: "needs_input",
      modelFacing: { error: `草稿状态 ${draft.status}，不可提案`, needsUserInput: true },
      needsUserInput: true,
    };
  }
  if (!draft.titleSnapshot || (draft.lines?.length ?? 0) === 0) {
    return {
      mode: "needs_input",
      modelFacing: {
        error: "草稿尚无有效行（需先在 GenUI 选产品）",
        needsSelection: true,
        optionType: "order",
      },
      needsSelection: true,
      optionType: "order",
    };
  }

  // 经 internal orders.create_from_draft（confirm action）。
  // runAgentToolForActor 对 confirm action 走 createAgentProposal；
  // lifecycle（orders.create_from_draft）在 persist 锁定草稿（DRAFT→PROPOSED，带版本乐观锁，
  // 防并/防重复 pending proposal），revert 回 DRAFT，confirm 成功 execute 内 markOrderDraftConsumed。
  const outcome = await runAgentToolForActor(ctx, "orders.create_from_draft", {
    orderDraftId: draft.id,
    expectedVersion: draft.version,
  });
  return {
    mode: "proposal",
    modelFacing: {
      proposal: outcome.proposal ?? outcome.result,
      mode: outcome.mode,
      orderDraftId,
      note: "确认后将创建订单；草稿在确认成功后标记已消费。",
    },
    internalActionsCalled: ["orders.create_from_draft"],
  };
}

// ── propose_project ──

export async function proposeProjectFacade(
  ctx: AgentExecutionContext,
  input: Record<string, unknown>,
): Promise<PublicFacadeResult> {
  const outcome = await runAgentToolForActor(ctx, "projects.create", {
    name: typeof input.name === "string" ? input.name : "",
    budgetAmount: typeof input.budgetAmountYuan === "number" ? input.budgetAmountYuan : undefined,
  });
  return {
    mode: "proposal",
    modelFacing: { proposal: outcome.proposal ?? outcome.result, mode: outcome.mode },
    internalActionsCalled: ["projects.create"],
  };
}

// ── propose_ticket ──

export async function proposeTicketFacade(
  ctx: AgentExecutionContext,
  input: Record<string, unknown>,
): Promise<PublicFacadeResult> {
  const projectId = readId(input, "projectId");
  const outcome = await runAgentToolForActor(ctx, "tickets.create_from_text", {
    projectId,
    text: typeof input.text === "string" ? input.text : "",
  });
  return {
    mode: "proposal",
    modelFacing: { proposal: outcome.proposal ?? outcome.result, mode: outcome.mode },
    internalActionsCalled: ["tickets.create_from_text"],
  };
}

// ── propose_ticket_reply ──

export async function proposeTicketReplyFacade(
  ctx: AgentExecutionContext,
  input: Record<string, unknown>,
): Promise<PublicFacadeResult> {
  const ticketId = readId(input, "ticketId");
  const outcome = await runAgentToolForActor(ctx, "tickets.reply", {
    ticketId,
    content: typeof input.content === "string" ? input.content : "",
  });
  return {
    mode: "proposal",
    modelFacing: { proposal: outcome.proposal ?? outcome.result, mode: outcome.mode },
    internalActionsCalled: ["tickets.reply"],
  };
}

// ── propose_follow_up（未传 dueAt → 服务端默认下周五 18:00 Asia/Shanghai）──

export async function proposeFollowUpFacade(
  ctx: AgentExecutionContext,
  input: Record<string, unknown>,
): Promise<PublicFacadeResult> {
  const profileId = readId(input, "customerId");

  // §4.2.2：未传 dueAt → 服务端默认下一个有效周五 18:00 Asia/Shanghai；周五 00:00 起默认下周五。
  let dueAt: string;
  if (typeof input.dueAt === "string" && input.dueAt.trim()) {
    dueAt = input.dueAt.trim();
  } else {
    dueAt = computeDefaultFollowUpDueAt();
  }

  const outcome = await runAgentToolForActor(ctx, "crm.create_followup_task", {
    profileId,
    title: typeof input.title === "string" ? input.title : "",
    dueAt,
    taskType: typeof input.taskType === "string" ? input.taskType : "OTHER",
    // ownerUserId 由 internal action 服务端派生（当前 actor），不暴露给模型。
  });
  return {
    mode: "proposal",
    modelFacing: {
      proposal: outcome.proposal ?? outcome.result,
      mode: outcome.mode,
      dueAt,
      dueAtIsDefault: !(typeof input.dueAt === "string" && input.dueAt.trim()),
    },
    internalActionsCalled: ["crm.create_followup_task"],
  };
}

/**
 * 计算跟进任务默认 dueAt：下一个有效周五 18:00 Asia/Shanghai。
 * 周五 00:00（含）起默认下周五；其它日期默认本周五（若已过）或下周五。
 */
function computeDefaultFollowUpDueAt(): string {
  const now = new Date();
  // Asia/Shanghai = UTC+8
  const shanghaiOffsetMs = 8 * 60 * 60 * 1000;
  const nowShanghai = new Date(now.getTime() + shanghaiOffsetMs);
  const dayOfWeekShanghai = nowShanghai.getUTCDay(); // 0=Sun ... 5=Fri, 6=Sat

  let daysUntilFriday: number;
  if (dayOfWeekShanghai === 5) {
    // 周五（Shanghai 已过 00:00）→ 默认下周五
    daysUntilFriday = 7;
  } else if (dayOfWeekShanghai < 5) {
    // 周日~周四 → 本周五
    daysUntilFriday = 5 - dayOfWeekShanghai;
  } else {
    // 周六 → 下周五
    daysUntilFriday = 6;
  }

  // 目标：Shanghai 周五 18:00 → 转 UTC
  const targetShanghai = new Date(nowShanghai);
  targetShanghai.setUTCDate(targetShanghai.getUTCDate() + daysUntilFriday);
  targetShanghai.setUTCHours(18, 0, 0, 0);
  // targetShanghai 是 Shanghai 时区的"周五 18:00"表示，转回 UTC
  const targetUtc = new Date(targetShanghai.getTime() - shanghaiOffsetMs);
  return targetUtc.toISOString();
}

// ── propose_visit_checkin ──
//
// P0-4：prepare_visit_checkin 在服务端持久化一条 DRAFT CrmVisitCheckin（intent 锚点），
// 返回 checkinId。facade 透出 checkinId + 明确「create 必须携带此 checkinId」，
// 让 GenUI 卡片不再临场组装 proposalInput；GPS 仍由浏览器在用户点击「保存签到」时注入，
// onCreateProposal("crm.create_visit_checkin", { profileId, checkinId, lat, lng, ... })
// 由 create 侧一次性消费该 DRAFT（execute 时把 GPS 写回 DRAFT → completeVisitCheckin）。

export async function proposeVisitCheckinFacade(
  ctx: AgentExecutionContext,
  input: Record<string, unknown>,
): Promise<PublicFacadeResult> {
  const profileId = readId(input, "customerId");
  // prepare（safe，服务端落 DRAFT intent）→ 用户确认位置后 create_visit_checkin（confirm）
  const prepareOutcome = await runAgentToolForActor(ctx, "crm.prepare_visit_checkin", { profileId });
  const preparation = (prepareOutcome.result ?? {}) as {
    profileId?: string;
    customerName?: string;
    organization?: string;
    checkinId?: string;
  };
  return {
    mode: "preview",
    modelFacing: {
      preparation,
      // 显式锚点：浏览器必须在创建签到提案时携带该 checkinId，禁止临场编造。
      checkinId: preparation.checkinId ?? null,
      nextStep: "用户点击「保存签到」后用浏览器定位 + checkinId 创建签到确认提案",
    },
    internalActionsCalled: ["crm.prepare_visit_checkin"],
  };
}

// ── propose_invoice（订单/项目路径分流）──

type InvoiceReadyPlan = {
  planKey: string;
  mainOrderId: string;
  buyerOrganizationId: string;
  buyerOrganizationName: string;
  sellerProfileId: string | null;
  invoiceType: "NORMAL" | "SPECIAL" | null;
  coverageAllocations: Array<{ orderId: string; orderNo?: string; amountCents: number }>;
  items: Array<{ itemName: string; spec?: string | null; unit?: string | null; quantity?: number | null; amountCents: number }>;
  contentSummary?: string | null;
  missingFields?: string[];
  totalAmountCents?: number;
};

/**
 * 用一张 READY 计划构造 submit_invoice_request 输入并产 PENDING proposal。
 * 单独成函数：唯一计划自动提交 / 用户选定 planKey 命中后提交，复用同一构造逻辑。
 */
async function submitInvoicePlanForProject(
  ctx: AgentExecutionContext,
  projectId: string,
  target: InvoiceReadyPlan,
): Promise<PublicFacadeResult> {
  const submitInput = {
    projectId,
    mainOrderId: target.mainOrderId,
    coverageAllocations: target.coverageAllocations.map((a) => ({
      orderId: a.orderId,
      amountCents: a.amountCents,
    })),
    sellerProfileId: target.sellerProfileId!,
    buyerOrganizationId: target.buyerOrganizationId,
    buyerOrganizationName: target.buyerOrganizationName,
    invoiceType: target.invoiceType!,
    contentSummary: target.contentSummary ?? undefined,
    items: target.items.map((it) => ({
      itemName: it.itemName,
      spec: it.spec ?? undefined,
      unit: it.unit ?? undefined,
      quantity: it.quantity ?? undefined,
      amountCents: it.amountCents,
    })),
  };

  const submitOutcome = await runAgentToolForActor(ctx, "finance.submit_invoice_request", submitInput);
  return {
    mode: "proposal",
    modelFacing: {
      planKey: target.planKey,
      proposal: submitOutcome.proposal ?? submitOutcome.result,
      mode: submitOutcome.mode,
      nextStep: "已生成开票申请确认提案，等待用户确认后提交为待开票（REQUESTED）",
    },
    internalActionsCalled: ["finance.plan_project_invoice_requests", "finance.submit_invoice_request"],
  };
}

export async function proposeInvoiceFacade(
  ctx: AgentExecutionContext,
  input: Record<string, unknown>,
): Promise<PublicFacadeResult> {
  const orderId = readId(input, "orderId");
  const projectId = readId(input, "projectId");

  if (orderId) {
    // 订单路径：prepare_invoice_draft（confirm action）
    const outcome = await runAgentToolForActor(ctx, "finance.prepare_invoice_draft", {
      orderId,
      ...(typeof input.amountYuan === "number" ? { amountYuan: input.amountYuan } : {}),
      ...(typeof input.invoiceType === "string" ? { invoiceType: input.invoiceType } : {}),
    });
    return {
      mode: "proposal",
      modelFacing: { proposal: outcome.proposal ?? outcome.result, mode: outcome.mode },
      internalActionsCalled: ["finance.prepare_invoice_draft"],
    };
  }

  if (projectId) {
    // 项目路径：plan_*（safe 只读，落 plan intent）→ submit_*（confirm）产 PENDING proposal。
    // P0-4：facade 用 plan 结果构造 submit 输入并调用，使 createAgentProposal 真正落 PENDING 行。
    const planOutcome = await runAgentToolForActor(ctx, "finance.plan_project_invoice_requests", {
      projectId,
      ...(typeof input.invoiceType === "string" ? { invoiceType: input.invoiceType } : {}),
      ...(typeof input.amountYuan === "number" ? { requestedTotalAmountYuan: input.amountYuan } : {}),
    });
    const plan = (planOutcome.result ?? {}) as {
      status?: string;
      plans?: Array<{
        planKey: string;
        mainOrderId: string;
        buyerOrganizationId: string;
        buyerOrganizationName: string;
        sellerProfileId: string | null;
        invoiceType: "NORMAL" | "SPECIAL" | null;
        coverageAllocations: Array<{ orderId: string; orderNo?: string; amountCents: number }>;
        items: Array<{ itemName: string; spec?: string | null; unit?: string | null; quantity?: number | null; amountCents: number }>;
        contentSummary?: string | null;
        missingFields?: string[];
        totalAmountCents?: number;
      }>;
      questions?: Array<{ code: string; prompt: string }>;
      project?: { id: string; name?: string | null };
    };

    // 空计划 / 无可开票订单：不产 proposal，返回 needsUserInput。
    if (!plan.plans || plan.plans.length === 0) {
      return {
        mode: "needs_input",
        modelFacing: {
          plan,
          needsUserInput: true,
          nextStep: plan.questions?.[0]?.prompt ?? "无可开票订单，请补充销方主体/票种或先创建订单。",
        },
        needsUserInput: true,
        internalActionsCalled: ["finance.plan_project_invoice_requests"],
      };
    }

    // READY 计划：销方/票种齐备且无缺失字段。
    const readyPlans = plan.plans.filter(
      (p) =>
        p.sellerProfileId &&
        p.invoiceType &&
        (!p.missingFields || p.missingFields.length === 0),
    );

    // 用户已传 planKey（来自上次 needs_selection 返回的某张计划）：
    // 重新规划后按 planKey 找到对应计划提交。找不到 → 计划集已变化，needs_input 报错并附最新 plans。
    const inputPlanKey = typeof input.planKey === "string" ? input.planKey.trim() : "";
    if (inputPlanKey) {
      const selected = readyPlans.find((p) => p.planKey === inputPlanKey) ?? null;
      if (!selected) {
        return {
          mode: "needs_input",
          modelFacing: {
            error: "所选计划已变化或不存在，请重新确认当前可选计划",
            plan,
            plans: readyPlans.map((p) => ({
              planKey: p.planKey,
              mainOrderId: p.mainOrderId,
              buyerOrganizationName: p.buyerOrganizationName,
              totalAmountCents: p.totalAmountCents ?? 0,
            })),
            needsSelection: readyPlans.length > 0,
            optionType: "invoice_plan",
            nextStep:
              readyPlans.length > 0
                ? "请用户选择其中一张后，用 planKey 重新调用本工具"
                : "当前无可执行计划，请补充销方主体/票种后重新发起开票",
          },
          ...(readyPlans.length > 0
            ? { needsSelection: true, optionType: "invoice_plan" }
            : { needsUserInput: true }),
          internalActionsCalled: ["finance.plan_project_invoice_requests"],
        };
      }
      return submitInvoicePlanForProject(ctx, projectId, selected);
    }

    // 唯一 READY 计划：自动构造 submit 输入 → PENDING proposal。
    // 多计划或字段缺失（NEEDS_INPUT）：让用户/模型显式补充（serialByUser 不允许多 PENDING）。
    if (readyPlans.length !== 1) {
      return {
        mode: "needs_input",
        modelFacing: {
          plan,
          needsSelection: readyPlans.length === 0 ? false : true,
          optionType: "invoice_plan",
          plans:
            readyPlans.length > 0
              ? readyPlans.map((p) => ({
                  planKey: p.planKey,
                  mainOrderId: p.mainOrderId,
                  buyerOrganizationName: p.buyerOrganizationName,
                  totalAmountCents: p.totalAmountCents ?? 0,
                }))
              : undefined,
          nextStep:
            readyPlans.length === 0
              ? (plan.questions?.[0]?.prompt ?? "请补充销方主体/票种后重新发起开票")
              : "存在多张可执行计划，请用户选择其中一张后，用 planKey 重新调用本工具",
        },
        ...(readyPlans.length === 0 ? { needsUserInput: true } : { needsSelection: true, optionType: "invoice_plan" }),
        internalActionsCalled: ["finance.plan_project_invoice_requests"],
      };
    }

    return submitInvoicePlanForProject(ctx, projectId, readyPlans[0]);
  }

  return {
    mode: "needs_input",
    modelFacing: { error: "需提供 orderId 或 projectId", needsUserInput: true },
    needsUserInput: true,
  };
}

// ── propose_receipt（match → propose）──
//
// P1-2 #5 断链修复：facade 按 match_payment 结果分流：
//  - 精确唯一匹配（单候选且 outstanding === amountCents，或用户已传 selectedOptionId 且 ∈ 候选）
//    → 自动以 selectedOptionId 调 create_receipt 产 PENDING proposal（与 P0-4 统一模式）；
//  - 多候选 → needs_selection + options（候选发票列表），用户选定后传 selectedOptionId 再发起；
//  - 无候选 → needs_input（无可核销发票）。
// selectedOptionId 的候选归属校验在 service 层（create_receipt 重跑确定性 match），
// facade 只做结构分流（候选数 / selectedOptionId 是否提供）。

type MatchCandidateInvoice = {
  id: string;
  totalAmount: number;
  outstanding: number;
  buyerOrganizationName: string;
};

type MatchPaymentShapedResult = {
  status: "MATCHED" | "NO_EXACT_MATCH";
  amountCents: number;
  candidateCount: number;
  combinations: Array<{ invoiceIds: string[]; sum: number; count: number }>;
  candidateInvoices: MatchCandidateInvoice[];
};

export async function proposeReceiptFacade(
  ctx: AgentExecutionContext,
  input: Record<string, unknown>,
): Promise<PublicFacadeResult> {
  const organizationId = readId(input, "organizationId");
  const amountYuan = typeof input.amountYuan === "number" ? input.amountYuan : null;
  if (amountYuan == null) {
    return { mode: "needs_input", modelFacing: { error: "amountYuan is required", needsUserInput: true }, needsUserInput: true };
  }

  // 先 match_payment（只读，确定性）。internal action 期望 amount（元），facade publicInput 用 amountYuan。
  const matchOutcome = await runAgentToolForActor(ctx, "finance.match_payment", {
    organizationId,
    amount: amountYuan,
  });
  const matchResult = (matchOutcome.result ?? {}) as Partial<MatchPaymentShapedResult>;
  const candidates: MatchCandidateInvoice[] = Array.isArray(matchResult.candidateInvoices)
    ? matchResult.candidateInvoices
    : [];
  const selectedOptionId = typeof input.selectedOptionId === "string" ? input.selectedOptionId : "";

  // 用户已传 selectedOptionId：校验 ∈ 候选集后调 create_receipt（service 会再次重跑 match 权威校验）。
  if (selectedOptionId) {
    const inCandidates = candidates.some((c) => c.id === selectedOptionId);
    if (!inCandidates) {
      return {
        mode: "needs_input",
        modelFacing: {
          error: "selectedOptionId 不在本次匹配候选中（可能已被核销或不可见），请重新发起匹配",
          needsSelection: true,
          optionType: "invoice",
          candidates: candidates.map((c) => ({ invoiceId: c.id, outstanding: c.outstanding })),
          nextStep: "请从候选中选择一个 selectedOptionId 后重试",
        },
        needsSelection: true,
        optionType: "invoice",
        internalActionsCalled: ["finance.match_payment"],
      };
    }
    const outcome = await runAgentToolForActor(ctx, "finance.create_receipt", {
      organizationId,
      amount: amountYuan,
      receivedAt: typeof input.receivedAt === "string" ? input.receivedAt : new Date().toISOString(),
      selectedOptionId,
    });
    return {
      mode: "proposal",
      modelFacing: { proposal: outcome.proposal ?? outcome.result, mode: outcome.mode },
      internalActionsCalled: ["finance.match_payment", "finance.create_receipt"],
    };
  }

  // 无 selectedOptionId：按候选数分流。
  if (candidates.length === 0) {
    // 无候选（NO_EXACT_MATCH 且无可核销发票）
    return {
      mode: "needs_input",
      modelFacing: {
        status: matchResult.status ?? "NO_EXACT_MATCH",
        needsUserInput: true,
        nextStep: "未找到可核销的发票候选，请确认金额/机构或先登记发票",
      },
      needsUserInput: true,
      internalActionsCalled: ["finance.match_payment"],
    };
  }

  if (candidates.length === 1) {
    // 精确唯一匹配：自动以该候选调 create_receipt 产 PENDING proposal。
    // service 会重跑 match 校验候选归属与 outstanding 充足性。
    const outcome = await runAgentToolForActor(ctx, "finance.create_receipt", {
      organizationId,
      amount: amountYuan,
      receivedAt: typeof input.receivedAt === "string" ? input.receivedAt : new Date().toISOString(),
      selectedOptionId: candidates[0].id,
    });
    return {
      mode: "proposal",
      modelFacing: { proposal: outcome.proposal ?? outcome.result, mode: outcome.mode },
      internalActionsCalled: ["finance.match_payment", "finance.create_receipt"],
    };
  }

  // 多候选 → needs_selection + options，禁止手写 allocations。
  return {
    mode: "needs_input",
    modelFacing: {
      status: matchResult.status ?? "MATCHED",
      candidates: candidates.map((c) => ({
        invoiceId: c.id,
        outstanding: c.outstanding,
        buyerOrganizationName: c.buyerOrganizationName,
      })),
      needsSelection: true,
      optionType: "invoice",
      nextStep: "存在多个可核销发票候选，请用户选定后传入 selectedOptionId",
    },
    needsSelection: true,
    optionType: "invoice",
    internalActionsCalled: ["finance.match_payment"],
  };
}

// ── prepare_contract（preview_then_confirm_generate）──
//
// P0-4：prepare_draft（safe，产 generationIntentId + 解析默认 template/seller）后，
// facade 用解析后的 generationIntentId/templateId/sellerProfileId 调 contracts.generate（confirm）
// 产 PENDING proposal。模型/卡片拿到 preview + proposal 句柄；确认后 execute 重新校验并落
// ContractDocument（业务表）。preview 阶段只落 generationIntent（intent，非业务表）。

export async function prepareContractFacade(
  ctx: AgentExecutionContext,
  input: Record<string, unknown>,
): Promise<PublicFacadeResult> {
  const orderIdsRaw = Array.isArray(input.orderIds) ? input.orderIds : [];
  const orderIds: string[] = [];
  for (const id of orderIdsRaw) {
    if (typeof id === "string") {
      orderIds.push(id);
    }
  }
  if (orderIds.length === 0) {
    return { mode: "needs_input", modelFacing: { error: "orderIds is required (at least one)", needsUserInput: true }, needsUserInput: true };
  }

  // prepare_draft（safe，产 generationIntentId，服务端链内传递；同时解析 templateId/sellerProfileId 默认值）
  const prepareOutcome = await runAgentToolForActor(ctx, "contracts.prepare_draft", {
    orderIds,
    ...(typeof input.templateOptionId === "string" ? { templateId: input.templateOptionId } : {}),
    ...(typeof input.sellerOptionId === "string" ? { sellerProfileId: input.sellerOptionId } : {}),
  });
  const preview = (prepareOutcome.result ?? {}) as {
    draft?: {
      generationIntentId?: string;
      template?: { id?: string; name?: string };
      sellerProfile?: { id?: string; name?: string };
      buyerFields?: Record<string, unknown>;
      totalAmountCents?: number;
      totalAmountInWords?: string;
      lineCount?: number;
      coveredOrders?: Array<{ orderId: string; orderNo: string; title: string }>;
      warnings?: string[];
    };
  };
  const draft = preview.draft ?? {};
  const generationIntentId = typeof draft.generationIntentId === "string" ? draft.generationIntentId : "";
  const templateId = typeof draft.template?.id === "string" ? draft.template.id : "";
  const sellerProfileId = typeof draft.sellerProfile?.id === "string" ? draft.sellerProfile.id : "";

  if (!generationIntentId || !templateId || !sellerProfileId) {
    // 解析失败（模板/卖方未定且无默认）→ 需用户显式选择，不产 proposal。
    return {
      mode: "needs_input",
      modelFacing: {
        preview,
        needsUserInput: true,
        nextStep: "请显式提供 templateOptionId / sellerOptionId 后重试（无法解析默认模板或开票主体）",
      },
      needsUserInput: true,
      internalActionsCalled: ["contracts.prepare_draft"],
    };
  }

  // 用解析后的 generationIntentId + 默认值调 generate（confirm）→ PENDING proposal。
  // previewGenerateContractForActor 会重新校验订单权限/同买方/digest。
  const generateOutcome = await runAgentToolForActor(ctx, "contracts.generate", {
    generationIntentId,
    orderIds,
    templateId,
    sellerProfileId,
  });
  return {
    mode: "proposal",
    modelFacing: {
      preview,
      proposal: generateOutcome.proposal ?? generateOutcome.result,
      mode: generateOutcome.mode,
      nextStep: "已生成合同确认提案，等待用户确认后生成正式合同文件",
    },
    internalActionsCalled: ["contracts.prepare_draft", "contracts.generate"],
  };
}

// ── propose_invoice_registration ──
//
// P0-4：analyze_invoice_file（safe）后，当 match 唯一（status=EXACT 且单可选项）时，
// facade 用 verified staging 上下文（stagingFileId/sha256/version）+ 提取的发票号/开票日期 +
// 唯一候选 invoiceRequestId 调 register_issued_invoice（confirm）→ PENDING proposal。
// 多候选/无匹配/重复 → needsSelection/needsUserInput，不产 proposal。

export async function proposeInvoiceRegistrationFacade(
  ctx: AgentExecutionContext,
  input: Record<string, unknown>,
): Promise<PublicFacadeResult> {
  const attachmentId = readId(input, "attachmentId");

  // P0-4：verified-context 字段（sha256/version）禁止从 public input 传入（manifest
  // FORBIDDEN_PUBLIC_INPUT_FIELDS）。经 finance.get_invoice_staging_context internal action
  // （owner gate 在 getOwnedStagingFile 内）解析后注入 analyze，避免 facade 直连 canonical service。
  const ctxOutcome = await runAgentToolForActor(ctx, "finance.get_invoice_staging_context", {
    stagingFileId: attachmentId,
  });
  const ctxResult = (ctxOutcome.result ?? {}) as { sha256?: string; version?: number };
  const expectedSha256 = typeof ctxResult.sha256 === "string" ? ctxResult.sha256 : "";
  const expectedStagingVersion = typeof ctxResult.version === "number" ? ctxResult.version : 0;
  if (!expectedSha256 || expectedStagingVersion <= 0) {
    return {
      mode: "needs_input",
      modelFacing: {
        error: "无法解析附件 staging 上下文（hash/version），请确认附件仍有效且属于当前用户",
        needsUserInput: true,
      },
      needsUserInput: true,
      internalActionsCalled: ["finance.get_invoice_staging_context"],
    };
  }

  // analyze（safe）：OCR + 候选匹配；只写 staging/审计，不写业务发票表。
  const analyzeOutcome = await runAgentToolForActor(ctx, "finance.analyze_invoice_file", {
    stagingFileId: attachmentId,
    expectedSha256,
    expectedStagingVersion,
  });
  const analysis = (analyzeOutcome.result ?? {}) as {
    staging?: { id?: string; sha256?: string; version?: number; fileName?: string; status?: string };
    extracted?: {
      invoiceNumber?: string | null;
      issuedAt?: string | null;
      invoiceType?: string | null;
      totalAmountCents?: number | null;
    };
    match?: {
      status?: string;
      candidates?: Array<{
        invoiceRequestId: string;
        orderNo?: string | null;
        buyerOrganizationName?: string;
        totalAmountCents?: number;
        score?: number;
        canSelect?: boolean;
      }>;
    };
  };

  // analyze 成功后 staging version 递增；register 必须用 analyze 回写的最新 version/sha256。
  const staging = analysis.staging ?? {};
  const stagingFileId = typeof staging.id === "string" ? staging.id : attachmentId;
  const registerSha256 = typeof staging.sha256 === "string" ? staging.sha256 : expectedSha256;
  const registerVersion = typeof staging.version === "number" ? staging.version : expectedStagingVersion;
  const matchStatus = analysis.match?.status ?? "";
  const candidates = Array.isArray(analysis.match?.candidates) ? analysis.match!.candidates : [];
  const selectable = candidates.filter((c) => c.canSelect !== false);

  // 唯一匹配（EXACT + 单可选项 + 提取出 invoiceNumber + staging 上下文齐全）→ 自动产 register proposal。
  const uniqueMatch =
    matchStatus === "EXACT" &&
    selectable.length === 1 &&
    typeof analysis.extracted?.invoiceNumber === "string" &&
    analysis.extracted.invoiceNumber.trim().length > 0;

  // 多候选但用户已选定 selectedOptionId：以选定项构造 register 输入。
  const selectedId = typeof input.selectedOptionId === "string" ? input.selectedOptionId : "";
  const selectedFromAmbiguous =
    !uniqueMatch && selectedId ? selectable.find((c) => c.invoiceRequestId === selectedId) : null;

  if (!uniqueMatch && !selectedFromAmbiguous) {
    // 多候选 / 无匹配 / 重复 / OCR 字段缺失 → 让用户在 GenUI 卡片显式选择/补充。
    const isAmbiguous = matchStatus === "AMBIGUOUS" || selectable.length > 1;
    return {
      mode: "needs_input",
      modelFacing: {
        analysis,
        ...(isAmbiguous ? { needsSelection: true, optionType: "invoice_request" } : { needsUserInput: true }),
        nextStep: isAmbiguous
          ? "存在多个开票申请候选，请用户选定后传入 selectedOptionId"
          : matchStatus === "DUPLICATE"
            ? "该发票号或文件已登记过，默认跳过本张"
            : matchStatus === "NO_MATCH"
              ? "未找到可用开票申请，可手工指定申请或跳过"
              : "识别字段不全或无可选候选，请补充后再发起登记",
      },
      ...(isAmbiguous ? { needsSelection: true, optionType: "invoice_request" } : { needsUserInput: true }),
      internalActionsCalled: ["finance.get_invoice_staging_context", "finance.analyze_invoice_file"],
    };
  }

  const target = uniqueMatch ? selectable[0] : selectedFromAmbiguous!;
  if (
    !target ||
    typeof analysis.extracted?.invoiceNumber !== "string" ||
    !analysis.extracted.invoiceNumber.trim()
  ) {
    return {
      mode: "needs_input",
      modelFacing: {
        analysis,
        needsUserInput: true,
        nextStep: "OCR 未提取到发票号，请人工补充后再发起登记",
      },
      needsUserInput: true,
      internalActionsCalled: ["finance.get_invoice_staging_context", "finance.analyze_invoice_file"],
    };
  }

  const registerInput = {
    stagingFileId,
    invoiceRequestId: target.invoiceRequestId,
    actualInvoiceNo: analysis.extracted.invoiceNumber.trim(),
    actualIssuedAt: analysis.extracted.issuedAt ?? undefined,
    expectedSha256: registerSha256,
    expectedStagingVersion: registerVersion,
  };

  const registerOutcome = await runAgentToolForActor(ctx, "finance.register_issued_invoice", registerInput);
  return {
    mode: "proposal",
    modelFacing: {
      analysis,
      proposal: registerOutcome.proposal ?? registerOutcome.result,
      mode: registerOutcome.mode,
      nextStep: "已生成发票登记确认提案，等待用户确认后登记为已开票（ISSUED）",
    },
    internalActionsCalled: ["finance.get_invoice_staging_context", "finance.analyze_invoice_file", "finance.register_issued_invoice"],
  };
}

// ── link_order_project（contextual）──

export async function linkOrderProjectFacade(
  ctx: AgentExecutionContext,
  input: Record<string, unknown>,
): Promise<PublicFacadeResult> {
  const orderId = readId(input, "orderId");
  const projectId = readId(input, "projectId");
  const outcome = await runAgentToolForActor(ctx, "orders.link_to_project", { orderId, projectId });
  return {
    mode: "proposal",
    modelFacing: { proposal: outcome.proposal ?? outcome.result, mode: outcome.mode },
    internalActionsCalled: ["orders.link_to_project"],
  };
}

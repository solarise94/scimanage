import { isOrderAccessBlocked } from "@/lib/orders/permissions";
import { getOrderReceiptTotals } from "@/lib/finance/order-receivables";
import { computeOrderFinanceAmount } from "@/lib/finance/progress";
import {
  queryOrders,
  listPendingReceiptOrders,
} from "@/lib/orders/application/query-orders";
import {
  getOrderDetail,
  getOrderFinanceSnapshot,
} from "@/lib/orders/application/get-order-detail";
import { prepareCreateOrderForActor } from "@/lib/orders/application/prepare-create-order";
import { createOrderForActor, createOrderFromDraftForActor } from "@/lib/orders/application/create-order";
import {
  prepareLinkOrderProjectForActor,
  linkOrderToProjectForActor,
} from "@/lib/orders/application/link-order-project";
import {
  updateImportRowDraftForActor,
  prepareSkipImportRowForActor,
  resumeImportSessionForActor,
  resolveImportSessionStagingContextForActor,
} from "@/lib/orders/application/import-session";
import { writeAgentActionLog } from "@/lib/application/agent-action-logs";
import { yuanToCents, centsToYuan } from "@/lib/finance/money";
import { buildInvocationContext } from "@/lib/application/actor";
import {
  canUseAgentImport,
} from "@/lib/orders/import-permissions";
import {
  IMPORT_PARSER_KEY,
  IMPORT_STAGING_MAX_ROWS,
  StagingError,
  claimImportStagingForAnalysis,
  completeImportStagingAnalysis,
  failImportStagingAnalysis,
  getOwnedImportStaging,
  readImportStagingBuffer,
} from "@/lib/import-staging";
import {
  IMPORT_COLUMN_MAPPING_TARGETS,
  detectImportParser,
  extractHeaderAndSampleRows,
  maskSensitiveSampleRow,
} from "@/lib/orders/import-parser-fingerprint";
import {
  createImportSessionFromRows,
  decodeStagingBufferToText,
  parseImportText,
} from "@/lib/orders/import-staging-analyze";
import {
  analyzeImportRow,
  commitImportRow,
  ImportRowConflictError,
  ImportRowNotFoundError,
  ImportRowValidationError,
  prepareImportRow,
  RepresentativeMissingError,
  skipImportRow,
} from "@/lib/orders/import-single-row";
import { computeOrderAmount } from "@/lib/orders/import-commit";
import {
  ROW_STATUS,
} from "@/lib/orders/import-session";
import {
  IMPORT_ROW_PROPOSAL_LIFECYCLE_KEY,
  registerImportRowProposalLifecycle,
} from "@/lib/orders/application/import-row-proposal-lifecycle";
import { ensureOrderDraftProposalLifecycleRegistered } from "@/lib/orders/application/order-draft-proposal-lifecycle";
import { AgentActionConflictError, AgentActionError, AgentActionForbiddenError, AgentActionInputError, AgentActionNotFoundError, mapDomainErrorToAgentError } from "../errors";
import { formatCentsAsYuanLabel, parseLinkAllocatedAmountToCents } from "../format-tool-result-for-model";
import { registerAgentAction } from "../registry";
import { arraySchema, booleanSchema, clampLimit, ensureObject, integerSchema, numberSchema, objectSchema, readOptionalArray, readOptionalBoolean, readOptionalInteger, readOptionalNumber, readOptionalString, readRequiredString, stringSchema } from "../schemas";

function searchInputSchema() {
  return objectSchema({
    query: stringSchema("关键词，可匹配订单号、标题、客户快照"),
    status: stringSchema("订单状态"),
    source: stringSchema("订单来源"),
    profileId: stringSchema("客户档案 ID（CrmCustomerProfile.id）"),
    limit: integerSchema("返回条数，默认 10，最大 30", { minimum: 1, maximum: 30 }),
  });
}

function searchOutputSchema() {
  return objectSchema({
    items: {
      type: "array",
      items: objectSchema({
        id: stringSchema(),
        orderNo: stringSchema(),
        title: stringSchema(),
        status: stringSchema(),
        source: stringSchema(),
      }),
    },
  });
}

function financeSnapshotInputSchema() {
  return objectSchema({
    orderId: stringSchema("订单内部 ID（必须使用本次会话中 orders.search 返回的 id；记忆/历史上下文里的 id 可能已失效，禁止直接使用。兼容订单号 orderNo/外部编号）"),
  }, ["orderId"]);
}

function financeSnapshotOutputSchema() {
  return objectSchema({
    order: objectSchema({
      id: stringSchema(),
      orderNo: stringSchema(),
      title: stringSchema(),
      status: stringSchema(),
      totalAmount: integerSchema("订单总金额（分）"),
    }),
    finance: objectSchema({
      financeAmount: integerSchema("订单财务口径金额（分）"),
      invoicedAmount: integerSchema("已开票金额（分）"),
      receiptAmount: integerSchema("已回款金额（分）"),
      costAmount: integerSchema("已发生成本（分）"),
      outstandingAmount: integerSchema("未结清金额（分）"),
    }),
    invoiceStatus: stringSchema(),
    projectLinks: {
      type: "array",
      items: objectSchema({
        projectId: stringSchema(),
        projectName: stringSchema(),
        treatment: stringSchema(),
      }),
    },
  });
}

function linkToProjectInputSchema() {
  return objectSchema({
    orderId: stringSchema("订单内部 ID（必须使用本次会话中 orders.search 返回的 id；记忆/历史上下文里的 id 可能已失效，禁止直接使用。兼容订单号 orderNo/外部编号）"),
    projectId: stringSchema("项目 ID"),
    treatment: stringSchema("PROJECT_INCLUDED 或 STANDALONE"),
    allocatedAmountYuan: numberSchema("分摊金额（元）。用户说「500 元」时传 500；服务端转为分入库。"),
    isPrimary: booleanSchema("是否主关联"),
    note: stringSchema("备注"),
  }, ["orderId", "projectId"]);
}

function linkToProjectOutputSchema() {
  return objectSchema({
    link: objectSchema({
      id: stringSchema(),
      orderId: stringSchema(),
      projectId: stringSchema(),
      treatment: stringSchema(),
    }),
    notifications: objectSchema({
      representativeAssigned: stringSchema(),
    }),
  });
}

// ─── Phase C：单行导入闭环 helpers ───────────────────────────────────────────

/**
 * §6.3 / §9.3 脱敏：手机号、微信号、地址在 action 输出与日志中掩码，
 * 内部 ID（profileId / orderId / rowId）原样保留供模型回传。
 */
function maskSensitive(value: string | null | undefined): string | null {
  if (!value) return null;
  const s = String(value);
  if (s.length <= 2) return s;
  // 11 位手机号 → 前 3 后 2
  if (/^1\d{10}$/.test(s)) return `${s.slice(0, 3)}****${s.slice(-2)}`;
  if (s.length <= 6) return `${s.slice(0, 1)}***${s.slice(-1)}`;
  return `${s.slice(0, 2)}***${s.slice(-2)}`;
}

/** rawFields 中需要掩码的列名模式（手机号/微信/地址，§9.3）。 */
const RAW_SENSITIVE_KEY_PATTERN = /phone|手机|电话|wechat|微信|address|地址|住址|收货/i;

/**
 * 把 normalizedPayloadJson 反序列化后的日期字段安全转成 ISO 字符串。
 *
 * 背景：`OrderImportRow.normalizedPayloadJson` 由 `JSON.stringify(row)` 写入，
 * 读取时 `parseNormalizedPayload` 做 `JSON.parse(raw) as NormalizedOrderRow`——
 * 类型上是 `Date | null`，但运行时 `orderAt/paidAt` 实际是 ISO 字符串（或 null）。
 * 直接 `nf.orderAt?.toISOString()` 在 string 输入上会抛 `TypeError: ... is not a function`。
 *
 * 本 helper 做类型防御：
 *  - Date → toISOString()；Invalid Date → null
 *  - string / number（含毫秒时间戳）→ new Date(v).toISOString()；Invalid Date → null
 *  - 其他类型 / null / undefined → null
 */
export function isoOrNull(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) {
    return Number.isNaN(v.getTime()) ? null : v.toISOString();
  }
  if (typeof v === "string" || typeof v === "number") {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

/**
 * 对 rawFields（原始解析行，含完整手机号/地址）按列名掩码。
 * §9.3 承诺手机号/微信/地址不出现在 action 输出（会进入模型上下文并发往第三方 LLM），
 * normalizedFields 已掩码，rawFields 也不能例外。
 */
function maskRawFields(
  raw: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!raw) return null;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string" && RAW_SENSITIVE_KEY_PATTERN.test(key)) {
      out[key] = maskSensitive(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** 把 analyzeImportRow 的分析结果映射为脱敏的 action 输出（§6.3）。 */
function buildImportRowAnalysisOutput(analysis: Awaited<ReturnType<typeof analyzeImportRow>>) {
  const nf = analysis.normalizedFields;
  return {
    rowId: analysis.rowId,
    rowNo: analysis.rowNo + 1,
    reviewStatus: null,
    source: null,
    rawFields: maskRawFields(analysis.rawFields),
    normalizedFields: nf
      ? {
          externalOrderNo: nf.externalOrderNo,
          merchantOrderNo: nf.merchantOrderNo,
          receiverName: nf.receiverName,
          receiverPhoneMasked: maskSensitive(nf.receiverPhone),
          receiverAddressMasked: maskSensitive(nf.receiverAddress),
          orderUserMasked: maskSensitive(nf.orderUser),
          miniProgramId: nf.miniProgramId,
          storeName: nf.storeName,
          productNamesRaw: nf.productNamesRaw,
          platform: nf.platform,
          orderAt: isoOrNull(nf.orderAt),
          paidAt: isoOrNull(nf.paidAt),
          paidAmount: nf.paidAmount,
          grossAmount: nf.grossAmount,
        }
      : null,
    provenance: analysis.provenance,
    missingFields: analysis.missingFields,
    candidates: analysis.candidates,
    exactDuplicate: analysis.exactDuplicate,
    crossSourceConflict: analysis.crossSourceConflict,
    plan: analysis.plan,
    updateDiff: analysis.updateDiff,
    version: analysis.version,
    progress: analysis.progress,
  };
}

/**
 * Run a canonical order query/detail service and translate its named
 * ApplicationError (ForbiddenError / NotFoundError / ...) into the matching
 * AgentActionError. The service owns capability + scope; the adapter only maps
 * the failure type.
 */
async function mapQueryError<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    mapDomainErrorToAgentError(err, { resourceLabel: "订单" });
  }
}

export function registerOrderActions() {
  registerImportRowProposalLifecycle();
  // P0-2：order draft lifecycle（草稿锁定 + revert + consume 由 create_from_draft 触发）。
  ensureOrderDraftProposalLifecycleRegistered();
  registerAgentAction({
    key: "orders.search",
    title: "搜索订单",
    description: "按关键词和条件搜索当前用户可见的订单。",
    domain: "orders",
    riskLevel: "safe",
    readOnly: true,
    inputSchema: searchInputSchema(),
    outputSchema: searchOutputSchema(),
    parseInput(raw) {
      const input = ensureObject(raw);
      return {
        query: readOptionalString(input, "query"),
        status: readOptionalString(input, "status"),
        source: readOptionalString(input, "source"),
        profileId: readOptionalString(input, "profileId"),
        limit: clampLimit(readOptionalInteger(input, "limit", { min: 1, max: 30 }), 10, 30),
      };
    },
    async availability(actor) {
      return !isOrderAccessBlocked(actor.role);
    },
    async execute(ctx, input) {
      const actor = ctx.actor;
      // Canonical query service：capability / scope / AND-composition / 分页 / 排序
      // 都在 service 内，与页面 GET /api/orders 共用。
      const { orders } = await mapQueryError(() =>
        queryOrders(actor, {
          filters: {
            search: input.query,
            status: input.status,
            source: input.source,
            profileId: input.profileId,
          },
          page: 1,
          pageSize: input.limit,
        }),
      );

      return {
        items: orders.map((order) => ({
          id: order.id,
          orderNo: order.orderNo,
          externalOrderNo: order.externalOrderNo,
          title: order.title,
          status: order.status,
          source: order.source,
          totalAmount: order.totalAmount,
          financeAmount: computeOrderFinanceAmount({
            totalAmount: order.totalAmount,
            financeAmountOverride: order.financeAmountOverride,
          }),
          buyerNameSnapshot: order.buyerNameSnapshot,
          buyerOrgNameSnapshot: order.buyerOrgNameSnapshot,
          profileId: order.profileId ?? null,
          customerName: order.profile?.name ?? null,
          projectLinkCount: order.projectLinks.length,
          updatedAt: order.updatedAt.toISOString(),
        })),
      };
    },
  });

  registerAgentAction({
    key: "orders.list_pending_receipts",
    title: "列出待回款订单",
    description:
      "列出当前用户可见、回款未齐的订单（有效财务金额 > 已回款），按下单时间倒序。"
      + "用于「哪些订单待回款/欠款/没收齐」类问题；返回的 id 可直接传给 orders.get_finance_snapshot 或 orders.get_detail 查详情。"
      + "已回款口径与财务台账一致（FinanceReceiptAllocation + 无 allocation 的 legacy receipt）。"
      + "分页扫描候选订单直至凑齐 limit；若扫描达上限仍可能有更早待回款单，会返回 truncated=true。",
    domain: "orders",
    riskLevel: "safe",
    readOnly: true,
    presentation: { type: "card", narration: "minimal" },
    inputSchema: objectSchema({
      limit: integerSchema("返回条数，默认 10，最大 30", { minimum: 1, maximum: 30 }),
    }),
    outputSchema: objectSchema({
      items: {
        type: "array",
        items: objectSchema({
          id: stringSchema(),
          orderNo: stringSchema(),
          title: stringSchema(),
          status: stringSchema(),
          financeAmount: integerSchema("有效财务金额（分）"),
          receivedAmount: integerSchema("已回款金额（分）"),
          outstandingAmount: integerSchema("待回款金额（分）"),
        }),
      },
      scanned: integerSchema("本次扫描的候选订单数"),
      truncated: booleanSchema("是否因扫描上限提前停止；true 时更早待回款单可能未纳入"),
    }),
    parseInput(raw) {
      const input = ensureObject(raw);
      return {
        limit: clampLimit(readOptionalInteger(input, "limit", { min: 1, max: 30 }), 10, 30),
      };
    },
    async availability(actor) {
      return !isOrderAccessBlocked(actor.role);
    },
    async execute(ctx, input) {
      const actor = ctx.actor;
      // 待回款扫描口径（scope / CONFIRMED+DELIVERED / 财务金额>已回款 / 分页扫描上限）
      // 全部在 canonical service 内。
      return mapQueryError(() => listPendingReceiptOrders(actor, { limit: input.limit }));
    },
  });

  registerAgentAction({
    key: "orders.find_with_financial_view",
    title: "按财务视图查找订单",
    description:
      "统一找单工具的服务端口径：any=不按回款筛（走 search）；pending_receipt=待回款（有效财务金额>已回款）；"
      + "settled=已结清（满开票+无在途发票+回款齐，复用 isOrderSettled）。"
      + "由 public find_orders facade 调用；REPRESENTATIVE 不可用（走受限投影）。",
    domain: "orders",
    riskLevel: "safe",
    readOnly: true,
    presentation: { type: "card", narration: "minimal" },
    inputSchema: objectSchema({
      query: stringSchema("可选搜索词"),
      status: stringSchema("业务状态 enum（与回款正交）"),
      financialView: stringSchema("any | pending_receipt | settled；默认 any", { enum: ["any", "pending_receipt", "settled"] }),
      limit: integerSchema("返回条数，默认 10，最大 30", { minimum: 1, maximum: 30 }),
    }),
    outputSchema: objectSchema({
      financialView: stringSchema("实际使用的 financialView"),
      items: {
        type: "array",
        items: objectSchema({
          id: stringSchema(),
          orderNo: stringSchema(),
          title: stringSchema(),
          status: stringSchema(),
        }),
      },
      outstandingAmount: integerSchema("待回款金额（分）；仅 pending_receipt 返回"),
      truncated: booleanSchema("是否因扫描上限提前停止；仅 pending_receipt 返回"),
    }),
    parseInput(raw) {
      const input = ensureObject(raw);
      const fvRaw = readOptionalString(input, "financialView");
      const financialView: "any" | "pending_receipt" | "settled" =
        fvRaw === "pending_receipt" || fvRaw === "settled" ? fvRaw : "any";
      return {
        query: readOptionalString(input, "query"),
        status: readOptionalString(input, "status"),
        financialView,
        limit: clampLimit(readOptionalInteger(input, "limit", { min: 1, max: 30 }), 10, 30),
      };
    },
    async availability(actor) {
      // REPRESENTATIVE 不可用此 action（其 find_orders 走受限投影，不含 financialView）。
      return !isOrderAccessBlocked(actor.role) && actor.role !== "REPRESENTATIVE";
    },
    async execute(ctx, input) {
      const actor = ctx.actor;

      if (input.financialView === "pending_receipt") {
        const pending = await mapQueryError(() => listPendingReceiptOrders(actor, { limit: input.limit }));
        return {
          financialView: "pending_receipt" as const,
          items: pending.items.map((o) => ({
            id: o.id,
            orderNo: o.orderNo,
            title: o.title,
            status: o.status,
          })),
          outstandingAmount: pending.items[0]?.outstandingAmount ?? 0,
          truncated: pending.truncated,
        };
      }

      if (input.financialView === "settled") {
        // settled → view=paid，复用 canonical queryOrderReceivables（承接 Web 全量口径）。
        const { queryOrderReceivables } = await import("@/lib/orders/application/order-receivables-query");
        const result = await mapQueryError(() =>
          queryOrderReceivables(actor, {
            search: input.query,
            view: "paid",
            page: 1,
            pageSize: input.limit,
          }),
        );
        return {
          financialView: "settled" as const,
          items: result.orders.slice(0, input.limit).map((o) => ({
            id: o.id,
            orderNo: o.orderNo,
            title: o.title,
            status: o.status,
          })),
        };
      }

      // any → queryOrders（支持 status 业务状态 enum，与回款正交）。
      const { orders } = await mapQueryError(() =>
        queryOrders(actor, {
          filters: { search: input.query, status: input.status },
          page: 1,
          pageSize: input.limit,
        }),
      );
      return {
        financialView: "any" as const,
        items: orders.map((o) => ({
          id: o.id,
          orderNo: o.orderNo,
          title: o.title,
          status: o.status,
        })),
      };
    },
  });

  // ── Phase C：order draft internal actions（public facade 经此调度，不直连 canonical service）──

  registerAgentAction({
    key: "orders.prepare_draft",
    title: "创建订单草稿",
    description:
      "为指定客户创建 server-owned 订单草稿，返回 GenUI 选项（产品/项目类型）。"
      + "由 public prepare_order facade 调用；不接收 title/remark/JSON lines。",
    domain: "orders",
    riskLevel: "safe",
    readOnly: true,
    inputSchema: objectSchema({
      customerProfileId: stringSchema("客户档案 ID（CrmCustomerProfile.id）"),
    }, ["customerProfileId"]),
    outputSchema: objectSchema({
      orderDraftId: stringSchema(),
      version: integerSchema(),
      needsSelection: booleanSchema(),
    }),
    parseInput(raw) {
      const input = ensureObject(raw);
      return { customerProfileId: readRequiredString(input, "customerProfileId") };
    },
    async availability(actor) {
      return actor.role === "ADMIN" || actor.role === "USER";
    },
    async execute(ctx, input) {
      const { prepareOrderDraftForActor } = await import("@/lib/orders/application/order-drafts");
      return mapQueryError(() =>
        prepareOrderDraftForActor(ctx.actor, input, { agentRunId: ctx.invocation.agentRunId ?? null }),
      );
    },
  });

  registerAgentAction({
    key: "orders.get_draft",
    title: "读取订单草稿",
    description: "读取草稿（含行），供 propose_order buildProposal 只读校验。由 public facade 调用。",
    domain: "orders",
    riskLevel: "safe",
    readOnly: true,
    inputSchema: objectSchema({
      orderDraftId: stringSchema("订单草稿 ID"),
    }, ["orderDraftId"]),
    outputSchema: objectSchema({
      id: stringSchema(),
      version: integerSchema(),
      status: stringSchema(),
      titleSnapshot: stringSchema(),
    }),
    parseInput(raw) {
      const input = ensureObject(raw);
      return { orderDraftId: readRequiredString(input, "orderDraftId") };
    },
    async availability(actor) {
      return actor.role === "ADMIN" || actor.role === "USER";
    },
    async execute(ctx, input) {
      const { getOrderDraftForActor } = await import("@/lib/orders/application/order-drafts");
      return mapQueryError(() => getOrderDraftForActor(ctx.actor, input.orderDraftId));
    },
  });

  registerAgentAction({
    key: "orders.create_from_draft",
    title: "从草稿创建订单（确认）",
    description:
      "消费服务端草稿创建订单。仅接受 orderDraftId + expectedVersion；行字段从草稿读取，模型不可重传。"
      + "草稿在确认成功的事务内标记 CONSUMED（防重复落单）。confirm action。",
    domain: "orders",
    riskLevel: "confirm",
    readOnly: false,
    proposalLifecycleKey: "orders.create_from_draft",
    inputSchema: objectSchema({
      orderDraftId: stringSchema("订单草稿 ID"),
      expectedVersion: integerSchema("草稿版本（乐观锁）"),
    }, ["orderDraftId", "expectedVersion"]),
    outputSchema: objectSchema({
      order: objectSchema({
        id: stringSchema(),
        orderNo: stringSchema(),
      }),
    }),
    parseInput(raw) {
      const input = ensureObject(raw);
      return {
        orderDraftId: readRequiredString(input, "orderDraftId"),
        expectedVersion: readOptionalInteger(input, "expectedVersion") ?? 0,
      };
    },
    async availability(actor) {
      return actor.role === "ADMIN" || actor.role === "USER";
    },
    async buildProposal(ctx, input) {
      const { getOrderDraftForActor } = await import("@/lib/orders/application/order-drafts");
      const draft = await mapQueryError(() => getOrderDraftForActor(ctx.actor, input.orderDraftId));
      if (draft.status !== "DRAFT") {
        throw new AgentActionConflictError(`草稿状态 ${draft.status}，不可提案`);
      }
      if (!draft.titleSnapshot || draft.lines.length === 0) {
        throw new AgentActionInputError("草稿尚无有效行（需先在 GenUI 选产品）");
      }
      if (draft.version !== input.expectedVersion) {
        throw new AgentActionConflictError(
          `草稿版本不匹配（期望 ${input.expectedVersion}，当前 ${draft.version}）`,
        );
      }
      return {
        title: `创建订单：${draft.titleSnapshot}`,
        summary: `基于草稿 ${draft.id}（v${draft.version}）创建订单，共 ${draft.lines.length} 行。确认后落单并标记草稿已消费。`,
      };
    },
    async execute(ctx, input) {
      // 单一 canonical：同事务内重读 PROPOSED/version、写订单、标 CONSUMED（count===1）。
      // 禁止 createOrder + consume 两笔事务——中间失败会留下已创建订单 + 可重新提案的草稿。
      const result = await mapQueryError(() =>
        createOrderFromDraftForActor(
          ctx.actor,
          buildInvocationContext({ ...ctx.invocation }),
          {
            orderDraftId: input.orderDraftId,
            expectedVersion: input.expectedVersion,
          },
        ),
      );
      return { order: { id: result.order.id, orderNo: result.order.orderNo } };
    },
  });

  registerAgentAction({
    key: "orders.get_finance_snapshot",
    title: "查看订单财务摘要",
    description: "读取订单金额、开票、回款、成本和项目分摊摘要。调用前必须先用 orders.search 搜索订单，orderId 只能取搜索结果里的 id，禁止凭记忆编造 id。",
    domain: "orders",
    riskLevel: "safe",
    readOnly: true,
    presentation: { type: "card", narration: "minimal" },
    inputSchema: financeSnapshotInputSchema(),
    outputSchema: financeSnapshotOutputSchema(),
    parseInput(raw) {
      const input = ensureObject(raw);
      return {
        orderId: readRequiredString(input, "orderId"),
      };
    },
    async availability(actor) {
      return !isOrderAccessBlocked(actor.role);
    },
    async execute(ctx, input) {
      const actor = ctx.actor;
      // capability / scope / ref 解析 / 金额口径都在 canonical service 内。
      return mapQueryError(() => getOrderFinanceSnapshot(actor, input.orderId));
    },
  });

  registerAgentAction({
    key: "orders.link_to_project",
    title: "绑定订单到项目",
    description: "把订单与项目建立关联，并复用现有客户冲突与 CRM 同步逻辑。",
    domain: "orders",
    riskLevel: "confirm",
    readOnly: false,
    inputSchema: linkToProjectInputSchema(),
    outputSchema: linkToProjectOutputSchema(),
    parseInput(raw) {
      const input = ensureObject(raw);
      let allocatedAmount: number | undefined;
      try {
        allocatedAmount = parseLinkAllocatedAmountToCents(input, yuanToCents);
      } catch (err) {
        throw new AgentActionInputError(
          err instanceof Error ? err.message : "分摊金额无效（allocatedAmountYuan 用元；旧 proposal 的 allocatedAmount 按分解释）",
        );
      }
      return {
        orderId: readRequiredString(input, "orderId"),
        projectId: readRequiredString(input, "projectId"),
        treatment: readOptionalString(input, "treatment"),
        allocatedAmount,
        isPrimary: readOptionalBoolean(input, "isPrimary"),
        note: readOptionalString(input, "note"),
      };
    },
    async availability(actor) {
      return actor.role === "ADMIN";
    },
    async buildProposal(ctx, input) {
      const prepared = await mapQueryError(() =>
        prepareLinkOrderProjectForActor(ctx.actor, {
          orderId: input.orderId,
          projectId: input.projectId,
          treatment: input.treatment,
          allocatedAmount: input.allocatedAmount,
          moneyUnit: "cents",
          isPrimary: input.isPrimary,
          note: input.note,
        }),
      );

      const allocatedLabel = input.allocatedAmount != null
        ? `；分摊金额 ${formatCentsAsYuanLabel(input.allocatedAmount)}`
        : "";

      // 持久化元字段，确认时 parseInput 走 yuan→分，避免把已是分的 allocatedAmount 再 ×100。
      const proposalInput: Record<string, unknown> = {
        orderId: input.orderId,
        projectId: input.projectId,
        treatment: input.treatment,
        isPrimary: input.isPrimary,
        note: input.note,
        inputVersion: 2,
      };
      if (input.allocatedAmount != null) {
        proposalInput.allocatedAmountYuan = centsToYuan(input.allocatedAmount);
      }

      return {
        title: `绑定订单 ${prepared.order.orderNo} 到项目`,
        summary: `订单「${prepared.order.orderNo} ${prepared.order.title}」将绑定到项目「${prepared.project.name}」。处理方式为 ${input.treatment || "PROJECT_INCLUDED"}${allocatedLabel}。`,
        target: { type: "order", id: prepared.order.id },
        proposalInput,
      };
    },
    async execute(ctx, input) {
      const result = await mapQueryError(() =>
        linkOrderToProjectForActor(
          ctx.actor,
          buildInvocationContext({
            channel: "agent",
            agentRunId: ctx.invocation.agentRunId ?? null,
            proposalId: ctx.invocation.proposalId ?? null,
            chatSessionId: ctx.invocation.chatSessionId ?? null,
            idempotencyKey: ctx.invocation.proposalId
              ? `agent-proposal:${ctx.invocation.proposalId}`
              : null,
          }),
          {
            orderId: input.orderId,
            projectId: input.projectId,
            treatment: input.treatment,
            allocatedAmount: input.allocatedAmount,
            moneyUnit: "cents",
            isPrimary: input.isPrimary,
            note: input.note,
          },
        ),
      );

      return {
        link: {
          id: result.link.id,
          orderId: result.link.orderId,
          projectId: result.link.projectId,
          treatment: result.link.treatment,
          allocatedAmount: result.link.allocatedAmount,
          isPrimary: result.link.isPrimary,
        },
        notifications: {
          representativeAssigned: result.repAssignedToProject
            ? result.repAssignedToProject.representativeId
            : null,
        },
      };
    },
    resolveTarget(_input, output) {
      return { type: "order_project_link", id: output.link.id };
    },
  });

  // ─── orders.create ───────────────────────────────────────────────────────────
  registerAgentAction({
    key: "orders.create",
    title: "创建订单",
    description: "创建新订单。必须指定标题和客户档案（profileId），可选添加行项目明细。",
    domain: "orders",
    riskLevel: "confirm",
    readOnly: false,
    presentation: { type: "card", narration: "minimal" },
    inputSchema: objectSchema({
      title: stringSchema("订单标题"),
      profileId: stringSchema("客户档案 ID（CrmCustomerProfile.id）"),
      category: stringSchema("SERVICE 或 PRODUCT，默认 SERVICE"),
      lines: arraySchema(
        objectSchema({
          itemName: stringSchema("项目名称"),
          spec: stringSchema("规格"),
          unit: stringSchema("单位"),
          quantity: numberSchema("数量"),
          unitPrice: numberSchema("单价（元）"),
          amount: numberSchema("金额（元）"),
          productSkuId: stringSchema("产品 SKU ID（ProductSku.id，新业务必填）"),
        }, ["itemName", "amount"]),
        "订单行项目明细",
      ),
      totalAmount: numberSchema("总金额（元），有行项目时可省略"),
      projectAction: stringSchema("GENERATE（自动创建项目）或 LINK（关联现有项目）"),
      projectId: stringSchema("当 projectAction=LINK 时，要关联的项目 ID"),
    }, ["title", "profileId"]),
    outputSchema: objectSchema({
      order: objectSchema({
        id: stringSchema(),
        orderNo: stringSchema(),
        title: stringSchema(),
        status: stringSchema(),
        totalAmount: integerSchema("订单总金额（分）"),
      }),
      project: objectSchema({
        id: stringSchema(),
        name: stringSchema(),
      }),
    }),
    parseInput(raw) {
      const input = ensureObject(raw);
      const lines = readOptionalArray(input, "lines");
      return {
        title: readRequiredString(input, "title"),
        profileId: readRequiredString(input, "profileId"),
        category: readOptionalString(input, "category"),
        lines: lines?.map((item, index) => {
          const record = ensureObject(item, `lines[${index}]`);
          // amount arrives as a JSON number (numberSchema) from the runtime —
          // read the raw value instead of readRequiredString (which throws on
          // non-strings), mirroring finance.ts invoice item parsing.
          const amount = yuanToCents(Number(record.amount));
          if (!Number.isFinite(amount)) {
            throw new AgentActionInputError(`lines[${index}].amount must be a number`);
          }
          return {
            itemName: readRequiredString(record, "itemName"),
            spec: readOptionalString(record, "spec"),
            unit: readOptionalString(record, "unit"),
            quantity: readOptionalNumber(record, "quantity"),
            unitPrice: readOptionalNumber(record, "unitPrice"),
            amount,
            productSkuId: readOptionalString(record, "productSkuId"),
          };
        }),
        totalAmount: readOptionalNumber(input, "totalAmount"),
        projectAction: readOptionalString(input, "projectAction") as "GENERATE" | "LINK" | undefined,
        projectId: readOptionalString(input, "projectId"),
      };
    },
    async availability(actor) {
      return actor.role === "ADMIN";
    },
    async buildProposal(ctx, input) {
      const prepared = await mapQueryError(() =>
        prepareCreateOrderForActor(ctx.actor, {
          title: input.title,
          profileId: input.profileId,
          category: input.category,
          lines: input.lines?.map((l) => ({
            itemName: l.itemName,
            spec: l.spec,
            unit: l.unit,
            quantity: l.quantity,
            // parseInput keeps unitPrice in 元；amount 已是分
            unitPrice: l.unitPrice != null ? yuanToCents(l.unitPrice) : null,
            amount: l.amount,
            productSkuId: l.productSkuId ?? null,
          })),
          totalAmount: input.totalAmount != null ? yuanToCents(input.totalAmount) : null,
          moneyUnit: "cents",
          projectAction: input.projectAction ?? null,
          projectId: input.projectId,
          source: "MANUAL",
        }),
      );
      // parseInput 已将 lines[].amount 转为分；持久化回元，确认时才能安全再 parse。
      const proposalInput: Record<string, unknown> = {
        title: input.title,
        profileId: prepared.meta.profileId,
        category: prepared.meta.orderCategory,
        projectAction: input.projectAction,
        projectId: input.projectId,
      };
      if (input.lines?.length) {
        proposalInput.lines = input.lines.map((l) => ({
          itemName: l.itemName,
          spec: l.spec,
          unit: l.unit,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          amount: centsToYuan(l.amount),
          productSkuId: l.productSkuId,
        }));
      } else if (input.totalAmount != null) {
        proposalInput.totalAmount = input.totalAmount;
      }
      return {
        title: `创建订单：${input.title}`,
        summary: `将为客户「${prepared.meta.profileName}」创建订单「${input.title}」，金额 ${(prepared.meta.totalAmountCents / 100).toFixed(2)} 元${input.lines?.length ? `，含 ${input.lines.length} 项明细` : ""}。`,
        target: { type: "crm_profile", id: prepared.meta.profileId },
        displayProps: { customerName: prepared.meta.profileName },
        proposalInput,
      };
    },
    async execute(ctx, input) {
      // T2.2b：正式写走 createOrderForActor（内部再 prepare + txn/retry/CRM/notify）。
      const created = await mapQueryError(() =>
        createOrderForActor(
          ctx.actor,
          buildInvocationContext({
            channel: "agent",
            agentRunId: ctx.invocation.agentRunId ?? null,
            proposalId: ctx.invocation.proposalId ?? null,
            chatSessionId: ctx.invocation.chatSessionId ?? null,
            idempotencyKey: ctx.invocation.proposalId
              ? `agent-proposal:${ctx.invocation.proposalId}`
              : null,
          }),
          {
            title: input.title,
            profileId: input.profileId,
            category: input.category,
            lines: input.lines?.map((l) => ({
              itemName: l.itemName,
              spec: l.spec,
              unit: l.unit,
              quantity: l.quantity,
              unitPrice: l.unitPrice != null ? yuanToCents(l.unitPrice) : null,
              amount: l.amount,
              productSkuId: l.productSkuId ?? null,
            })),
            totalAmount: input.totalAmount != null ? yuanToCents(input.totalAmount) : null,
            moneyUnit: "cents",
            projectAction: input.projectAction ?? null,
            projectId: input.projectId,
            source: "MANUAL",
          },
        ),
      );

      return {
        order: {
          id: created.order.id,
          orderNo: created.order.orderNo,
          title: created.order.title,
          status: created.order.status,
          totalAmount: created.order.totalAmount,
          profileId: created.order.profileId ?? created.prepared.meta.profileId,
        },
        project: created.project
          ? { id: created.project.id, name: created.project.name }
          : null,
      };
    },
    resolveTarget(_input, output) {
      return { type: "order", id: output.order.id };
    },
  });

  // ─── orders.get_detail ───────────────────────────────────────────────────────
  registerAgentAction({
    key: "orders.get_detail",
    title: "查看订单详情",
    description: "获取订单完整详情，包含行项目、项目关联、发票覆盖和财务摘要。orderId 只能取本次会话 orders.search 返回的 id，禁止凭记忆编造 id。",
    domain: "orders",
    riskLevel: "safe",
    readOnly: true,
    presentation: { type: "card", narration: "minimal" },
    inputSchema: objectSchema({
      orderId: stringSchema("订单内部 ID（必须使用本次会话中 orders.search 返回的 id；记忆/历史上下文里的 id 可能已失效，禁止直接使用。兼容订单号 orderNo/外部编号）"),
    }, ["orderId"]),
    outputSchema: objectSchema({
      order: objectSchema({
        id: stringSchema(),
        orderNo: stringSchema(),
        title: stringSchema(),
        status: stringSchema(),
        source: stringSchema(),
        category: stringSchema(),
        totalAmount: integerSchema("订单总金额（分）"),
        orderedAt: stringSchema(),
        customerName: stringSchema(),
      }),
      lines: { type: "array", items: objectSchema({ itemName: stringSchema(), amount: integerSchema("行金额（分）") }) },
      projectLinks: { type: "array", items: objectSchema({ projectId: stringSchema(), projectName: stringSchema(), treatment: stringSchema() }) },
      finance: objectSchema({
        financeAmount: integerSchema("财务口径金额（分）"),
        invoicedAmount: integerSchema("已开票金额（分）"),
        receiptAmount: integerSchema("已回款金额（分）"),
        outstandingAmount: integerSchema("未结清金额（分）"),
      }),
    }),
    parseInput(raw) {
      const input = ensureObject(raw);
      return { orderId: readRequiredString(input, "orderId") };
    },
    async availability(actor) {
      return !isOrderAccessBlocked(actor.role);
    },
    async execute(ctx, input) {
      const actor = ctx.actor;
      // canonical detail service：capability / scope / ref 解析 / deleted 口径。
      const { order, invoices } = await mapQueryError(() => getOrderDetail(actor, input.orderId));

      const receiptTotals = await getOrderReceiptTotals([order.id]);
      const financeAmount = computeOrderFinanceAmount({
        totalAmount: order.totalAmount,
        financeAmountOverride: order.financeAmountOverride,
      });
      const invoicedAmount = invoices
        .filter((inv) => inv.status !== "CANCELLED")
        .reduce((sum, inv) => sum + inv.totalAmount, 0);
      const receiptAmount = receiptTotals.get(order.id) ?? 0;

      return {
        order: {
          id: order.id,
          orderNo: order.orderNo,
          title: order.title,
          status: order.status,
          source: order.source,
          category: order.category,
          totalAmount: order.totalAmount,
          orderedAt: order.orderedAt?.toISOString() ?? null,
          customerName: order.profile?.name ?? order.buyerNameSnapshot ?? null,
        },
        lines: order.lines.map((l) => ({
          itemName: l.itemName,
          spec: l.spec,
          unit: l.unit,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          amount: l.amount,
        })),
        projectLinks: order.projectLinks.map((link) => ({
          projectId: link.project.id,
          projectName: link.project.name,
          treatment: link.treatment,
          allocatedAmount: link.allocatedAmount,
        })),
        finance: {
          financeAmount,
          invoicedAmount,
          receiptAmount,
          outstandingAmount: Math.max(invoicedAmount - receiptAmount, 0),
        },
        invoices: invoices.map((inv) => ({
          id: inv.id,
          status: inv.status,
          totalAmount: inv.totalAmount,
          actualInvoiceNo: inv.actualInvoiceNo,
        })),
      };
    },
  });

  // ─── orders.analyze_import_file（§6.1）─────────────────────────────────────
  // safe：只写 staging/session，不写正式 Order。ADMIN only（§9.1）。
  registerAgentAction({
    key: "orders.analyze_import_file",
    title: "分析订单导入文件",
    description:
      "对私有 staging 中的订单文件做确定性表头指纹识别、解析、客户匹配，并创建导入确认会话。只写 staging/会话，不写正式订单。非标准表头时返回 needsColumnMapping（不建会话）；超过 500 行返回 422（不截断）。必须使用服务端 verified 上下文中的 stagingFileId/sha256/version，禁止编造。",
    domain: "orders",
    riskLevel: "safe",
    readOnly: false,
    presentation: { type: "card", narration: "minimal" },
    inputSchema: objectSchema({
      stagingFileId: stringSchema("私有 staging 文件 ID（verified hidden context）"),
      expectedSha256: stringSchema("staging 文件 SHA-256（verified hidden context）"),
      expectedVersion: integerSchema("staging version（verified hidden context）"),
      parserHint: stringSchema("AUTO | PINGOODMICE | ORDER_GENERIC，默认 AUTO"),
      sourceRemark: stringSchema("可选来源备注"),
    }, ["stagingFileId", "expectedSha256", "expectedVersion"]),
    outputSchema: objectSchema({
      sessionId: stringSchema(),
      parserKey: stringSchema(),
      rowCount: integerSchema(),
      summary: objectSchema({
        autoSuggested: integerSchema(),
        ambiguous: integerSchema(),
        noMatch: integerSchema(),
        parseFailed: integerSchema(),
      }),
      nextRowId: stringSchema(),
      needsColumnMapping: booleanSchema(),
      rawColumns: arraySchema(stringSchema()),
      sampleRows: arraySchema(arraySchema(stringSchema())),
      allowedTargets: arraySchema(stringSchema()),
    }),
    parseInput(raw) {
      const input = ensureObject(raw);
      const expectedVersion = readOptionalInteger(input, "expectedVersion", { min: 1 });
      if (expectedVersion == null) {
        throw new AgentActionInputError("expectedVersion is required");
      }
      const parserHintRaw = readOptionalString(input, "parserHint");
      const parserHint =
        parserHintRaw === "PINGOODMICE" || parserHintRaw === "ORDER_GENERIC"
          ? parserHintRaw
          : "AUTO";
      return {
        stagingFileId: readRequiredString(input, "stagingFileId"),
        expectedSha256: readRequiredString(input, "expectedSha256"),
        expectedVersion,
        parserHint,
        sourceRemark: readOptionalString(input, "sourceRemark"),
      };
    },
    async availability(actor) {
      return canUseAgentImport(actor);
    },
    async execute(ctx, input) {
      const { actor, invocation } = ctx;
      if (!canUseAgentImport(actor)) throw new AgentActionForbiddenError();

      const started = Date.now();
      const logBase = {
        userId: actor.userId,
        agentRunId: invocation.agentRunId ?? null,
        actionKey: "orders.analyze_import_file",
        riskLevel: "safe" as const,
        target: { type: "import_staging", id: input.stagingFileId },
      };

      try {
        // 1. 所有权 + 活跃校验
        const staging = await getOwnedImportStaging({
          stagingFileId: input.stagingFileId,
          userId: actor.userId,
          requireActive: true,
        });
        // 2. sha256 / version 一致性
        if (staging.sha256 !== input.expectedSha256) {
          throw new AgentActionConflictError("staging 文件哈希与期望不一致");
        }
        if (staging.version !== input.expectedVersion) {
          throw new AgentActionConflictError("staging 版本已变化");
        }

        // 3. claim UPLOADED → ANALYZING
        const claim = await claimImportStagingForAnalysis({
          stagingFileId: input.stagingFileId,
          userId: actor.userId,
          expectedSha256: input.expectedSha256,
          expectedVersion: input.expectedVersion,
        });
        if (!claim.claimed) {
          throw new AgentActionConflictError("staging 无法锁定（状态已变化或被占用）");
        }

        // 4. 读 buffer + 解码文本
        const buffer = await readImportStagingBuffer(staging);
        const decoded = decodeStagingBufferToText(buffer, staging.mimeType, staging.originalName);
        if ("error" in decoded) {
          await failImportStagingAnalysis({
            stagingFileId: input.stagingFileId,
            userId: actor.userId,
            expectedSha256: input.expectedSha256,
            recoverable: true,
          });
          throw new AgentActionInputError(decoded.error);
        }

        // 5. 确定性 parser 选择（AUTO 指纹；§6.1）
        const { rawColumns, sampleRows: rawSampleRows } = extractHeaderAndSampleRows(decoded.text, 3);
        let parserKey: "PINGOODMICE" | "ORDER_GENERIC";
        if (input.parserHint === "PINGOODMICE") {
          parserKey = IMPORT_PARSER_KEY.PINGOODMICE;
        } else if (input.parserHint === "ORDER_GENERIC") {
          parserKey = IMPORT_PARSER_KEY.ORDER_GENERIC;
        } else {
          const detection = detectImportParser(rawColumns);
          if ("needsColumnMapping" in detection) {
            // 非标准表头：恢复 UPLOADED，不建会话；返回脱敏样例 + 允许目标。
            await failImportStagingAnalysis({
              stagingFileId: input.stagingFileId,
              userId: actor.userId,
              expectedSha256: input.expectedSha256,
              recoverable: true,
            });
            const maskedSamples = rawSampleRows.map((r) => maskSensitiveSampleRow(r, rawColumns));
            // version 仍是 expectedVersion（claim 未成功写回 version++）
                        await writeAgentActionLog({
              ...logBase,
              status: "NEEDS_COLUMN_MAPPING",
              input: {
                  stagingFileId: input.stagingFileId,
                  expectedSha256Prefix: input.expectedSha256.slice(0, 12),
                  expectedVersion: input.expectedVersion,
                  parserHint: input.parserHint,
                  rawColumnCount: rawColumns.length,
                },
              output: { elapsedMs: Date.now() - started },
            }).catch(() => undefined);
            return {
              needsColumnMapping: true,
              stagingFileId: input.stagingFileId,
              expectedVersion: input.expectedVersion,
              rawColumns,
              sampleRows: maskedSamples,
              allowedTargets: [...IMPORT_COLUMN_MAPPING_TARGETS],
              // 兼容 outputSchema 的必填字段（card 会按 needsColumnMapping 分支渲染）
              sessionId: "",
              parserKey: "",
              rowCount: 0,
              summary: { autoSuggested: 0, ambiguous: 0, noMatch: 0, parseFailed: 0 },
              nextRowId: "",
            };
          }
          parserKey = detection.parserKey;
        }

        // 6. 解析 + 500 行上限
        const payload = parseImportText(
          parserKey === IMPORT_PARSER_KEY.PINGOODMICE ? "PINGOODMICE" : "OTHER_IMPORT",
          decoded.text,
        );
        if (payload.rows.length > IMPORT_STAGING_MAX_ROWS) {
          await failImportStagingAnalysis({
            stagingFileId: input.stagingFileId,
            userId: actor.userId,
            expectedSha256: input.expectedSha256,
            recoverable: true,
          });
          const err = new AgentActionInputError(
            `文件行数 ${payload.rows.length} 超过上限 ${IMPORT_STAGING_MAX_ROWS}，请拆分后重传`,
          );
          (err as AgentActionError & { details?: unknown }).details = {
            actualRows: payload.rows.length,
            maxRows: IMPORT_STAGING_MAX_ROWS,
            suggestedChunkSize: IMPORT_STAGING_MAX_ROWS,
          };
          throw err;
        }
        if (payload.rows.length === 0 && payload.parseErrors.length === 0) {
          await failImportStagingAnalysis({
            stagingFileId: input.stagingFileId,
            userId: actor.userId,
            expectedSha256: input.expectedSha256,
            recoverable: true,
          });
          throw new AgentActionInputError("未解析到任何数据行");
        }

        // 7. 事务创建 session + rows
        const result = await createImportSessionFromRows({
          createdById: actor.userId,
          agentRunId: invocation.agentRunId ?? null,
          stagingFileId: input.stagingFileId,
          parserKey,
          sourceRemark: input.sourceRemark ?? null,
          fileName: staging.originalName,
          payload,
        });

        // 8. ANALYZING → ANALYZED
        await completeImportStagingAnalysis({
          stagingFileId: input.stagingFileId,
          userId: actor.userId,
          expectedSha256: input.expectedSha256,
          sessionId: result.sessionId,
          parserKey,
        });

        // 9. 审计
                await writeAgentActionLog({
          ...logBase,
          status: "SUCCESS",
          input: {
              stagingFileId: input.stagingFileId,
              expectedSha256Prefix: input.expectedSha256.slice(0, 12),
              expectedVersion: input.expectedVersion,
              parserHint: input.parserHint,
              sourceRemark: input.sourceRemark ?? null,
            },
          output: {
              sessionId: result.sessionId,
              parserKey,
              rowCount: result.rowCount,
              summary: {
                autoSuggested: result.summary.autoSuggested,
                ambiguous: result.summary.ambiguous,
                noMatch: result.summary.noMatch,
                parseFailed: result.summary.parseFailed,
              },
              nextRowId: result.nextRowId,
              elapsedMs: Date.now() - started,
            },
        }).catch(() => undefined);

        return {
          sessionId: result.sessionId,
          parserKey,
          rowCount: result.rowCount,
          summary: {
            autoSuggested: result.summary.autoSuggested,
            ambiguous: result.summary.ambiguous,
            noMatch: result.summary.noMatch,
            parseFailed: result.summary.parseFailed,
          },
          nextRowId: result.nextRowId ?? "",
          // 非标准表头分支字段（兼容 outputSchema）
          needsColumnMapping: false,
          rawColumns: [],
          sampleRows: [],
          allowedTargets: [...IMPORT_COLUMN_MAPPING_TARGETS],
        };
      } catch (err) {
        // claim 之后任何失败都尝试恢复 staging（除非已恢复）
        if (err instanceof StagingError === false && !(err instanceof AgentActionConflictError)) {
          await failImportStagingAnalysis({
            stagingFileId: input.stagingFileId,
            userId: actor.userId,
            expectedSha256: input.expectedSha256,
            recoverable: true,
          }).catch(() => undefined);
        }
        const code =
          err && typeof err === "object" && "code" in err
            ? String((err as { code: string }).code)
            : "IMPORT_ANALYZE_ERROR";
        const message = err instanceof Error ? err.message : "分析失败";
        await writeAgentActionLog({
          ...logBase,
          status: "ERROR",
          input: {
            stagingFileId: input.stagingFileId,
            expectedSha256Prefix: input.expectedSha256.slice(0, 12),
            expectedVersion: input.expectedVersion,
            parserHint: input.parserHint,
          },
          output: { elapsedMs: Date.now() - started, errorCode: code },
          error: `${code}: ${message}`.slice(0, 400),
        }).catch(() => undefined);
        throw err;
      }
    },
  });

  // ─── orders.apply_import_column_mapping（§6.2）──────────────────────────────
  // safe：只为 staging 文件应用受限列映射并重新解析，不写正式订单。ADMIN only。
  registerAgentAction({
    key: "orders.apply_import_column_mapping",
    title: "应用订单导入列映射",
    description:
      "当 analyze_import_file 返回 needsColumnMapping 时，根据用户确认的列映射重新解析文件并创建导入确认会话。source 列必须来自 rawColumns；target 只能来自固定白名单；一个 source 只能映射一次。只写 staging/会话，不写正式订单。必须使用服务端 verified 上下文中的 stagingFileId/version。",
    domain: "orders",
    riskLevel: "safe",
    readOnly: false,
    presentation: { type: "card", narration: "minimal" },
    inputSchema: objectSchema({
      stagingFileId: stringSchema("私有 staging 文件 ID（verified hidden context）"),
      expectedVersion: integerSchema("staging version（verified hidden context）"),
      columnMapping: {
        type: "object",
        description: "source 列名 → target 字段名（来自 allowedTargets 白名单）",
        additionalProperties: { type: "string" },
      },
    }, ["stagingFileId", "expectedVersion", "columnMapping"]),
    outputSchema: objectSchema({
      sessionId: stringSchema(),
      rowCount: integerSchema(),
      summary: objectSchema({
        autoSuggested: integerSchema(),
        ambiguous: integerSchema(),
        noMatch: integerSchema(),
        parseFailed: integerSchema(),
      }),
      nextRowId: stringSchema(),
      missingTargets: arraySchema(stringSchema()),
    }),
    parseInput(raw) {
      const input = ensureObject(raw);
      const expectedVersion = readOptionalInteger(input, "expectedVersion", { min: 1 });
      if (expectedVersion == null) {
        throw new AgentActionInputError("expectedVersion is required");
      }
      const columnMappingRaw = input.columnMapping;
      if (!columnMappingRaw || typeof columnMappingRaw !== "object" || Array.isArray(columnMappingRaw)) {
        throw new AgentActionInputError("columnMapping must be an object");
      }
      const columnMapping: Record<string, string> = {};
      for (const [k, v] of Object.entries(columnMappingRaw as Record<string, unknown>)) {
        if (typeof k !== "string" || typeof v !== "string" || !k || !v) {
          throw new AgentActionInputError("columnMapping entries must be string→string");
        }
        columnMapping[k] = v;
      }
      return {
        stagingFileId: readRequiredString(input, "stagingFileId"),
        expectedVersion,
        columnMapping,
      };
    },
    async availability(actor) {
      return canUseAgentImport(actor);
    },
    async execute(ctx, input) {
      const { actor, invocation } = ctx;
      if (!canUseAgentImport(actor)) throw new AgentActionForbiddenError();

      const started = Date.now();
      const logBase = {
        userId: actor.userId,
        agentRunId: invocation.agentRunId ?? null,
        actionKey: "orders.apply_import_column_mapping",
        riskLevel: "safe" as const,
        target: { type: "import_staging", id: input.stagingFileId },
      };
      let stagingSha256 = "";

      try {
        // 1. 所有权 + 活跃
        const staging = await getOwnedImportStaging({
          stagingFileId: input.stagingFileId,
          userId: actor.userId,
          requireActive: true,
        });
        stagingSha256 = staging.sha256;
        // 2. version 一致性
        if (staging.version !== input.expectedVersion) {
          throw new AgentActionConflictError("staging 版本已变化");
        }

        // 3. 读 buffer + 解码
        const buffer = await readImportStagingBuffer(staging);
        const decoded = decodeStagingBufferToText(buffer, staging.mimeType, staging.originalName);
        if ("error" in decoded) {
          throw new AgentActionInputError(decoded.error);
        }

        // 4. 校验 mapping（source ∈ rawColumns；target ∈ 白名单；source 唯一；单值 target 不被多列覆盖）
        const { rawColumns } = extractHeaderAndSampleRows(decoded.text, 0);
        const rawColumnSet = new Set(rawColumns);
        const allowedTargets = new Set<string>(IMPORT_COLUMN_MAPPING_TARGETS);
        const seenSources = new Set<string>();
        const targetToSources = new Map<string, string[]>();

        for (const [source, target] of Object.entries(input.columnMapping)) {
          if (!rawColumnSet.has(source)) {
            throw new AgentActionInputError(`source 列「${source}」不在文件表头中`);
          }
          if (seenSources.has(source)) {
            throw new AgentActionInputError(`source 列「${source}」被映射了多次`);
          }
          seenSources.add(source);
          if (!allowedTargets.has(target)) {
            throw new AgentActionInputError(`target「${target}」不在允许的字段白名单中`);
          }
          const existing = targetToSources.get(target);
          if (existing) {
            throw new AgentActionInputError(`target「${target}」被多个 source 列覆盖（${existing[0]}, ${source}）`);
          }
          targetToSources.set(target, [source]);
        }

        // 5. claim UPLOADED → ANALYZING
        const claim = await claimImportStagingForAnalysis({
          stagingFileId: input.stagingFileId,
          userId: actor.userId,
          expectedSha256: staging.sha256,
          expectedVersion: input.expectedVersion,
        });
        if (!claim.claimed) {
          throw new AgentActionConflictError("staging 无法锁定（状态已变化或被占用）");
        }

        // 6. 应用列映射重新解析 + 必填检查
        const payload = parseImportText("OTHER_IMPORT", decoded.text, input.columnMapping);

        if (payload.rows.length === 0) {
          // 仍无法解析：返回缺失 target（不建空白行），恢复 UPLOADED
          await failImportStagingAnalysis({
            stagingFileId: input.stagingFileId,
            userId: actor.userId,
            expectedSha256: staging.sha256,
            recoverable: true,
          });
          const required = ["externalOrderNo"];
          const missingTargets = required.filter((f) => !targetToSources.has(f));
                    await writeAgentActionLog({
            ...logBase,
            status: "MAPPING_INCOMPLETE",
            input: {
                stagingFileId: input.stagingFileId,
                expectedVersion: input.expectedVersion,
              },
            output: { missingTargets, elapsedMs: Date.now() - started },
          }).catch(() => undefined);
          return {
            sessionId: "",
            rowCount: 0,
            summary: { autoSuggested: 0, ambiguous: 0, noMatch: 0, parseFailed: 0 },
            nextRowId: "",
            missingTargets,
          };
        }

        if (payload.rows.length > IMPORT_STAGING_MAX_ROWS) {
          await failImportStagingAnalysis({
            stagingFileId: input.stagingFileId,
            userId: actor.userId,
            expectedSha256: staging.sha256,
            recoverable: true,
          });
          const err = new AgentActionInputError(
            `文件行数 ${payload.rows.length} 超过上限 ${IMPORT_STAGING_MAX_ROWS}，请拆分后重传`,
          );
          (err as AgentActionError & { details?: unknown }).details = {
            actualRows: payload.rows.length,
            maxRows: IMPORT_STAGING_MAX_ROWS,
            suggestedChunkSize: IMPORT_STAGING_MAX_ROWS,
          };
          throw err;
        }

        // 7. 事务创建 session + rows
        const result = await createImportSessionFromRows({
          createdById: actor.userId,
          agentRunId: invocation.agentRunId ?? null,
          stagingFileId: input.stagingFileId,
          parserKey: IMPORT_PARSER_KEY.ORDER_GENERIC,
          fileName: staging.originalName,
          payload,
        });

        // 8. ANALYZING → ANALYZED
        await completeImportStagingAnalysis({
          stagingFileId: input.stagingFileId,
          userId: actor.userId,
          expectedSha256: staging.sha256,
          sessionId: result.sessionId,
          parserKey: IMPORT_PARSER_KEY.ORDER_GENERIC,
        });

                await writeAgentActionLog({
          ...logBase,
          status: "SUCCESS",
          input: {
              stagingFileId: input.stagingFileId,
              expectedVersion: input.expectedVersion,
              mappedTargets: [...targetToSources.keys()],
            },
          output: {
              sessionId: result.sessionId,
              rowCount: result.rowCount,
              summary: {
                autoSuggested: result.summary.autoSuggested,
                ambiguous: result.summary.ambiguous,
                noMatch: result.summary.noMatch,
                parseFailed: result.summary.parseFailed,
              },
              nextRowId: result.nextRowId,
              elapsedMs: Date.now() - started,
            },
        }).catch(() => undefined);

        return {
          sessionId: result.sessionId,
          rowCount: result.rowCount,
          summary: {
            autoSuggested: result.summary.autoSuggested,
            ambiguous: result.summary.ambiguous,
            noMatch: result.summary.noMatch,
            parseFailed: result.summary.parseFailed,
          },
          nextRowId: result.nextRowId ?? "",
          missingTargets: [],
        };
      } catch (err) {
        if (err instanceof StagingError === false && !(err instanceof AgentActionConflictError)) {
          await failImportStagingAnalysis({
            stagingFileId: input.stagingFileId,
            userId: actor.userId,
            expectedSha256: stagingSha256,
            recoverable: true,
          }).catch(() => undefined);
        }
        const code =
          err && typeof err === "object" && "code" in err
            ? String((err as { code: string }).code)
            : "IMPORT_MAPPING_ERROR";
        const message = err instanceof Error ? err.message : "列映射应用失败";
        await writeAgentActionLog({
          ...logBase,
          status: "ERROR",
          input: {
            stagingFileId: input.stagingFileId,
            expectedVersion: input.expectedVersion,
          },
          output: { elapsedMs: Date.now() - started, errorCode: code },
          error: `${code}: ${message}`.slice(0, 400),
        }).catch(() => undefined);
        throw err;
      }
    },
  });

  // ─── orders.get_import_row（§6.3，safe / 只读）──────────────────────────────
  // 只做权限/ownership、参数解析、结果裁剪、脱敏和 AgentActionLog；
  // 分析规则全部复用 analyzeImportRow，不在 action 内复制。
  registerAgentAction({
    key: "orders.get_import_row",
    title: "查看订单导入行",
    description:
      "读取一条导入确认会话行：原始+标准化字段、字段来源、缺失字段、客户候选（内部 profileId + 命中原因）、精确来源重复、跨来源冲突、CREATE/UPDATE/CONFLICT 计划、更新 diff、当前 version 与进度。不写任何数据，不重复分析规则。不传 rowId 时返回下一条未完成行。手机/微信/地址会脱敏。",
    domain: "orders",
    riskLevel: "safe",
    readOnly: true,
    presentation: { type: "card", narration: "minimal" },
    inputSchema: objectSchema({
      sessionId: stringSchema("导入确认会话 ID"),
      rowId: stringSchema("指定行 ID；省略时返回下一条未完成行"),
    }, ["sessionId"]),
    outputSchema: objectSchema({
      rowId: stringSchema(),
      rowNo: integerSchema("第几行（从 1 开始）"),
      normalizedFields: objectSchema({}),
      provenance: objectSchema({}),
      missingFields: arraySchema(stringSchema()),
      candidates: arraySchema(objectSchema({ profileId: stringSchema(), reason: stringSchema() })),
      exactDuplicate: objectSchema({ orderId: stringSchema(), deleted: booleanSchema() }),
      crossSourceConflict: arraySchema(objectSchema({ orderId: stringSchema(), source: stringSchema(), sourceRecordId: stringSchema() })),
      plan: stringSchema("CREATE | UPDATE | CONFLICT"),
      updateDiff: arraySchema(objectSchema({ field: stringSchema() })),
      version: integerSchema("当前行 version，用于后续乐观更新"),
      progress: objectSchema({
        total: integerSchema(),
        imported: integerSchema(),
        confirmed: integerSchema(),
        unresolved: integerSchema(),
      }),
    }),
    parseInput(raw) {
      const input = ensureObject(raw);
      return {
        sessionId: readRequiredString(input, "sessionId"),
        rowId: readOptionalString(input, "rowId"),
      };
    },
    async availability(actor) {
      return canUseAgentImport(actor);
    },
    async execute(ctx, input) {
      const { actor, invocation } = ctx;
      if (!canUseAgentImport(actor)) throw new AgentActionForbiddenError();

      let analysis: Awaited<ReturnType<typeof analyzeImportRow>>;
      try {
        analysis = await analyzeImportRow({
          sessionId: input.sessionId,
          rowId: input.rowId,
          userId: actor.userId,
        });
      } catch (err) {
        if (err instanceof ImportRowNotFoundError) {
          throw new AgentActionNotFoundError(input.rowId || input.sessionId, err.message);
        }
        throw err;
      }

      const output = buildImportRowAnalysisOutput(analysis);

      await writeAgentActionLog({
        userId: actor.userId,
        agentRunId: invocation.agentRunId ?? null,
        actionKey: "orders.get_import_row",
        riskLevel: "safe",
        status: "SUCCESS",
        input: {
          sessionId: input.sessionId,
          rowId: input.rowId ?? null,
          resolvedRowId: analysis.rowId,
        },
        output: {
          rowNo: analysis.rowNo + 1,
          plan: analysis.plan,
          missingFields: analysis.missingFields,
          version: analysis.version,
          progress: analysis.progress,
        },
        target: { type: "import_row", id: analysis.rowId },
      }).catch(() => undefined);

      return output;
    },
  });

  // ─── orders.update_import_row_draft（§6.4，safe）────────────────────────────
  // 保存用户补充内容或已验证上下文字段到 staging row 的 normalizedPayloadJson /
  // fieldProvenanceJson。服务端字段白名单；禁止改 session source、finalOrderId、
  // reviewStatus 与内部审计字段。乐观 version++，count 0 → 409 ROW_VERSION_CONFLICT。
  registerAgentAction({
    key: "orders.update_import_row_draft",
    title: "更新订单导入行草稿",
    description:
      "把用户补充的字段或已验证上下文字段写入某条导入行的标准化草稿（normalizedPayloadJson）与字段来源（fieldProvenanceJson）。字段白名单由服务端定义；禁止改 session source、finalOrderId、reviewStatus 和审计字段。provenance 只允许 FILE|USER_MESSAGE|VERIFIED_CONTEXT|CRM_SEARCH|DERIVED，禁止 MODEL_GUESS。乐观 version++，冲突返回 409。",
    domain: "orders",
    riskLevel: "safe",
    readOnly: false,
    presentation: { type: "card", narration: "minimal" },
    inputSchema: objectSchema({
      sessionId: stringSchema("导入确认会话 ID"),
      rowId: stringSchema("要更新的行 ID"),
      expectedVersion: integerSchema("当前行 version（来自 get_import_row）"),
      patch: {
        type: "object",
        description: "字段名 → 字符串值。允许的字段见服务端白名单；非法字段会被拒绝并回执 rejected。",
        additionalProperties: { type: "string" },
      },
      provenance: {
        type: "object",
        description: "字段名 → 来源标记（FILE|USER_MESSAGE|VERIFIED_CONTEXT|CRM_SEARCH|DERIVED）。",
        additionalProperties: { type: "string" },
      },
    }, ["sessionId", "rowId", "expectedVersion", "patch"]),
    outputSchema: objectSchema({
      rowId: stringSchema(),
      version: integerSchema("更新后的新 version"),
      appliedFields: arraySchema(stringSchema()),
      rejectedFields: arraySchema(stringSchema()),
      acceptedProvenance: arraySchema(stringSchema()),
      rejectedProvenance: arraySchema(stringSchema()),
      normalizedFields: objectSchema({}),
    }),
    parseInput(raw) {
      const input = ensureObject(raw);
      const expectedVersion = readOptionalInteger(input, "expectedVersion", { min: 1 });
      if (expectedVersion == null) {
        throw new AgentActionInputError("expectedVersion is required");
      }
      const patchRaw = input.patch;
      if (!patchRaw || typeof patchRaw !== "object" || Array.isArray(patchRaw)) {
        throw new AgentActionInputError("patch must be an object");
      }
      const patch: Record<string, string> = {};
      for (const [k, v] of Object.entries(patchRaw as Record<string, unknown>)) {
        if (typeof v !== "string") {
          throw new AgentActionInputError(`patch.${k} must be a string`);
        }
        patch[k] = v;
      }
      let provenance: Record<string, string> | undefined;
      const provRaw = input.provenance;
      if (provRaw != null) {
        if (typeof provRaw !== "object" || Array.isArray(provRaw)) {
          throw new AgentActionInputError("provenance must be an object");
        }
        provenance = {};
        for (const [k, v] of Object.entries(provRaw as Record<string, unknown>)) {
          if (typeof v !== "string") {
            throw new AgentActionInputError(`provenance.${k} must be a string`);
          }
          provenance[k] = v;
        }
      }
      return {
        sessionId: readRequiredString(input, "sessionId"),
        rowId: readRequiredString(input, "rowId"),
        expectedVersion,
        patch,
        provenance,
      };
    },
    async availability(actor) {
      return canUseAgentImport(actor);
    },
    async execute(ctx, input) {
      const { actor, invocation } = ctx;
      if (!canUseAgentImport(actor)) throw new AgentActionForbiddenError();

      const updated = await mapQueryError(() =>
        updateImportRowDraftForActor(ctx.actor, {
          sessionId: input.sessionId,
          rowId: input.rowId,
          expectedVersion: input.expectedVersion,
          patch: input.patch,
          provenance: input.provenance,
        }),
      );

      await writeAgentActionLog({
        userId: actor.userId,
        agentRunId: invocation.agentRunId ?? null,
        actionKey: "orders.update_import_row_draft",
        riskLevel: "safe",
        status: "SUCCESS",
        input: {
          sessionId: input.sessionId,
          rowId: input.rowId,
          expectedVersion: input.expectedVersion,
          appliedFields: updated.appliedFields,
          rejectedFields: updated.rejectedFields,
          acceptedProvenance: updated.acceptedProvenance,
          rejectedProvenance: updated.rejectedProvenance,
        },
        output: { newVersion: updated.version },
        target: { type: "import_row", id: input.rowId },
      }).catch(() => undefined);

      const merged = updated.normalized;
      return {
        rowId: updated.rowId,
        version: updated.version,
        appliedFields: updated.appliedFields,
        rejectedFields: updated.rejectedFields,
        acceptedProvenance: updated.acceptedProvenance,
        rejectedProvenance: updated.rejectedProvenance,
        normalizedFields: {
          externalOrderNo: merged.externalOrderNo,
          receiverName: merged.receiverName,
          receiverPhoneMasked: maskSensitive(merged.receiverPhone),
          productNamesRaw: merged.productNamesRaw,
          platform: merged.platform,
          paidAmount: merged.paidAmount,
          grossAmount: merged.grossAmount,
        },
      };
    },
  });

  // ─── orders.import_order_row（§6.5，confirm，核心）──────────────────────────
  // 串行化（serialByUser）：同一用户同时最多一个 PENDING import proposal。
  // buildProposal 内 prepareImportRow 持久化客户决策（PRE_DECISION→CONFIRMED_*，version++），
  // 并把推进后的 version 冻结进 proposalInput；persistProposalState 在 createAgentProposal
  // 的事务里按冻结 version 原子把 CONFIRMED_* → PROPOSED（不 bump version，见钩子注释）；
  // execute 调 commitImportRow 按同一冻结 version 认领；revertProposalState
  // 在 reject/FAILED 路径恢复 CONFIRMED_*。
  registerAgentAction({
    key: "orders.import_order_row",
    title: "导入订单行",
    description:
      "对一条已决策的导入行生成确认 proposal：先 prepareImportRow 持久化客户决策（CONFIRMED_*），再在 proposal 创建事务内原子把行从 CONFIRMED_* 推进到 PROPOSED 并写入 proposalId。用户确认后 execute 调用 commitImportRow 单行事务创建/更新订单。一次只处理一行；跨来源冲突不得调用本 action。confirmed 后按 §5.5.1 返回幂等成功或结构化 409。",
    domain: "orders",
    riskLevel: "confirm",
    readOnly: false,
    serialByUser: true,
    presentation: { type: "card", narration: "minimal" },
    inputSchema: objectSchema({
      sessionId: stringSchema("导入确认会话 ID"),
      rowId: stringSchema("要导入的行 ID"),
      expectedRowVersion: integerSchema("生成 proposal 时行的 version（来自 get_import_row）"),
      decision: objectSchema({
        type: stringSchema("USE_SUGGESTION | PICK_EXISTING | CREATE_NEW"),
        profileId: stringSchema("USE_SUGGESTION / PICK_EXISTING 时必填：服务端候选 profileId"),
        createCustomerDraft: objectSchema({
          name: stringSchema(),
          organizationId: stringSchema(),
          organizationName: stringSchema(),
          phone: stringSchema(),
          wechat: stringSchema(),
          miniProgramId: stringSchema(),
          address: stringSchema(),
        }, ["name"]),
      }, ["type"]),
    }, ["sessionId", "rowId", "expectedRowVersion", "decision"]),
    outputSchema: objectSchema({
      result: stringSchema("COMMITTED | IDEMPOTENT_SUCCESS"),
      finalOrderId: stringSchema(),
      created: booleanSchema("true 表示新建订单，false 表示更新既有订单"),
    }),
    parseInput(raw) {
      const input = ensureObject(raw);
      const expectedRowVersion = readOptionalInteger(input, "expectedRowVersion", { min: 1 });
      if (expectedRowVersion == null) {
        throw new AgentActionInputError("expectedRowVersion is required");
      }
      const decisionRaw = input.decision;
      if (!decisionRaw || typeof decisionRaw !== "object" || Array.isArray(decisionRaw)) {
        throw new AgentActionInputError("decision is required and must be an object");
      }
      const d = decisionRaw as Record<string, unknown>;
      const dtype = d.type;
      if (dtype !== "USE_SUGGESTION" && dtype !== "PICK_EXISTING" && dtype !== "CREATE_NEW") {
        throw new AgentActionInputError("decision.type must be USE_SUGGESTION | PICK_EXISTING | CREATE_NEW");
      }
      const profileIdRaw = typeof d.profileId === "string" ? d.profileId : undefined;
      let createCustomerDraft: Record<string, string | null> | null = null;
      if (dtype === "CREATE_NEW") {
        const draftRaw = d.createCustomerDraft;
        if (draftRaw && typeof draftRaw === "object" && !Array.isArray(draftRaw)) {
          const draftObj = draftRaw as Record<string, unknown>;
          createCustomerDraft = {
            name: typeof draftObj.name === "string" ? draftObj.name : "",
            organizationId: typeof draftObj.organizationId === "string" ? draftObj.organizationId : "",
            organizationName: typeof draftObj.organizationName === "string" ? draftObj.organizationName : "",
            phone: typeof draftObj.phone === "string" ? draftObj.phone : "",
            wechat: typeof draftObj.wechat === "string" ? draftObj.wechat : "",
            miniProgramId: typeof draftObj.miniProgramId === "string" ? draftObj.miniProgramId : "",
            address: typeof draftObj.address === "string" ? draftObj.address : "",
          };
        } else {
          createCustomerDraft = { name: "" };
        }
      }
      return {
        sessionId: readRequiredString(input, "sessionId"),
        rowId: readRequiredString(input, "rowId"),
        expectedRowVersion,
        decision: {
          type: dtype as "USE_SUGGESTION" | "PICK_EXISTING" | "CREATE_NEW",
          profileId: profileIdRaw ?? null,
          createCustomerDraft,
        },
      };
    },
    async availability(actor) {
      return canUseAgentImport(actor);
    },
    async buildProposal(ctx, input) {
      const actor = ctx.actor;
      if (!canUseAgentImport(actor)) throw new AgentActionForbiddenError();

      // ownership + decision-ready 校验 + 持久化客户决策（CONFIRMED_*）。
      // prepareImportRow 使用全局 prisma；若 version 冲突会抛 ImportRowConflictError。
      let prepared: Awaited<ReturnType<typeof prepareImportRow>>;
      try {
        prepared = await prepareImportRow({
          sessionId: input.sessionId,
          rowId: input.rowId,
          userId: actor.userId,
          decision: input.decision,
          expectedVersion: input.expectedRowVersion,
        });
      } catch (err) {
        if (err instanceof ImportRowNotFoundError) {
          throw new AgentActionNotFoundError(input.rowId, err.message);
        }
        if (err instanceof ImportRowValidationError) {
          throw new AgentActionInputError(err.message);
        }
        if (err instanceof ImportRowConflictError) {
          const e = new AgentActionConflictError(err.message);
          (e as AgentActionConflictError & { details?: unknown }).details = {
            code: err.code,
            rowId: input.rowId,
            currentVersion: err.currentVersion,
            currentStatus: err.currentStatus,
            currentProposalId: err.currentProposalId,
            retryable: err.retryable,
          };
          throw e;
        }
        throw err;
      }

      // 重新跑只读分析，构建确认摘要（plan / diff / 候选 / 进度）。
      const analysis = await analyzeImportRow({
        sessionId: input.sessionId,
        rowId: input.rowId,
        userId: actor.userId,
      });
      const nf = analysis.normalizedFields;
      const amountYuan = nf ? computeOrderAmount(nf) : 0;
      const remaining = Math.max(analysis.progress.unresolved - 0, 0);

      const planLabel =
        analysis.plan === "CREATE" ? "新建订单"
        : analysis.plan === "UPDATE" ? "更新订单"
        : "跨来源冲突";
      const diffLines = (analysis.updateDiff ?? []).map(
        (d) => `${d.field}: ${JSON.stringify(d.oldValue)} → ${JSON.stringify(d.newValue)}`,
      );

      const summary = [
        `第 ${analysis.rowNo + 1} 行 · 外部单号 ${nf?.externalOrderNo ?? "(缺)"}`,
        `计划：${planLabel}`,
        `客户决策：${input.decision.type}${
          input.decision.profileId ? `（profileId=${input.decision.profileId.slice(-8)}）` : ""
        }`,
        nf?.productNamesRaw ? `标题：${nf.productNamesRaw}` : null,
        `金额：¥${amountYuan.toFixed(2)}`,
        nf?.orderAt ? `下单：${nf.orderAt.toISOString().slice(0, 10)}` : null,
        nf?.paidAt ? `付款：${nf.paidAt.toISOString().slice(0, 10)}` : null,
        analysis.exactDuplicate ? `精确来源命中订单 …${analysis.exactDuplicate.orderId.slice(-6)}` : null,
        diffLines.length > 0 ? `更新差异：${diffLines.join("；")}` : null,
        analysis.crossSourceConflict.length > 0
          ? `跨来源冲突：${analysis.crossSourceConflict.length} 条（不应调用本 action）`
          : null,
        `本行完成后剩余待处理约 ${remaining} 行`,
      ].filter(Boolean).join("\n");

      return {
        title: `${planLabel}：${nf?.externalOrderNo ?? "导入行"}`,
        summary,
        target: { type: "import_row", id: input.rowId },
        // 冻结输入（§6.5）；execute 从持久化 input 读取。
        // 附带展示字段供卡片渲染（不影响 parseInput）。
        proposalInput: {
          sessionId: input.sessionId,
          rowId: input.rowId,
          // buildProposal 里 prepareImportRow 已 version++（V0→V0+1）；
          // persistProposalState 的 CONFIRMED_*→PROPOSED 推进不再 bump version
          //（状态机本身是并发令牌），故 execute 以 prepared.version 认领。
          expectedRowVersion: prepared.version,
          decision: input.decision,
          // 展示字段
          rowNo: analysis.rowNo + 1,
          externalOrderNo: nf?.externalOrderNo ?? null,
          source: null,
          plan: analysis.plan,
          title: nf?.productNamesRaw ?? null,
          amountYuan,
          orderAt: nf?.orderAt?.toISOString() ?? null,
          paidAt: nf?.paidAt?.toISOString() ?? null,
          updateDiff: analysis.updateDiff,
          exactDuplicate: analysis.exactDuplicate,
          crossSourceConflict: analysis.crossSourceConflict,
          candidates: analysis.candidates,
          progress: analysis.progress,
          confirmedStatus: prepared.reviewStatus,
        },
      };
    },
    // 领域生命周期（§4.3.2 / T1.1）：persist/revert 收敛到
    // `@/lib/orders/application/import-row-proposal-lifecycle`，proposal service
    // 通过 registry 在自身事务内调用，transaction client 不再进入本 action 文件。
    proposalLifecycleKey: IMPORT_ROW_PROPOSAL_LIFECYCLE_KEY,
    async execute(ctx, input) {
      const { actor, invocation } = ctx;
      if (!canUseAgentImport(actor)) throw new AgentActionForbiddenError();

      let result: Awaited<ReturnType<typeof commitImportRow>>;
      try {
        result = await commitImportRow({
          sessionId: input.sessionId,
          rowId: input.rowId,
          userId: actor.userId,
          expectedRowVersion: input.expectedRowVersion,
          proposalId: invocation.proposalId ?? "",
          claimRunId: invocation.agentRunId,
          actorRole: actor.role,
          actorName: actor.name,
          actorEmail: actor.email,
        });
      } catch (err) {
        if (err instanceof ImportRowNotFoundError) {
          throw new AgentActionNotFoundError(input.rowId, err.message);
        }
        if (err instanceof ImportRowValidationError) {
          throw new AgentActionInputError(err.message);
        }
        if (err instanceof RepresentativeMissingError) {
          const e = new AgentActionConflictError(
            `客户 ${err.profileId ?? "(未知)"} 缺少有效代表，无法导入；请先在 CRM 补全代表后再确认`,
          );
          e.status = 422;
          (e as AgentActionConflictError & { details?: unknown }).details = {
            code: "REPRESENTATIVE_MISSING",
            profileId: err.profileId,
            retryable: false,
          };
          throw e;
        }
        if (err instanceof ImportRowConflictError) {
          // §5.5.1 结构化 409
          const e = new AgentActionConflictError(err.message);
          (e as AgentActionConflictError & { details?: unknown }).details = {
            code: err.code,
            rowId: input.rowId,
            currentVersion: err.currentVersion,
            currentStatus: err.currentStatus,
            currentProposalId: err.currentProposalId,
            retryable: err.retryable,
            claimStartedAt: err.claimStartedAt?.toISOString() ?? null,
          };
          throw e;
        }
        throw err;
      }

      if (result.kind === "CONFLICT") {
        // commitImportRow 返回 CONFLICT 结果对象（非异常路径）
        const e = new AgentActionConflictError(`行导入冲突：${result.code}`);
        (e as AgentActionConflictError & { details?: unknown }).details = {
          code: result.code,
          rowId: input.rowId,
          currentVersion: result.currentVersion,
          currentStatus: result.currentStatus,
          currentProposalId: result.currentProposalId,
          retryable: result.retryable,
          claimStartedAt: result.claimStartedAt?.toISOString() ?? null,
        };
        throw e;
      }

      return {
        result: result.kind,
        finalOrderId: result.finalOrderId,
        created: result.kind === "COMMITTED" ? result.created : false,
      };
    },
    resolveTarget(_input, output) {
      return { type: "order", id: output.finalOrderId };
    },
  });

  // ─── orders.skip_import_row（§6.6，confirm）─────────────────────────────────
  registerAgentAction({
    key: "orders.skip_import_row",
    title: "跳过订单导入行",
    description:
      "把一条非终态导入行永久标记为 DROPPED 并记录原因。confirm proposal；确认后调用 skipImportRow。拒绝 proposal 不会跳过订单（行状态不变）。一次只处理一行。",
    domain: "orders",
    riskLevel: "confirm",
    readOnly: false,
    serialByUser: true,
    presentation: { type: "card", narration: "minimal" },
    inputSchema: objectSchema({
      sessionId: stringSchema("导入确认会话 ID"),
      rowId: stringSchema("要跳过的行 ID"),
      expectedVersion: integerSchema("当前行 version"),
      reason: stringSchema("跳过原因（必填，会记录到行审计）"),
    }, ["sessionId", "rowId", "expectedVersion", "reason"]),
    outputSchema: objectSchema({
      rowId: stringSchema(),
      reviewStatus: stringSchema("DROPPED"),
    }),
    parseInput(raw) {
      const input = ensureObject(raw);
      const expectedVersion = readOptionalInteger(input, "expectedVersion", { min: 1 });
      if (expectedVersion == null) {
        throw new AgentActionInputError("expectedVersion is required");
      }
      return {
        sessionId: readRequiredString(input, "sessionId"),
        rowId: readRequiredString(input, "rowId"),
        expectedVersion,
        reason: readRequiredString(input, "reason"),
      };
    },
    async availability(actor) {
      return canUseAgentImport(actor);
    },
    async buildProposal(ctx, input) {
      const prepared = await mapQueryError(() =>
        prepareSkipImportRowForActor(ctx.actor, {
          sessionId: input.sessionId,
          rowId: input.rowId,
          expectedVersion: input.expectedVersion,
        }),
      );

      return {
        title: `跳过第 ${prepared.row.rowNo + 1} 行：${prepared.externalOrderNo}`,
        summary: `将永久跳过此行（${prepared.externalOrderNo}），原因：${input.reason}。跳过后行状态变为 DROPPED，不会创建或更新订单。`,
        target: { type: "import_row", id: input.rowId },
        proposalInput: {
          sessionId: input.sessionId,
          rowId: input.rowId,
          expectedVersion: input.expectedVersion,
          reason: input.reason,
          rowNo: prepared.row.rowNo + 1,
          externalOrderNo: prepared.externalOrderNo,
          source: prepared.session.source,
        },
      };
    },
    async execute(ctx, input) {
      const actor = ctx.actor;
      if (!canUseAgentImport(actor)) throw new AgentActionForbiddenError();
      try {
        await skipImportRow({
          sessionId: input.sessionId,
          rowId: input.rowId,
          userId: actor.userId,
          expectedVersion: input.expectedVersion,
          reason: input.reason,
        });
      } catch (err) {
        if (err instanceof ImportRowNotFoundError) {
          throw new AgentActionNotFoundError(input.rowId, err.message);
        }
        if (err instanceof ImportRowValidationError) {
          throw new AgentActionInputError(err.message);
        }
        if (err instanceof ImportRowConflictError) {
          const e = new AgentActionConflictError(err.message);
          (e as AgentActionConflictError & { details?: unknown }).details = {
            code: err.code,
            rowId: input.rowId,
            currentVersion: err.currentVersion,
            currentStatus: err.currentStatus,
            currentProposalId: err.currentProposalId,
            retryable: err.retryable,
          };
          throw e;
        }
        throw err;
      }
      return { rowId: input.rowId, reviewStatus: ROW_STATUS.DROPPED };
    },
    resolveTarget(_input, output) {
      return { type: "import_row", id: output.rowId };
    },
  });

  // ─── orders.resume_import_session（§6.7，safe / 只读）───────────────────────
  registerAgentAction({
    key: "orders.resume_import_session",
    title: "恢复订单导入会话",
    description:
      "读取导入确认会话的当前状态与进度：会话状态、当前 PENDING proposal（import_order_row / skip_import_row）、当前 IMPORTING 行、下一条未解决行、各类计数。若已存在 PENDING proposal，输出会明确提示「不要创建新 proposal」。不写任何数据。",
    domain: "orders",
    riskLevel: "safe",
    readOnly: true,
    presentation: { type: "card", narration: "minimal" },
    inputSchema: objectSchema({
      sessionId: stringSchema("导入确认会话 ID"),
    }, ["sessionId"]),
    outputSchema: objectSchema({
      sessionId: stringSchema(),
      sessionStatus: stringSchema(),
      hasPendingProposal: booleanSchema("为 true 时不得创建新 proposal"),
      pendingProposal: objectSchema({ id: stringSchema(), title: stringSchema(), actionKey: stringSchema() }),
      importingRowId: stringSchema("当前 IMPORTING 行 ID 或 null"),
      nextRowId: stringSchema("下一条未解决行 ID 或 null"),
      counts: objectSchema({
        total: integerSchema(),
        imported: integerSchema(),
        failed: integerSchema(),
        dropped: integerSchema(),
        confirmed: integerSchema(),
        unresolved: integerSchema(),
      }),
    }),
    parseInput(raw) {
      const input = ensureObject(raw);
      return { sessionId: readRequiredString(input, "sessionId") };
    },
    async availability(actor) {
      return canUseAgentImport(actor);
    },
    async execute(ctx, input) {
      const actor = ctx.actor;
      if (!canUseAgentImport(actor)) throw new AgentActionForbiddenError();

      return mapQueryError(() =>
        resumeImportSessionForActor(ctx.actor, input.sessionId),
      );
    },
  });

  // ─── orders.get_import_staging_context（safe / 只读）─────────────────────────
  // P0-2 断链修复辅助：public facade（start_order_import / operate_order_import
  // apply_column_mapping）需要 stagingFileId/sha256/version（verified-context 字段），
  // 但 public input 禁带（manifest FORBIDDEN_PUBLIC_INPUT_FIELDS）。本 action 按 owner
  // gate 解析这些字段供 facade 注入，避免 facade 直连 canonical service（AGENTS.md 铁律）。
  // 输入二选一：stagingFileId（start_order_import 路径）或 sessionId（apply_column_mapping
  // 重映射路径，经 session.stagingFileId 反查）。owner gate 在 getOwnedImportStaging /
  // resolveImportSessionStagingContextForActor 内（不存在/越权合并 404）。
  registerAgentAction({
    key: "orders.get_import_staging_context",
    title: "解析订单导入 staging 上下文",
    description:
      "按 owner gate 解析导入 staging 文件上下文（stagingFileId + sha256 + version），供导入 workflow facade（start_order_import / operate_order_import.apply_column_mapping）注入 verified-context 字段。输入 stagingFileId 或 sessionId 二选一。不写任何数据。",
    domain: "orders",
    riskLevel: "safe",
    readOnly: true,
    presentation: { type: "none", narration: "minimal" },
    inputSchema: objectSchema({
      stagingFileId: stringSchema("staging 文件 ID（与 sessionId 二选一）"),
      sessionId: stringSchema("导入会话 ID（与 stagingFileId 二选一，经 session.stagingFileId 反查）"),
    }, []),
    outputSchema: objectSchema({
      stagingFileId: stringSchema(),
      sha256: stringSchema(),
      version: integerSchema(),
    }),
    parseInput(raw) {
      const input = ensureObject(raw);
      const stagingFileId = readOptionalString(input, "stagingFileId");
      const sessionId = readOptionalString(input, "sessionId");
      if (!stagingFileId && !sessionId) {
        throw new AgentActionInputError("stagingFileId 与 sessionId 至少提供一个");
      }
      return { stagingFileId, sessionId };
    },
    async availability(actor) {
      return canUseAgentImport(actor);
    },
    async execute(ctx, input) {
      const actor = ctx.actor;
      if (!canUseAgentImport(actor)) throw new AgentActionForbiddenError();

      // sessionId 路径：经 session.stagingFileId 反查（canonical service 内含 owner gate）
      if (input.sessionId) {
        return mapQueryError(() =>
          resolveImportSessionStagingContextForActor(actor, input.sessionId!),
        );
      }

      // stagingFileId 路径：直接读 staging（owner gate 在 getOwnedImportStaging 内）
      const staging = await getOwnedImportStaging({
        stagingFileId: input.stagingFileId!,
        userId: actor.userId,
        requireActive: true,
      });
      return {
        stagingFileId: staging.id,
        sha256: staging.sha256,
        version: staging.version,
      };
    },
  });
}

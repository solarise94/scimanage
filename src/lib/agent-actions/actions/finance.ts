import { ApplicationError } from "@/lib/application/errors";
import {
  planProjectInvoiceRequestsForActor,
} from "@/lib/finance/application/plan-project-invoice-requests";
import {
  previewPrepareInvoiceDraftForActor,
  prepareInvoiceDraftForActor,
} from "@/lib/finance/application/prepare-invoice-draft";
import {
  previewSubmitInvoiceRequestForActor,
  submitInvoiceRequestForActor,
} from "@/lib/finance/application/submit-invoice-request";
import {
  previewCreateReceiptForActor,
  createReceiptForActor,
  resolveAllocationsFromMatch,
  AllocationReceiptError,
} from "@/lib/finance/application/create-receipt";
import { canReadFinance, canWriteFinance } from "@/lib/finance/permissions";
import { ReceiptMissingProfileError } from "@/lib/finance/receipt-profile";
import { yuanToCents } from "@/lib/finance/money";
import { InvoiceStagingError, getOwnedStagingFile } from "@/lib/finance/invoice-staging";
import {
  analyzeInvoiceFileForActor,
  GlmOcrClientError,
  InvoiceOcrError,
} from "@/lib/finance/application/analyze-invoice-file";
import { isGlmOcrConfigured } from "@/lib/finance/glm-ocr-client";
import { adoptAgentAttachmentAsInvoiceForActor } from "@/lib/finance/application/adopt-agent-attachment-as-invoice";
import { StagingError } from "@/lib/staging-common";
import { parsePlanInvoiceMoneyToCents } from "../format-tool-result-for-model";
import {
  previewRegisterIssuedInvoiceForActor,
  registerIssuedInvoiceForActor,
  AGENT_REGISTER_ISSUED_INVOICE_POLICY,
} from "@/lib/finance/application/register-issued-invoice";
import {
  mapRegisterIssuedInvoiceError,
  RegisterIssuedInvoiceError,
} from "@/lib/finance/register-issued-invoice";
import {
  queryPaymentMatchForActor,
  shapePaymentMatchForAgent,
} from "@/lib/finance/application/query-payment-match";
import {
  getInvoiceDetailForActor,
  shapeInvoiceDetailForAgent,
} from "@/lib/finance/application/query-invoice-detail";
import {
  AgentActionConflictError,
  AgentActionForbiddenError,
  AgentActionInputError,
  AgentActionNotFoundError,
  mapDomainErrorToAgentError,
} from "../errors";
import { registerAgentAction } from "../registry";
import {
  arraySchema,
  booleanSchema,
  ensureObject,
  integerSchema,
  numberSchema,
  objectSchema,
  readOptionalArray,
  readOptionalBoolean,
  readOptionalInteger,
  readOptionalNumber,
  readOptionalString,
  readRequiredString,
  stringSchema,
} from "../schemas";
import { registerFinanceBankFlowActions } from "./finance-bank-flow";

/** 登记发票错误的特殊映射：先尝试 mapRegisterIssuedInvoiceError（API 级错误），再走统一映射 */
function mapRegisterIssuedInvoiceAgentError(err: unknown): never {
  const mapped = mapRegisterIssuedInvoiceError(err);
  if (mapped) {
    // 将 API 级映射结果包装为带 status 的 Error，交给统一映射转为 AgentActionError
    const wrapped = new Error(mapped.body.error) as Error & { status: number };
    wrapped.status = mapped.status;
    mapDomainErrorToAgentError(wrapped, { resourceLabel: "发票" });
  }
  mapDomainErrorToAgentError(err, {
    domainClasses: [RegisterIssuedInvoiceError, InvoiceStagingError],
    resourceLabel: "发票",
  });
}

interface InvoiceItemInput {
  itemName: string;
  spec?: string;
  unit?: string;
  quantity?: number | null;
  amount: number;
}

interface CoverageAllocationInput {
  orderId: string;
  amountCents: number;
}

function invoiceItemSchema() {
  return objectSchema({
    itemName: stringSchema("项目名称"),
    spec: stringSchema("规格"),
    unit: stringSchema("单位"),
    quantity: numberSchema("数量"),
    amount: numberSchema("金额（元）"),
  }, ["itemName", "amount"]);
}

function coverageAllocationSchema() {
  return objectSchema({
    orderId: stringSchema("被覆盖的订单 ID"),
    amountCents: integerSchema("该订单在本张发票中的分摊金额（整数分，必须 > 0）"),
  }, ["orderId", "amountCents"]);
}

function prepareInvoiceDraftInputSchema() {
  return objectSchema({
    orderId: stringSchema("主订单 ID"),
    coverageAllocations: arraySchema(
      coverageAllocationSchema(),
      "完整分摊表：每个被覆盖订单（含主订单）对应的分摊金额（分）。合计必须等于发票金额。多订单合票时必填；单主订单可省略，系统按发票全额归属主订单。",
    ),
    allowCrossOrgInvoice: booleanSchema("是否允许跨开票机构合并成一张发票（代付合单）。默认 false，跨机构直接拒绝。"),
    contactName: stringSchema("联系人"),
    sellerProfileId: stringSchema("开票方档案 ID"),
    sellerName: stringSchema("开票方名称"),
    buyerOrganizationId: stringSchema("买方机构 ID"),
    buyerOrganizationName: stringSchema("买方公司名称"),
    buyerTaxId: stringSchema("买方税号"),
    invoiceType: stringSchema("NORMAL 或 SPECIAL"),
    contentSummary: stringSchema("开票内容摘要"),
    remark: stringSchema("备注"),
    taxIdFromLookup: { type: "boolean", description: "税号是否来自机构库" },
    items: arraySchema(invoiceItemSchema(), "开票行项目"),
  }, ["orderId", "buyerOrganizationName"]);
}

function prepareInvoiceDraftOutputSchema() {
  return objectSchema({
    invoice: objectSchema({
      id: stringSchema(),
      orderId: stringSchema(),
      buyerOrganizationName: stringSchema(),
      totalAmount: numberSchema(),
      status: stringSchema(),
    }),
    coveredOrderCount: numberSchema(),
  });
}

function parseInvoiceItems(raw: unknown): InvoiceItemInput[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    throw new AgentActionInputError("items must be an array");
  }

  return raw.map((item, index) => {
    const record = ensureObject(item, `items[${index}]`);
    const itemName = readRequiredString(record, "itemName");
    const spec = readOptionalString(record, "spec");
    const unit = readOptionalString(record, "unit");
    const quantityValue = record.quantity;
    const amountValue = record.amount;
    const quantity = quantityValue == null || quantityValue === ""
      ? null
      : Number(quantityValue);
    const amount = yuanToCents(Number(amountValue));
    if (quantity != null && !Number.isFinite(quantity)) {
      throw new AgentActionInputError(`items[${index}].quantity must be a number`);
    }
    if (!Number.isFinite(amount)) {
      throw new AgentActionInputError(`items[${index}].amount must be a number`);
    }

    return {
      itemName,
      spec,
      unit,
      quantity,
      amount,
    };
  });
}

function parseCoverageAllocations(raw: unknown): CoverageAllocationInput[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    throw new AgentActionInputError("coverageAllocations must be an array");
  }
  return raw.map((entry, index) => {
    const record = ensureObject(entry, `coverageAllocations[${index}]`);
    const orderId = readRequiredString(record, "orderId");
    const amountValue = record.amountCents;
    const amountCents = typeof amountValue === "number" ? amountValue : Number(amountValue);
    if (!Number.isFinite(amountCents) || !Number.isInteger(amountCents) || amountCents <= 0) {
      throw new AgentActionInputError(`coverageAllocations[${index}].amountCents must be a positive integer (cents)`);
    }
    return { orderId, amountCents };
  });
}

export function registerFinanceActions() {
  registerAgentAction({
    key: "finance.prepare_invoice_draft",
    title: "准备订单开票草稿",
    description: "为订单创建待确认的开票申请草稿。",
    domain: "finance",
    riskLevel: "confirm",
    readOnly: false,
    inputSchema: prepareInvoiceDraftInputSchema(),
    outputSchema: prepareInvoiceDraftOutputSchema(),
    parseInput(raw) {
      const input = ensureObject(raw);
      return {
        orderId: readRequiredString(input, "orderId"),
        coverageAllocations: parseCoverageAllocations(readOptionalArray(input, "coverageAllocations")),
        allowCrossOrgInvoice: readOptionalBoolean(input, "allowCrossOrgInvoice") ?? false,
        contactName: readOptionalString(input, "contactName"),
        sellerProfileId: readOptionalString(input, "sellerProfileId"),
        sellerName: readOptionalString(input, "sellerName"),
        buyerOrganizationId: readOptionalString(input, "buyerOrganizationId"),
        buyerOrganizationName: readRequiredString(input, "buyerOrganizationName"),
        buyerTaxId: readOptionalString(input, "buyerTaxId"),
        invoiceType: readOptionalString(input, "invoiceType"),
        contentSummary: readOptionalString(input, "contentSummary"),
        remark: readOptionalString(input, "remark"),
        taxIdFromLookup: input.taxIdFromLookup === true,
        items: parseInvoiceItems(input.items),
      };
    },
    async availability(actor) {
      return actor.role === "ADMIN";
    },
    async buildProposal(ctx, input) {
      const actor = ctx.actor;
      if (actor.role !== "ADMIN") {
        throw new AgentActionForbiddenError();
      }

      try {
        const preview = await previewPrepareInvoiceDraftForActor(actor, {
          mainOrderId: input.orderId,
          coverageAllocations: input.coverageAllocations,
          allowCrossOrgInvoice: input.allowCrossOrgInvoice,
          contactName: input.contactName || null,
          sellerProfileId: input.sellerProfileId || null,
          sellerName: input.sellerName || null,
          buyerOrganizationId: input.buyerOrganizationId || null,
          buyerOrganizationName: input.buyerOrganizationName,
          buyerTaxId: input.buyerTaxId || null,
          buyerTaxIdFromLookup: input.taxIdFromLookup,
          invoiceType: input.invoiceType === "SPECIAL" ? "SPECIAL" : "NORMAL",
          contentSummary: input.contentSummary || null,
          remark: input.remark || null,
          items: input.items.map((item) => ({
            itemName: item.itemName,
            spec: item.spec || null,
            unit: item.unit || null,
            quantity: item.quantity ?? null,
            amountCents: item.amount,
          })),
        });
        return {
          title: preview.title,
          summary: preview.summary,
          target: preview.target,
        };
      } catch (err) {
        mapDomainErrorToAgentError(err, { resourceLabel: input.orderId });
      }
    },
    async execute(ctx, input) {
      const { actor, invocation } = ctx;
      if (actor.role !== "ADMIN") {
        throw new AgentActionForbiddenError();
      }

      try {
        const result = await prepareInvoiceDraftForActor(
          actor,
          {
            mainOrderId: input.orderId,
            coverageAllocations: input.coverageAllocations,
            allowCrossOrgInvoice: input.allowCrossOrgInvoice,
            contactName: input.contactName || null,
            sellerProfileId: input.sellerProfileId || null,
            sellerName: input.sellerName || null,
            buyerOrganizationId: input.buyerOrganizationId || null,
            buyerOrganizationName: input.buyerOrganizationName,
            buyerTaxId: input.buyerTaxId || null,
            buyerTaxIdFromLookup: input.taxIdFromLookup,
            invoiceType: input.invoiceType === "SPECIAL" ? "SPECIAL" : "NORMAL",
            contentSummary: input.contentSummary || null,
            remark: input.remark || null,
            items: input.items
              .filter((item) => item.itemName.trim())
              .map((item) => ({
                itemName: item.itemName,
                spec: item.spec || null,
                unit: item.unit || null,
                quantity: item.quantity ?? null,
                amountCents: item.amount,
              })),
            sourceAgentProposalId: invocation.proposalId ?? null,
          },
          { invocation },
        );

        return {
          invoice: result.invoice,
          coveredOrderCount: result.coveredOrderCount,
        };
      } catch (err) {
        mapDomainErrorToAgentError(err, { resourceLabel: input.orderId });
      }
    },
    resolveTarget(_input, output) {
      return { type: "order_invoice_request", id: output.invoice.id };
    },
  });

  // ─── finance.match_payment ─────────────────────────────────────────────────
  registerAgentAction({
    key: "finance.match_payment",
    title: "到款匹配",
    description: "根据付款机构和金额，查找可核销的发票组合。返回精确匹配或最接近的候选。",
    domain: "finance",
    riskLevel: "safe",
    readOnly: true,
    presentation: { type: "card", narration: "minimal" },
    inputSchema: objectSchema({
      organizationId: stringSchema("付款机构 ID（Organization.id）"),
      amount: numberSchema("到款金额（元）"),
    }, ["organizationId", "amount"]),
    outputSchema: objectSchema({
      status: stringSchema("MATCHED 或 NO_EXACT_MATCH"),
      organization: objectSchema({ id: stringSchema(), name: stringSchema() }),
      amountCents: integerSchema("到款金额（分）"),
      candidateCount: integerSchema("候选发票数"),
      combinations: arraySchema(objectSchema({
        invoiceIds: arraySchema(stringSchema()),
        sum: integerSchema("组合合计（分）"),
        count: integerSchema(),
      })),
      candidateInvoices: arraySchema(objectSchema({
        id: stringSchema(),
        totalAmount: integerSchema("票面金额（分）"),
        outstanding: integerSchema("剩余可核销（分）"),
        buyerOrganizationName: stringSchema(),
      })),
    }),
    parseInput(raw) {
      const input = ensureObject(raw);
      const amount = readOptionalNumber(input, "amount", { min: 0.01 });
      if (amount == null) throw new AgentActionInputError("amount is required");
      return {
        organizationId: readRequiredString(input, "organizationId"),
        amountCents: yuanToCents(amount),
      };
    },
    async availability(actor) {
      return canReadFinance(actor.role);
    },
    async execute(ctx, input) {
      const actor = ctx.actor;
      try {
        const result = await queryPaymentMatchForActor(
          {
            userId: actor.userId,
            role: actor.role,
            name: actor.name ?? null,
            email: actor.email ?? null,
          },
          {
            organizationId: input.organizationId,
            amountCents: input.amountCents,
          },
        );
        return shapePaymentMatchForAgent(result, input.amountCents);
      } catch (err) {
        mapDomainErrorToAgentError(err, { resourceLabel: "到款匹配" });
      }
    },
  });

  // ─── finance.create_receipt ────────────────────────────────────────────────
  registerAgentAction({
    key: "finance.create_receipt",
    title: "创建回款记录",
    description:
      "创建回款记录并关联到发票（核销）。提供付款机构、金额，以及 allocations 或 selectedOptionId 之一："
      + "allocations 为显式发票分配明细；selectedOptionId 为 match_payment 候选发票 id（service 重跑 match 校验归属后推导 allocations）。",
    domain: "finance",
    riskLevel: "confirm",
    readOnly: false,
    presentation: { type: "card", narration: "minimal" },
    inputSchema: objectSchema({
      amount: numberSchema("回款金额（元）"),
      receivedAt: stringSchema("到账日期 ISO 字符串"),
      organizationId: stringSchema("付款机构 ID"),
      allocations: arraySchema(
        objectSchema({
          invoiceId: stringSchema("发票 ID"),
          amount: numberSchema("分配金额（元）"),
        }, ["invoiceId", "amount"]),
        "发票分配明细，每张发票的核销金额（与 selectedOptionId 互斥）",
      ),
      selectedOptionId: stringSchema("match_payment 候选发票 id（与 allocations 互斥；service 重跑 match 校验归属）"),
      source: stringSchema("来源：BANK / CASH / OTHER，默认 BANK"),
      remark: stringSchema("备注"),
    }, ["amount", "receivedAt", "organizationId"]),
    outputSchema: objectSchema({
      receipt: objectSchema({
        id: stringSchema(),
        amount: integerSchema("金额（分）"),
        receivedAt: stringSchema(),
      }),
      allocationCount: integerSchema(),
    }),
    parseInput(raw) {
      const input = ensureObject(raw);
      const amount = readOptionalNumber(input, "amount", { min: 0.01 });
      if (amount == null) throw new AgentActionInputError("amount is required");
      const allocationsRaw = readOptionalArray(input, "allocations");
      const allocations = (allocationsRaw ?? []).map((item, index) => {
        const record = ensureObject(item, `allocations[${index}]`);
        const allocAmount = readOptionalNumber(record, "amount", { min: 0.01 });
        if (allocAmount == null) throw new AgentActionInputError(`allocations[${index}].amount is required`);
        return {
          invoiceId: readRequiredString(record, "invoiceId"),
          amountYuan: allocAmount,
        };
      });
      const selectedOptionId = readOptionalString(input, "selectedOptionId");
      // allocations / selectedOptionId 互斥与必居其一在 service 层校验（create-receipt.ts
      // assertAllocationsOrOption）；parseInput 只做结构解析，不重复业务规则。
      return {
        amountYuan: amount,
        receivedAt: readRequiredString(input, "receivedAt"),
        organizationId: readRequiredString(input, "organizationId"),
        allocations: allocations.length > 0 ? allocations : undefined,
        selectedOptionId: selectedOptionId || undefined,
        source: readOptionalString(input, "source") || "BANK",
        remark: readOptionalString(input, "remark"),
      };
    },
    async availability(actor) {
      return canWriteFinance(actor.role);
    },
    async buildProposal(ctx, input) {
      const actor = ctx.actor;
      if (!canWriteFinance(actor.role)) throw new AgentActionForbiddenError();

      try {
        const preview = await previewCreateReceiptForActor(actor, input);
        // selectedOptionId 路径：preview 内已重跑 match 解析为 allocations。
        // 冻结解析后的 allocations（raw 形状），confirm 时重跑 parseInput 可往返。
        // 同时保留 selectedOptionId（若有）以便审计追溯；parseInput 对二者都接受。
        const resolvedAllocations = input.allocations && input.allocations.length > 0
          ? input.allocations
          : await resolveAllocationsFromMatch(actor, input).catch(() => undefined);
        return {
          ...preview,
          proposalInput: {
            amount: input.amountYuan,
            receivedAt: input.receivedAt,
            organizationId: input.organizationId,
            ...(resolvedAllocations
              ? {
                  allocations: resolvedAllocations.map((row) => ({
                    invoiceId: row.invoiceId,
                    amount: row.amountYuan,
                  })),
                }
              : { selectedOptionId: input.selectedOptionId }),
            source: input.source,
            remark: input.remark,
          },
        };
      } catch (err) {
        if (err instanceof ApplicationError) {
          mapDomainErrorToAgentError(err, { resourceLabel: "回款" });
        }
        throw err;
      }
    },
    async execute(ctx, input) {
      const actor = ctx.actor;
      if (!canWriteFinance(actor.role)) throw new AgentActionForbiddenError();

      try {
        const result = await createReceiptForActor(
          actor,
          {
            ...input,
            // proposal 级业务幂等键：服务端从 ctx.invocation 注入（绝不来自
            // 模型输入）。业务写入成功后 finalize 前崩溃 → 租约回收重试时，
            // FinanceReceipt.sourceAgentProposalId 唯一约束幂等回放，不重复回款。
            sourceAgentProposalId: ctx.invocation.proposalId ?? null,
          },
          { invocation: ctx.invocation },
        );

        return {
          receipt: {
            id: result.receipt.id,
            amount: result.receipt.amountCents,
            receivedAt: result.receipt.receivedAt.toISOString(),
          },
          allocationCount: result.allocations.length,
        };
      } catch (err) {
        if (err instanceof ReceiptMissingProfileError) throw new AgentActionInputError(err.message);
        if (err instanceof ApplicationError) {
          mapDomainErrorToAgentError(err, { resourceLabel: "回款" });
        }
        mapDomainErrorToAgentError(err, { domainClasses: [AllocationReceiptError], resourceLabel: "回款" });
      }
    },
    resolveTarget(_input, output) {
      return { type: "finance_receipt", id: output.receipt.id };
    },
  });

  // ─── finance.get_invoice_detail ────────────────────────────────────────────
  registerAgentAction({
    key: "finance.get_invoice_detail",
    title: "查看发票详情",
    description: "获取发票申请的完整详情，包含行项目、覆盖订单和核销状态。",
    domain: "finance",
    riskLevel: "safe",
    readOnly: true,
    presentation: { type: "card", narration: "minimal" },
    inputSchema: objectSchema({
      invoiceId: stringSchema("发票申请 ID"),
    }, ["invoiceId"]),
    outputSchema: objectSchema({
      invoice: objectSchema({
        id: stringSchema(),
        status: stringSchema(),
        totalAmount: integerSchema("票面金额（分）"),
        buyerOrganizationName: stringSchema(),
        invoiceType: stringSchema(),
        actualInvoiceNo: stringSchema(),
      }),
      // 命名为 lineItems，避免顶层 items[] 被 GenUI 契约误判为「实体列表卡」。
      lineItems: arraySchema(objectSchema({
        itemName: stringSchema(),
        amount: integerSchema("金额（分）"),
      })),
      coveredOrders: arraySchema(objectSchema({
        orderId: stringSchema(),
        orderNo: stringSchema("订单号"),
        title: stringSchema("订单标题"),
        amount: integerSchema("分摊金额（分）"),
      })),
      allocatedAmount: integerSchema("已核销金额（分）"),
      outstandingAmount: integerSchema("剩余可核销（分）"),
    }),
    parseInput(raw) {
      const input = ensureObject(raw);
      return { invoiceId: readRequiredString(input, "invoiceId") };
    },
    async availability(actor) {
      return canReadFinance(actor.role);
    },
    async execute(ctx, input) {
      const actor = ctx.actor;
      if (!canReadFinance(actor.role)) throw new AgentActionForbiddenError();

      try {
        const detail = await getInvoiceDetailForActor(actor, input.invoiceId);
        return shapeInvoiceDetailForAgent(detail);
      } catch (err) {
        mapDomainErrorToAgentError(err, { resourceLabel: "发票" });
      }
    },
  });

  // ─── finance.analyze_invoice_file ──────────────────────────────────────────
  registerAgentAction({
    key: "finance.analyze_invoice_file",
    title: "识别并匹配发票",
    description:
      "对私有 staging 中的一张真实发票调用 GLM-OCR，确定性提取票面字段，并在有效开票申请中生成候选匹配。只写 staging/审计，不写业务发票表。多文件必须按上传顺序逐张调用；禁止编造 stagingFileId/sha256/version，必须使用服务端 verified 上下文。OCR 未配置时不可用。识别后若唯一匹配，可再调用 finance.register_issued_invoice 生成本张确认 proposal。",
    domain: "finance",
    riskLevel: "safe",
    readOnly: false,
    presentation: { type: "card", narration: "minimal" },
    inputSchema: objectSchema({
      stagingFileId: stringSchema("私有 staging 文件 ID"),
      expectedSha256: stringSchema("staging 文件 SHA-256"),
      expectedStagingVersion: integerSchema("staging version"),
      forceRetry: booleanSchema("是否强制重新 OCR（仍需通过所有权/hash/TTL 校验）"),
    }, ["stagingFileId", "expectedSha256", "expectedStagingVersion"]),
    outputSchema: objectSchema({
      staging: objectSchema({
        id: stringSchema(),
        fileName: stringSchema(),
        status: stringSchema(),
        sha256: stringSchema(),
        version: integerSchema(),
      }),
      extracted: objectSchema({
        invoiceNumber: stringSchema(),
        issuedAt: stringSchema(),
        buyerName: stringSchema(),
        buyerTaxIdMasked: stringSchema(),
        sellerName: stringSchema(),
        sellerTaxIdMasked: stringSchema(),
        invoiceType: stringSchema(),
        totalAmountCents: integerSchema(),
        isRedInvoice: booleanSchema(),
        warnings: arraySchema(stringSchema()),
      }),
      match: objectSchema({
        status: stringSchema(),
        candidates: arraySchema(objectSchema({})),
      }),
    }),
    parseInput(raw) {
      const input = ensureObject(raw);
      const expectedStagingVersion = readOptionalInteger(input, "expectedStagingVersion", { min: 1 });
      if (expectedStagingVersion == null) {
        throw new AgentActionInputError("expectedStagingVersion is required");
      }
      return {
        stagingFileId: readRequiredString(input, "stagingFileId"),
        expectedSha256: readRequiredString(input, "expectedSha256"),
        expectedStagingVersion,
        forceRetry: readOptionalBoolean(input, "forceRetry") ?? false,
      };
    },
    async availability(actor) {
      if (actor.role !== "ADMIN") return false;
      return isGlmOcrConfigured();
    },
    async execute(ctx, input) {
      const { actor, invocation } = ctx;
      if (actor.role !== "ADMIN") throw new AgentActionForbiddenError();
      if (!isGlmOcrConfigured()) {
        throw new AgentActionInputError("未启用发票 OCR（缺少 ZHIPU_API_KEY）");
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 60_000);
      try {
        return await analyzeInvoiceFileForActor(
          {
            userId: actor.userId,
            role: actor.role,
            name: actor.name,
            email: actor.email,
          },
          input,
          {
            signal: controller.signal,
            invocation: {
              channel: "agent",
              agentRunId: invocation.agentRunId ?? null,
              proposalId: invocation.proposalId ?? null,
            },
          },
        );
      } catch (err) {
        if (err instanceof ApplicationError) {
          mapDomainErrorToAgentError(err, { resourceLabel: "invoice_staging" });
        }
        mapDomainErrorToAgentError(err, { domainClasses: [InvoiceOcrError, GlmOcrClientError, InvoiceStagingError], resourceLabel: "invoice_staging" });
      } finally {
        clearTimeout(timeout);
      }
    },
  });

  // ─── finance.get_invoice_staging_context（safe / 只读）─────────────────────
  // P0-4 断链修复辅助：propose_invoice_registration facade 需要 stagingFileId/sha256/version
  // （verified-context 字段），但 public input 禁带（manifest FORBIDDEN_PUBLIC_INPUT_FIELDS）。
  // 本 action 按 owner gate 解析这些字段供 facade 注入，避免 facade 直连 canonical service。
  // owner gate 在 getOwnedStagingFile 内（不存在/越权合并 404）。
  registerAgentAction({
    key: "finance.get_invoice_staging_context",
    title: "解析发票 staging 上下文",
    description:
      "按 owner gate 解析私有发票 staging 文件上下文（stagingFileId + sha256 + version + status），"
      + "供 propose_invoice_registration facade 注入 verified-context 字段（hash/version），"
      + "避免 public input 直传这些字段被模型编造。不写任何数据。",
    domain: "finance",
    riskLevel: "safe",
    readOnly: true,
    presentation: { type: "none", narration: "minimal" },
    inputSchema: objectSchema({
      stagingFileId: stringSchema("私有发票 staging 文件 ID"),
    }, ["stagingFileId"]),
    outputSchema: objectSchema({
      stagingFileId: stringSchema(),
      sha256: stringSchema(),
      version: integerSchema(),
      status: stringSchema(),
    }),
    parseInput(raw) {
      const input = ensureObject(raw);
      return { stagingFileId: readRequiredString(input, "stagingFileId") };
    },
    async availability(actor) {
      // 与 analyze_invoice_file 一致：仅 ADMIN 可用（私有发票 staging 的所有者为上传者，
      // 但 OCR/register 链当前仅 ADMIN 开放）。
      return actor.role === "ADMIN";
    },
    async execute(ctx, input) {
      const actor = ctx.actor;
      if (actor.role !== "ADMIN") throw new AgentActionForbiddenError();
      try {
        const staging = await getOwnedStagingFile({
          stagingFileId: input.stagingFileId,
          userId: actor.userId,
          requireActive: true,
        });
        return {
          stagingFileId: staging.id,
          sha256: staging.sha256,
          version: staging.version,
          status: staging.status,
        };
      } catch (err) {
        mapDomainErrorToAgentError(err, { domainClasses: [InvoiceStagingError], resourceLabel: "invoice_staging" });
      }
    },
  });

  // ─── finance.register_issued_invoice ───────────────────────────────────────
  registerAgentAction({
    key: "finance.register_issued_invoice",
    title: "登记已开发票",
    description:
      "将一份已上传到私有 staging 的真实发票文件，登记到一条 REQUESTED 订单开票申请：保存正式附件并推进为 ISSUED。必须经用户确认；一次只处理一张。若客户端隐藏上下文已提供 verified stagingFileId/sha256/version，必须原样使用这些字段，禁止编造。多文件场景下对每张发票单独调用本 action，禁止批量落库。",
    domain: "finance",
    riskLevel: "confirm",
    readOnly: false,
    presentation: { type: "card", narration: "minimal" },
    inputSchema: objectSchema({
      stagingFileId: stringSchema("私有 staging 文件 ID（由 /api/agent/invoice-staging 上传返回）"),
      invoiceRequestId: stringSchema("目标订单开票申请 ID（ExternalOrderInvoiceRequest.id）"),
      actualInvoiceNo: stringSchema("真实发票号（MVP 必填）"),
      actualIssuedAt: stringSchema("开票日期 YYYY-MM-DD"),
      expectedSha256: stringSchema("staging 文件 SHA-256（用于发现 proposal 生成后文件变化）"),
      expectedStagingVersion: integerSchema("staging version（用于发现 OCR/修正后的版本变化）"),
    }, ["stagingFileId", "invoiceRequestId", "actualInvoiceNo", "expectedSha256", "expectedStagingVersion"]),
    outputSchema: objectSchema({
      invoice: objectSchema({
        id: stringSchema(),
        status: stringSchema(),
        actualInvoiceNo: stringSchema(),
        actualIssuedAt: stringSchema(),
      }),
      document: objectSchema({
        id: stringSchema(),
        fileName: stringSchema(),
        fileUrl: stringSchema(),
        mimeType: stringSchema(),
        fileSize: integerSchema(),
        sha256: stringSchema(),
      }),
      touchedOrderIds: arraySchema(stringSchema()),
    }),
    parseInput(raw) {
      const input = ensureObject(raw);
      const expectedStagingVersion = readOptionalInteger(input, "expectedStagingVersion", { min: 1 });
      if (expectedStagingVersion == null) {
        throw new AgentActionInputError("expectedStagingVersion is required");
      }
      const actualIssuedAt = readOptionalString(input, "actualIssuedAt");
      if (actualIssuedAt && !/^\d{4}-\d{2}-\d{2}$/.test(actualIssuedAt)) {
        throw new AgentActionInputError("actualIssuedAt must be YYYY-MM-DD");
      }
      return {
        stagingFileId: readRequiredString(input, "stagingFileId"),
        invoiceRequestId: readRequiredString(input, "invoiceRequestId"),
        actualInvoiceNo: readRequiredString(input, "actualInvoiceNo"),
        actualIssuedAt,
        expectedSha256: readRequiredString(input, "expectedSha256"),
        expectedStagingVersion,
      };
    },
    async availability(actor) {
      return actor.role === "ADMIN";
    },
    async buildProposal(ctx, input) {
      const actor = ctx.actor;
      if (actor.role !== "ADMIN") throw new AgentActionForbiddenError();

      try {
        return await previewRegisterIssuedInvoiceForActor(
          actor,
          input,
          AGENT_REGISTER_ISSUED_INVOICE_POLICY,
        );
      } catch (err) {
        mapRegisterIssuedInvoiceAgentError(err);
      }
    },
    async execute(ctx, input) {
      const { actor, invocation } = ctx;
      if (actor.role !== "ADMIN") throw new AgentActionForbiddenError();

      try {
        return await registerIssuedInvoiceForActor(
          actor,
          input,
          {
            policy: AGENT_REGISTER_ISSUED_INVOICE_POLICY,
            invocation: { channel: "agent", proposalId: invocation.proposalId ?? null },
          },
        );
      } catch (err) {
        mapRegisterIssuedInvoiceAgentError(err);
      }
    },
    resolveTarget(_input, output) {
      return { type: "order_invoice_request", id: output.invoice.id };
    },
  });

  // ─── Phase 3: 项目订单开票规划与提交 ─────────────────────────────────────────
  // 功能开关：显式 AGENT_PROJECT_INVOICE_PLANNING_ENABLED=false 关闭
  if (process.env.AGENT_PROJECT_INVOICE_PLANNING_ENABLED !== "false") {
    registerAgentAction({
      key: "finance.plan_project_invoice_requests",
      title: "规划项目订单开票申请",
      description: "解析项目关联订单，计算可开票额度，按确定性规则生成一张或多张开票计划。只读，不写业务数据。",
      domain: "finance",
      riskLevel: "safe",
      readOnly: true,
      presentation: { type: "card", narration: "minimal" },
      inputSchema: objectSchema({
        projectId: stringSchema("项目 ID"),
        orderIds: arraySchema("指定订单 ID 子集（省略则考察全部关联订单）"),
        invoiceType: stringSchema("票种：NORMAL 或 SPECIAL"),
        sellerProfileId: stringSchema("销方主体 BillingProfile ID"),
        splitMode: stringSchema("拆票模式：AUTO / ONE_PER_ORDER / COMBINE_COMPATIBLE"),
        requestedTotalAmountYuan: numberSchema("用户指定的开票总额（元）。说「开 500 元」时传 500；服务端转分。"),
        allocations: arraySchema("每笔订单金额分配 [{orderId, amountYuan}]，金额单位为元"),
        contentSummary: stringSchema("开票内容摘要"),
        remark: stringSchema("备注"),
      }, ["projectId"]),
      outputSchema: objectSchema({}),
      parseInput(raw) {
        const input = ensureObject(raw);
        let money: ReturnType<typeof parsePlanInvoiceMoneyToCents>;
        try {
          money = parsePlanInvoiceMoneyToCents(input, yuanToCents);
        } catch (err) {
          throw new AgentActionInputError(err instanceof Error ? err.message : "开票金额参数无效");
        }
        return {
          projectId: readRequiredString(input, "projectId"),
          orderIds: readOptionalArray(input, "orderIds")?.filter((x): x is string => typeof x === "string") || undefined,
          invoiceType: (() => {
            const v = readOptionalString(input, "invoiceType");
            if (v && v !== "NORMAL" && v !== "SPECIAL") throw new AgentActionInputError("invoiceType 只允许 NORMAL 或 SPECIAL");
            return v as "NORMAL" | "SPECIAL" | undefined;
          })(),
          sellerProfileId: readOptionalString(input, "sellerProfileId"),
          splitMode: (() => {
            const v = readOptionalString(input, "splitMode");
            if (v && !["AUTO", "ONE_PER_ORDER", "COMBINE_COMPATIBLE"].includes(v)) throw new AgentActionInputError("splitMode 只允许 AUTO / ONE_PER_ORDER / COMBINE_COMPATIBLE");
            return v as "AUTO" | "ONE_PER_ORDER" | "COMBINE_COMPATIBLE" | undefined;
          })(),
          requestedTotalAmountCents: money.requestedTotalAmountCents,
          allocations: money.allocations,
          contentSummary: readOptionalString(input, "contentSummary"),
          remark: readOptionalString(input, "remark"),
        };
      },
      async availability(actor) {
        return actor.role === "ADMIN";
      },
      async execute(ctx, input) {
        const actor = ctx.actor;
        if (actor.role !== "ADMIN") throw new AgentActionForbiddenError();
        try {
          return await planProjectInvoiceRequestsForActor(actor, input);
        } catch (err) {
          mapDomainErrorToAgentError(err, { resourceLabel: input.projectId });
        }
      },
    });

    registerAgentAction({
      key: "finance.submit_invoice_request",
      title: "提交订单开票申请",
      description: "用户确认后创建一张 REQUESTED 订单开票申请。一次只处理一张。",
      domain: "finance",
      riskLevel: "confirm",
      readOnly: false,
      serialByUser: true,
      presentation: { type: "card", narration: "minimal" },
      inputSchema: objectSchema({
        projectId: stringSchema("来源项目 ID（仅审计，不参与容量计算）"),
        mainOrderId: stringSchema("主订单 ID"),
        coverageAllocations: arraySchema("覆盖订单分配 [{orderId, amountCents}]"),
        sellerProfileId: stringSchema("销方主体 BillingProfile ID"),
        buyerOrganizationId: stringSchema("购方机构 Organization ID"),
        buyerOrganizationName: stringSchema("购方机构名称"),
        invoiceType: stringSchema("票种：NORMAL 或 SPECIAL"),
        contactName: stringSchema("联系人"),
        contentSummary: stringSchema("开票内容"),
        remark: stringSchema("备注"),
        items: arraySchema("明细行 [{itemName, spec?, unit?, quantity?, amountCents}]"),
      }, ["mainOrderId", "coverageAllocations", "sellerProfileId", "buyerOrganizationId", "buyerOrganizationName", "invoiceType", "items"]),
      outputSchema: objectSchema({}),
      parseInput(raw) {
        const input = ensureObject(raw);
        const invoiceType = readRequiredString(input, "invoiceType");
        if (invoiceType !== "NORMAL" && invoiceType !== "SPECIAL") {
          throw new AgentActionInputError("invoiceType 只允许 NORMAL 或 SPECIAL");
        }
        const rawItems = readOptionalArray(input, "items");
        if (!rawItems || rawItems.length === 0) throw new AgentActionInputError("items 不能为空");
        const items = rawItems.map((it) => {
          const obj = it as Record<string, unknown>;
          const itemName = obj.itemName;
          const amountCents = obj.amountCents;
          if (typeof itemName !== "string" || !itemName.trim()) throw new AgentActionInputError("items 每项需包含 itemName");
          if (typeof amountCents !== "number" || !Number.isFinite(amountCents) || amountCents <= 0) throw new AgentActionInputError("items 每项 amountCents 必须为正整数");
          return {
            itemName: itemName.trim(),
            spec: typeof obj.spec === "string" ? obj.spec : null,
            unit: typeof obj.unit === "string" ? obj.unit : null,
            quantity: typeof obj.quantity === "number" && Number.isFinite(obj.quantity) ? obj.quantity : null,
            amountCents: Math.round(amountCents),
          };
        });
        const rawAllocations = readOptionalArray(input, "coverageAllocations");
        if (!rawAllocations || rawAllocations.length === 0) throw new AgentActionInputError("coverageAllocations 不能为空");
        const coverageAllocations = rawAllocations.map((a) => {
          const obj = a as Record<string, unknown>;
          if (typeof obj.orderId !== "string" || typeof obj.amountCents !== "number" || obj.amountCents <= 0) {
            throw new AgentActionInputError("coverageAllocations 每项需包含 orderId 和正整数 amountCents");
          }
          return { orderId: obj.orderId, amountCents: Math.round(obj.amountCents) };
        });
        return {
          projectId: readOptionalString(input, "projectId"),
          mainOrderId: readRequiredString(input, "mainOrderId"),
          coverageAllocations,
          sellerProfileId: readRequiredString(input, "sellerProfileId"),
          buyerOrganizationId: readRequiredString(input, "buyerOrganizationId"),
          buyerOrganizationName: readRequiredString(input, "buyerOrganizationName"),
          invoiceType: invoiceType as "NORMAL" | "SPECIAL",
          contactName: readOptionalString(input, "contactName"),
          contentSummary: readOptionalString(input, "contentSummary"),
          remark: readOptionalString(input, "remark"),
          items,
        };
      },
      async availability(actor) {
        return actor.role === "ADMIN";
      },
      async buildProposal(ctx, input) {
        const actor = ctx.actor;
        if (actor.role !== "ADMIN") throw new AgentActionForbiddenError();
        try {
          return await previewSubmitInvoiceRequestForActor(actor, input);
        } catch (err) {
          mapDomainErrorToAgentError(err, { resourceLabel: input.mainOrderId });
        }
      },
      async execute(ctx, input) {
        const { actor, invocation } = ctx;
        if (actor.role !== "ADMIN") throw new AgentActionForbiddenError();

        try {
          return await submitInvoiceRequestForActor(
            actor,
            {
              ...input,
              sourceAgentProposalId: invocation.proposalId ?? null,
            },
            { invocation },
          );
        } catch (err) {
          mapDomainErrorToAgentError(err, { resourceLabel: input.mainOrderId });
        }
      },
      resolveTarget(_input, output) {
        return { type: "order_invoice_request", id: output.invoice.id };
      },
    });
  }

  // ─── finance.adopt_agent_attachment_as_invoice ───────────────────────────
  registerAgentAction({
    key: "finance.adopt_agent_attachment_as_invoice",
    title: "采纳附件为发票",
    description:
      "把一个已验证的通用附件（仅 PDF/JPEG/PNG）幂等采纳到发票私有 staging，随后复用 finance.analyze_invoice_file 与 " +
      "finance.register_issued_invoice 的现有闭环。仅 ADMIN。服务端硬拒绝 PDF/JPEG/PNG 以外的 MIME。" +
      "同一源附件重复采纳返回同一 invoice staging；目标失效后可安全重新采纳。",
    domain: "finance",
    riskLevel: "safe",
    readOnly: false,
    presentation: { type: "none", narration: "normal" },
    inputSchema: objectSchema({
      stagingFileId: stringSchema("通用附件 staging ID"),
      expectedSha256: stringSchema("通用附件 SHA-256"),
      expectedVersion: integerSchema("通用附件 version"),
    }, ["stagingFileId", "expectedSha256", "expectedVersion"]),
    outputSchema: objectSchema({
      invoiceStaging: objectSchema({
        stagingFileId: stringSchema(),
        fileName: stringSchema(),
        mimeType: stringSchema(),
        fileSize: integerSchema(),
        sha256: stringSchema(),
        version: integerSchema(),
        status: stringSchema(),
      }),
      reused: booleanSchema("是否复用了已有 invoice staging"),
    }),
    parseInput(raw) {
      const input = ensureObject(raw);
      const expectedVersion = readOptionalInteger(input, "expectedVersion", { min: 1 });
      if (expectedVersion == null) throw new AgentActionInputError("expectedVersion is required");
      return {
        stagingFileId: readRequiredString(input, "stagingFileId"),
        expectedSha256: readRequiredString(input, "expectedSha256"),
        expectedVersion,
      };
    },
    async availability(actor) {
      return actor.role === "ADMIN";
    },
    async execute(ctx, input) {
      const { actor, invocation } = ctx;
      if (actor.role !== "ADMIN") throw new AgentActionForbiddenError();

      try {
        return await adoptAgentAttachmentAsInvoiceForActor(
          {
            userId: actor.userId,
            role: actor.role,
            name: actor.name,
            email: actor.email,
          },
          input,
          {
            invocation: {
              channel: "agent",
              agentRunId: invocation.agentRunId ?? null,
              proposalId: invocation.proposalId ?? null,
            },
          },
        );
      } catch (err) {
        if (err instanceof ApplicationError) {
          mapDomainErrorToAgentError(err, { resourceLabel: "attachment" });
        }
        mapDomainErrorToAgentError(err, { domainClasses: [StagingError], resourceLabel: "attachment" });
      }
    },
  });

  registerFinanceBankFlowActions();
}

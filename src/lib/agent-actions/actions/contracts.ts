import {
  canGenerateContract,
  canViewTemplates,
} from "@/lib/contracts/permissions";
import { isOrderAccessBlocked } from "@/lib/orders/permissions";
import { checkContractCoverageForActor } from "@/lib/contracts/application/check-contract-coverage";
import {
  listContractTemplatesForActor,
  shapeContractTemplateForAgent,
} from "@/lib/contracts/application/query-contract-templates";
import {
  queryContractsForActor,
  shapeContractListForAgent,
} from "@/lib/contracts/application/query-contracts";
import {
  getContractDetailForActor,
  shapeContractDetailForAgent,
} from "@/lib/contracts/application/get-contract-detail";
import {
  prepareContractDraftForActor,
  previewGenerateContractForActor,
  type BuyerOverridesInput,
} from "@/lib/contracts/application/prepare-contract-draft";
import { generateContractForActor } from "@/lib/contracts/application/generate-contract";
import {
  AgentActionInputError,
  mapDomainErrorToAgentError,
} from "../errors";
import { registerAgentAction } from "../registry";
import {
  arraySchema,
  booleanSchema,
  clampLimit,
  ensureObject,
  integerSchema,
  objectSchema,
  readOptionalArray,
  readOptionalBoolean,
  readOptionalInteger,
  readOptionalString,
  readRequiredString,
  stringSchema,
} from "../schemas";

function buyerOverridesSchema() {
  return objectSchema({
    buyerName: stringSchema("买方姓名/联系人覆盖"),
    buyerOrgName: stringSchema("买方单位名称覆盖"),
    buyerTaxId: stringSchema("买方税号覆盖"),
    buyerAddress: stringSchema("买方地址覆盖"),
    buyerPhone: stringSchema("买方电话覆盖"),
    buyerEmail: stringSchema("买方邮箱覆盖"),
  });
}

function parseBuyerOverrides(raw: unknown): BuyerOverridesInput {
  if (raw == null) return {};
  const record = ensureObject(raw, "buyerOverrides");
  return {
    buyerName: readOptionalString(record, "buyerName"),
    buyerOrgName: readOptionalString(record, "buyerOrgName"),
    buyerTaxId: readOptionalString(record, "buyerTaxId"),
    buyerAddress: readOptionalString(record, "buyerAddress"),
    buyerPhone: readOptionalString(record, "buyerPhone"),
    buyerEmail: readOptionalString(record, "buyerEmail"),
  };
}

/** 解析必填 orderIds 数组：去重（保留首次出现顺序，首项即 primaryOrderId），拒绝空数组。 */
function readOrderIdsArray(record: Record<string, unknown>, key: string): string[] {
  const raw = readOptionalArray(record, key);
  if (!raw || raw.length === 0) {
    throw new AgentActionInputError(`${key} 不能为空`);
  }
  const seen = new Set<string>();
  const result: string[] = [];
  raw.forEach((value, index) => {
    if (typeof value !== "string" || !value.trim()) {
      throw new AgentActionInputError(`${key}[${index}] 必须是字符串`);
    }
    const trimmed = value.trim();
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      result.push(trimmed);
    }
  });
  return result;
}

/** 解析可选 orderIds 数组（check_coverage 用；省略返回 undefined）。 */
function readOptionalOrderIdsArray(record: Record<string, unknown>, key: string): string[] | undefined {
  const raw = readOptionalArray(record, key);
  if (!raw) return undefined;
  const seen = new Set<string>();
  const result: string[] = [];
  raw.forEach((value, index) => {
    if (typeof value !== "string" || !value.trim()) {
      throw new AgentActionInputError(`${key}[${index}] 必须是字符串`);
    }
    const trimmed = value.trim();
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      result.push(trimmed);
    }
  });
  return result;
}


export function registerContractActions() {
  // ─── contracts.check_coverage ───────────────────────────────────────────────
  registerAgentAction({
    key: "contracts.check_coverage",
    title: "检查合同覆盖情况",
    description:
      "查询订单是否已有合同覆盖。可按订单 ID 列表、客户档案、下单日期范围过滤；只返回调用者可见范围内的订单（scope 内天然安全）。"
      + "合同覆盖口径：排除生成中断的 PENDING_FILE 记录和交货单（DELIVERY_NOTE）类别，同一订单允许被多份合同重复覆盖。",
    domain: "contracts",
    riskLevel: "safe",
    readOnly: true,
    presentation: { type: "card", narration: "minimal" },
    inputSchema: objectSchema({
      orderIds: arraySchema(stringSchema("订单 ID"), "限定要检查的订单 ID 列表；省略则按 customerId/dateRange 过滤当前用户可见订单"),
      customerId: stringSchema("客户档案 ID（CrmCustomerProfile.id），限定订单范围"),
      dateRange: objectSchema({
        from: stringSchema("起始日期（ISO 8601），按订单下单时间 orderedAt 过滤"),
        to: stringSchema("结束日期（ISO 8601）"),
      }),
      uncoveredOnly: booleanSchema("只返回未覆盖的订单，默认 false"),
    }),
    outputSchema: objectSchema({
      orders: arraySchema(
        objectSchema({
          orderId: stringSchema(),
          orderNo: stringSchema(),
          customerName: stringSchema(),
          totalAmountCents: integerSchema("订单总金额（分）"),
          hasContract: booleanSchema(),
          contracts: arraySchema(
            objectSchema({ contractId: stringSchema(), contractNo: stringSchema(), status: stringSchema() }),
          ),
        }),
      ),
      uncoveredCount: integerSchema(),
      totalCount: integerSchema(),
    }),
    parseInput(raw) {
      const input = ensureObject(raw);
      const dateRangeRaw = input.dateRange;
      let dateRange: { from?: string; to?: string } | undefined;
      if (dateRangeRaw != null) {
        const record = ensureObject(dateRangeRaw, "dateRange");
        dateRange = {
          from: readOptionalString(record, "from"),
          to: readOptionalString(record, "to"),
        };
      }
      return {
        orderIds: readOptionalOrderIdsArray(input, "orderIds"),
        customerId: readOptionalString(input, "customerId"),
        dateRange,
        uncoveredOnly: readOptionalBoolean(input, "uncoveredOnly") ?? false,
      };
    },
    async availability(actor) {
      return !isOrderAccessBlocked(actor.role);
    },
    async execute(ctx, input) {
      const actor = ctx.actor;
      try {
        return await checkContractCoverageForActor(actor, {
          orderIds: input.orderIds,
          customerId: input.customerId,
          dateRange: input.dateRange,
          uncoveredOnly: input.uncoveredOnly,
        });
      } catch (err) {
        mapDomainErrorToAgentError(err, { resourceLabel: "订单" });
      }
    },
  });

  // ─── contracts.prepare_draft ─────────────────────────────────────────────────
  registerAgentAction({
    key: "contracts.prepare_draft",
    title: "准备合同草稿",
    description:
      "生成合同前的预检：全量校验订单访问权限、同买方校验、解析默认模板/开票主体、组装买方字段和金额大写，"
      + "创建/复用生成意图（generationIntentId），并给出数据质量提示（税号缺失、订单已有合同等）。"
      + "不生成真实合同文件；确认生成需调用 contracts.generate 并传入返回的 generationIntentId。",
    domain: "contracts",
    riskLevel: "safe",
    readOnly: false,
    presentation: { type: "card", narration: "minimal" },
    inputSchema: objectSchema(
      {
        orderIds: arraySchema(stringSchema("订单 ID"), "要合并生成合同的订单 ID 列表；首项即主订单（买方等字段以此为准）"),
        templateId: stringSchema("合同模板 ID，省略时按首单类别自动推断默认模板"),
        sellerProfileId: stringSchema("开票主体 BillingProfile ID，省略时使用唯一默认开票主体"),
        buyerOverrides: buyerOverridesSchema(),
        remark: stringSchema("备注"),
      },
      ["orderIds"],
    ),
    outputSchema: objectSchema({
      draft: objectSchema({
        generationIntentId: stringSchema(),
        inputDigest: stringSchema(),
        template: objectSchema({ id: stringSchema(), name: stringSchema(), category: stringSchema(), isDefault: booleanSchema() }),
        sellerProfile: objectSchema({ id: stringSchema(), name: stringSchema(), taxId: stringSchema() }),
        buyerFields: objectSchema({
          buyerName: stringSchema(),
          buyerOrgName: stringSchema(),
          buyerTaxId: stringSchema(),
          buyerAddress: stringSchema(),
          buyerPhone: stringSchema(),
          buyerEmail: stringSchema(),
        }),
        totalAmountCents: integerSchema("合计金额（分）"),
        totalAmountInWords: stringSchema("金额大写"),
        lineCount: integerSchema("覆盖订单数"),
        coveredOrders: arraySchema(objectSchema({ orderId: stringSchema(), orderNo: stringSchema(), title: stringSchema() })),
        primaryOrderId: stringSchema(),
        warnings: arraySchema(stringSchema()),
      }),
    }),
    parseInput(raw) {
      const input = ensureObject(raw);
      return {
        orderIds: readOrderIdsArray(input, "orderIds"),
        templateId: readOptionalString(input, "templateId"),
        sellerProfileId: readOptionalString(input, "sellerProfileId"),
        buyerOverrides: parseBuyerOverrides(input.buyerOverrides),
        remark: readOptionalString(input, "remark"),
      };
    },
    async availability(actor) {
      return canGenerateContract(actor.role);
    },
    async execute(ctx, input) {
      const actor = ctx.actor;
      try {
        const draft = await prepareContractDraftForActor(actor, input);
        return { draft };
      } catch (err) {
        mapDomainErrorToAgentError(err, { resourceLabel: "合同" });
      }
    },
  });

  // ─── contracts.generate ──────────────────────────────────────────────────────
  registerAgentAction({
    key: "contracts.generate",
    title: "生成合同",
    description:
      "确认后生成正式合同文件（.docx）。需先调用 contracts.prepare_draft 获取 generationIntentId；"
      + "execute 层会重新校验全量订单权限、同买方约束，并比对输入摘要（防止确认期间输入被篡改）。"
      + "幂等：同一 generationIntentId 重复确认返回已有合同，不会重复生成。",
    domain: "contracts",
    riskLevel: "confirm",
    readOnly: false,
    serialByUser: true,
    presentation: { type: "card", narration: "minimal" },
    inputSchema: objectSchema(
      {
        generationIntentId: stringSchema("contracts.prepare_draft 返回的生成意图 ID"),
        orderIds: arraySchema(stringSchema("订单 ID"), "要合并生成合同的订单 ID 列表，须与 prepare_draft 一致"),
        templateId: stringSchema("合同模板 ID（已解析默认值后的最终值）"),
        sellerProfileId: stringSchema("开票主体 BillingProfile ID（已解析默认值后的最终值）"),
        buyerOverrides: buyerOverridesSchema(),
        remark: stringSchema("备注"),
      },
      ["generationIntentId", "orderIds", "templateId", "sellerProfileId"],
    ),
    outputSchema: objectSchema({
      contractId: stringSchema(),
      contractNo: stringSchema(),
      downloadUrl: stringSchema(),
      coveredOrderCount: integerSchema(),
      totalAmountCents: integerSchema("合计金额（分）"),
    }),
    parseInput(raw) {
      const input = ensureObject(raw);
      return {
        generationIntentId: readRequiredString(input, "generationIntentId"),
        orderIds: readOrderIdsArray(input, "orderIds"),
        templateId: readRequiredString(input, "templateId"),
        sellerProfileId: readRequiredString(input, "sellerProfileId"),
        buyerOverrides: parseBuyerOverrides(input.buyerOverrides),
        remark: readOptionalString(input, "remark"),
      };
    },
    async availability(actor) {
      return canGenerateContract(actor.role);
    },
    async buildProposal(ctx, input) {
      const actor = ctx.actor;
      try {
        return await previewGenerateContractForActor(actor, input);
      } catch (err) {
        mapDomainErrorToAgentError(err, { resourceLabel: "合同" });
      }
    },
    async execute(ctx, input) {
      const { actor, invocation } = ctx;
      try {
        const result = await generateContractForActor(actor, input, {
          invocation: { channel: "agent", proposalId: invocation.proposalId ?? null },
        });
        return {
          contractId: result.contractId,
          contractNo: result.contractNo,
          downloadUrl: `/api/contracts/${result.contractId}/download`,
          coveredOrderCount: result.coveredOrderCount,
          totalAmountCents: result.totalAmountCents,
        };
      } catch (err) {
        mapDomainErrorToAgentError(err, { resourceLabel: "合同" });
      }
    },
  });

  // ─── contracts.get_detail ────────────────────────────────────────────────────
  registerAgentAction({
    key: "contracts.get_detail",
    title: "查看合同详情",
    description:
      "获取合同完整详情：编号、状态、金额、卖方/买方快照、覆盖订单、下载链接。"
      + "调用者必须对该合同覆盖的全部订单均有访问权限，否则按未找到处理（fail-closed，不做裁剪）。无 signingDate 字段。",
    domain: "contracts",
    riskLevel: "safe",
    readOnly: true,
    presentation: { type: "card", narration: "minimal" },
    inputSchema: objectSchema({ contractId: stringSchema("合同 ID") }, ["contractId"]),
    outputSchema: objectSchema({
      contractNo: stringSchema(),
      status: stringSchema(),
      category: stringSchema(),
      totalAmountCents: integerSchema("合同金额（分）"),
      seller: objectSchema({
        name: stringSchema(),
        taxId: stringSchema(),
        bankName: stringSchema(),
        bankAccount: stringSchema(),
        address: stringSchema(),
        phone: stringSchema(),
        legalRepresentative: stringSchema(),
      }),
      buyer: objectSchema({
        buyerName: stringSchema(),
        buyerOrgName: stringSchema(),
        taxId: stringSchema(),
        address: stringSchema(),
        phone: stringSchema(),
        email: stringSchema(),
      }),
      coveredOrders: arraySchema(objectSchema({ orderId: stringSchema(), orderNo: stringSchema(), title: stringSchema() })),
      downloadUrl: stringSchema(),
      createdAt: stringSchema(),
      creatorName: stringSchema(),
    }),
    parseInput(raw) {
      const input = ensureObject(raw);
      return { contractId: readRequiredString(input, "contractId") };
    },
    async availability(actor) {
      return !isOrderAccessBlocked(actor.role);
    },
    async execute(ctx, input) {
      const actor = ctx.actor;
      try {
        const contract = await getContractDetailForActor(actor, input.contractId);
        return shapeContractDetailForAgent(contract);
      } catch (err) {
        mapDomainErrorToAgentError(err, { resourceLabel: "合同" });
      }
    },
  });

  // ─── contracts.list_templates ────────────────────────────────────────────────
  registerAgentAction({
    key: "contracts.list_templates",
    title: "列出合同模板",
    description: "列出可用合同模板，可按类别过滤（SEQUENCING/EQUIPMENT/NDA/DELIVERY_NOTE/OTHER）。",
    domain: "contracts",
    riskLevel: "safe",
    readOnly: true,
    presentation: { type: "card", narration: "minimal" },
    inputSchema: objectSchema({
      category: stringSchema("按类别过滤：SEQUENCING/EQUIPMENT/NDA/DELIVERY_NOTE/OTHER"),
    }),
    outputSchema: objectSchema({
      templates: arraySchema(
        objectSchema({
          id: stringSchema(),
          name: stringSchema(),
          category: stringSchema(),
          isDefault: booleanSchema(),
          detectedVariables: arraySchema(stringSchema()),
          fileName: stringSchema(),
        }),
      ),
    }),
    parseInput(raw) {
      const input = ensureObject(raw);
      return { category: readOptionalString(input, "category") };
    },
    async availability(actor) {
      return canViewTemplates(actor.role);
    },
    async execute(ctx, input) {
      const actor = ctx.actor;
      try {
        const { templates } = await listContractTemplatesForActor(actor, {
          category: input.category,
        });
        return { templates: templates.map(shapeContractTemplateForAgent) };
      } catch (err) {
        mapDomainErrorToAgentError(err, { resourceLabel: "合同模板" });
      }
    },
  });

  // ─── contracts.list ──────────────────────────────────────────────────────────
  registerAgentAction({
    key: "contracts.list",
    title: "查询合同列表",
    description:
      "分页查询合同列表，可按订单、客户档案、模板类别、状态过滤。只返回调用者对全部覆盖订单均有权限的合同"
      + "（与 GET /api/contracts 同一 canonical 全覆盖口径）。非管理员按可见订单 coverage 交集完整分页，total 准确。"
      + "始终排除生成中断的 PENDING_FILE 记录。",
    domain: "contracts",
    riskLevel: "safe",
    readOnly: true,
    presentation: { type: "none", narration: "normal" },
    inputSchema: objectSchema({
      orderId: stringSchema("按订单 ID 过滤（必须覆盖该订单）"),
      customerId: stringSchema("客户档案 ID（CrmCustomerProfile.id），按覆盖订单所属客户过滤"),
      category: stringSchema("按模板类别过滤：SEQUENCING/EQUIPMENT/NDA/DELIVERY_NOTE/OTHER"),
      status: stringSchema("按合同状态过滤，如 GENERATED"),
      page: integerSchema("页码，默认 1"),
      pageSize: integerSchema("每页条数，默认 20，最大 50"),
    }),
    outputSchema: objectSchema({
      contracts: arraySchema(
        objectSchema({
          id: stringSchema(),
          contractNo: stringSchema(),
          status: stringSchema(),
          category: stringSchema(),
          totalAmountCents: integerSchema("合同金额（分）"),
          buyerOrgName: stringSchema(),
          createdAt: stringSchema(),
          coveredOrderCount: integerSchema(),
        }),
      ),
      total: integerSchema(),
      page: integerSchema(),
    }),
    parseInput(raw) {
      const input = ensureObject(raw);
      return {
        orderId: readOptionalString(input, "orderId"),
        customerId: readOptionalString(input, "customerId"),
        category: readOptionalString(input, "category"),
        status: readOptionalString(input, "status"),
        page: readOptionalInteger(input, "page", { min: 1 }) ?? 1,
        pageSize: clampLimit(readOptionalInteger(input, "pageSize", { min: 1, max: 50 }), 20, 50),
      };
    },
    async availability(actor) {
      return !isOrderAccessBlocked(actor.role);
    },
    async execute(ctx, input) {
      const actor = ctx.actor;
      try {
        const result = await queryContractsForActor(actor, input);
        return {
          contracts: result.contracts.map(shapeContractListForAgent),
          total: result.total,
          page: result.page,
        };
      } catch (err) {
        mapDomainErrorToAgentError(err, { resourceLabel: "合同" });
      }
    },
  });
}

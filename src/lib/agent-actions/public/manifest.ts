/**
 * Phase A: versioned public-tool manifest。
 *
 * 设计文档 §4 / §6 / §7：public tool 是 internal action 之上的意图面，
 * 只做改名、减参、按状态暴露、串已有 action。本 manifest 是 public → internal
 * 映射 + kind + exposure + parameter provenance + test owner 的权威清单。
 *
 * 关键不变量（Phase A 守护）：
 *  - 每个 entry 的 `internalActions` 必须是已登记 internal action key（Phase B 起
 *    逐个验证存在；Phase A 允许尚未注册的新 action 以字符串登记占位）。
 *  - `implemented` 静态标注 facade 是否已实现（P2-2：不再由 facade 注册时翻转）。
 *    selector 对 `implemented:false` 硬过滤，绝不注入模型。当前 28 个 public tool 全部
 *    implemented:true；若有真正未实现的 tool 保持 false 并在交接说明里标注。
 *  - public input schema 禁止出现：proposalId、idempotencyKey、expectedSha256、
 *    expectedVersion、generationIntentId、sourceAgentProposalId、原始数据库 ID、
 *    display-only flag（见 §6）。manifest 构建后由测试断言。
 *
 * 本模块零 Prisma。
 */
import type { JsonSchemaObject } from "../types";

export const MANIFEST_VERSION = 1;

export type PublicToolKind =
  | "discovery"
  | "context"
  | "propose"
  | "preview"
  | "workflow"
  | "preview_then_confirm_generate";

/** 角色矩阵（与 role-guards 对齐）。空数组 = 全角色可用（但仍受 availability 二次过滤）。 */
export type PublicToolRole = "ADMIN" | "USER" | "REGIONAL_MANAGER" | "REPRESENTATIVE";

export type ParamProvenance =
  | "user-explicit"
  | "constrained"
  | "prior-ref"
  | "server-derived"
  | "verified-context"
  | "presentation";

export interface PublicToolManifestEntry {
  /** public tool 名（模型可见）。snake_case，与 internal action key 命名空间隔离。 */
  publicTool: string;
  /** 人话意图描述（模型可见）。 */
  description: string;
  kind: PublicToolKind;
  /** 默认 exposure；selector 可按状态覆盖（workflow 激活时只给 nextAction）。 */
  exposure: "primary" | "contextual" | "workflow_step";
  /**
   * facade handler 是否已实现。P2-2：静态声明，不再由 facade 注册时翻转。
   * false 时 selector 硬过滤（绝不注入模型）。
   */
  implemented: boolean;
  /** 该 public tool 串接的 internal action key（按调用序）。 */
  internalActions: string[];
  /** public input 的 JSON schema（模型可见）。 */
  publicInput: JsonSchemaObject;
  /** 每个公开参数的来源分类（§3 provenance audit）。 */
  paramProvenance: Record<string, ParamProvenance>;
  /** 允许调用的角色。空数组 = 所有 agent 可见角色。 */
  roles: PublicToolRole[];
}

// ── schema helpers（与 schemas.ts 风格一致，但本文件自包含避免循环依赖） ──

const idField = (entity: string): JsonSchemaObject => ({
  type: "string",
  description: `${entity} 的真实 id（来自上一步 find_* 结果）。授权由 canonical service scope gate 校验。`,
});

// ── Always-available discovery / context（§4.1） ──

const FIND_CUSTOMERS: PublicToolManifestEntry = {
  publicTool: "find_customers",
  description: "搜索/匹配客户。返回候选列表；歧义时给 options，不让模型猜 profileId。",
  kind: "discovery",
  exposure: "primary",
  implemented: true,
  internalActions: ["crm.search_customers", "crm.resolve_customer_name", "crm.search_customers_by_pinyin"],
  publicInput: {
    type: "object",
    properties: {
      query: { type: "string", description: "搜索词（名称/拼音/电话/组织）" },
      stage: { type: "string", enum: ["PROSPECT", "ACTIVE", "DORMANT", "LOST"], description: "可选阶段筛选" },
    },
    additionalProperties: false,
    required: ["query"],
  },
  paramProvenance: { query: "user-explicit", stage: "constrained" },
  roles: [],
};

const GET_CUSTOMER: PublicToolManifestEntry = {
  publicTool: "get_customer",
  description: "加载已选客户的详情上下文。",
  kind: "context",
  exposure: "primary",
  implemented: true,
  internalActions: ["crm.get_customer_context"],
  publicInput: {
    type: "object",
    properties: { customerId: idField("客户") },
    additionalProperties: false,
    required: ["customerId"],
  },
  paramProvenance: { customerId: "prior-ref" },
  roles: [],
};

const FIND_PROJECTS: PublicToolManifestEntry = {
  publicTool: "find_projects",
  description: "搜索/浏览项目。空 query = 可见最近项目。",
  kind: "discovery",
  exposure: "primary",
  implemented: true,
  internalActions: ["projects.search"],
  publicInput: {
    type: "object",
    properties: {
      query: { type: "string", description: "可选搜索词" },
      status: { type: "string", description: "可选状态 enum" },
    },
    additionalProperties: false,
  },
  paramProvenance: { query: "user-explicit", status: "constrained" },
  roles: [],
};

const GET_PROJECT: PublicToolManifestEntry = {
  publicTool: "get_project",
  description: "加载已选项目的摘要。",
  kind: "context",
  exposure: "primary",
  implemented: true,
  internalActions: ["projects.get_summary"],
  publicInput: {
    type: "object",
    properties: { projectId: idField("项目") },
    additionalProperties: false,
    required: ["projectId"],
  },
  paramProvenance: { projectId: "prior-ref" },
  roles: [],
};

const FIND_ORDERS: PublicToolManifestEntry = {
  publicTool: "find_orders",
  description:
    "统一找单工具。financialView 表达人话筛选：pending_receipt=待回款，settled=已结清，any=不按回款筛。"
    + " REPRESENTATIVE 不接收 financialView；REGIONAL_MANAGER 可用下属 scope。",
  kind: "discovery",
  exposure: "primary",
  implemented: true,
  internalActions: ["orders.find_with_financial_view", "orders.search", "orders.list_pending_receipts"],
  publicInput: {
    type: "object",
    properties: {
      query: { type: "string", description: "可选搜索词" },
      status: { type: "string", description: "业务状态 enum（与回款正交）" },
      financialView: {
        type: "string",
        enum: ["any", "pending_receipt", "settled"],
        description: "回款视图筛选，默认 any。REP 角色不可用。",
      },
    },
    additionalProperties: false,
  },
  paramProvenance: { query: "user-explicit", status: "constrained", financialView: "constrained" },
  roles: [],
};

const GET_ORDER: PublicToolManifestEntry = {
  publicTool: "get_order",
  description:
    "加载已选订单详情（内部员工/RM 含 compact finance；REP 为受限投影，仅粗粒度收款状态）。",
  kind: "context",
  exposure: "primary",
  implemented: true,
  internalActions: ["orders.get_detail"],
  publicInput: {
    type: "object",
    properties: { orderId: idField("订单") },
    additionalProperties: false,
    required: ["orderId"],
  },
  paramProvenance: { orderId: "prior-ref" },
  roles: [],
};

const FIND_TICKETS: PublicToolManifestEntry = {
  publicTool: "find_tickets",
  description: "列出某项目的工单。必须先选项目。",
  kind: "discovery",
  exposure: "primary",
  implemented: true,
  internalActions: ["tickets.list"],
  publicInput: {
    type: "object",
    properties: {
      projectId: idField("项目"),
      status: { type: "string", description: "可选状态 enum" },
    },
    additionalProperties: false,
    required: ["projectId"],
  },
  paramProvenance: { projectId: "prior-ref", status: "constrained" },
  roles: [],
};

const FIND_CONTRACTS: PublicToolManifestEntry = {
  publicTool: "find_contracts",
  description: "搜索合同。代表为只读查询。",
  kind: "discovery",
  exposure: "primary",
  implemented: true,
  internalActions: ["contracts.list"],
  publicInput: {
    type: "object",
    properties: {
      orderId: idField("订单"),
      customerId: idField("客户"),
      status: { type: "string", description: "可选状态 enum" },
    },
    additionalProperties: false,
  },
  paramProvenance: { orderId: "prior-ref", customerId: "prior-ref", status: "constrained" },
  roles: [],
};

const GET_CONTRACT: PublicToolManifestEntry = {
  publicTool: "get_contract",
  description: "加载合同详情。full-coverage fail-closed；代表只读。",
  kind: "context",
  exposure: "primary",
  implemented: true,
  internalActions: ["contracts.get_detail"],
  publicInput: {
    type: "object",
    properties: { contractId: idField("合同") },
    additionalProperties: false,
    required: ["contractId"],
  },
  paramProvenance: { contractId: "prior-ref" },
  roles: [],
};

const GET_INVOICE: PublicToolManifestEntry = {
  publicTool: "get_invoice",
  description: "加载发票详情。对 ADMIN/USER/REGIONAL_MANAGER 在 canonical finance scope 内可用；REPRESENTATIVE 不可用。",
  kind: "context",
  exposure: "primary",
  implemented: true,
  internalActions: ["finance.get_invoice_detail"],
  publicInput: {
    type: "object",
    properties: { invoiceId: idField("发票") },
    additionalProperties: false,
    required: ["invoiceId"],
  },
  paramProvenance: { invoiceId: "prior-ref" },
  roles: ["ADMIN", "USER", "REGIONAL_MANAGER"],
};

const LIST_CONTRACT_TEMPLATES: PublicToolManifestEntry = {
  publicTool: "list_contract_templates",
  description: "列出可选合同模板（用户要换模板时返回 options）。",
  kind: "discovery",
  exposure: "contextual",
  implemented: true,
  internalActions: ["contracts.list_templates"],
  publicInput: {
    type: "object",
    properties: { category: { type: "string", description: "可选分类" } },
    additionalProperties: false,
  },
  paramProvenance: { category: "constrained" },
  roles: ["ADMIN", "USER"],
};

// ── Propose / preview（§4.2） ──

const PREPARE_ORDER: PublicToolManifestEntry = {
  publicTool: "prepare_order",
  description:
    "为指定客户创建 server-owned 订单草稿（经 orders.prepare_draft）。返回 orderDraftId 与 GenUI 选项（产品/项目类型/数量/单价）。"
    + " 不接收 title/remark/JSON lines。标题服务端生成。",
  kind: "preview",
  exposure: "primary",
  implemented: true,
  internalActions: ["orders.prepare_draft"],
  publicInput: {
    type: "object",
    properties: { customerId: idField("客户") },
    additionalProperties: false,
    required: ["customerId"],
  },
  paramProvenance: { customerId: "prior-ref" },
  roles: ["ADMIN", "USER"],
};

const PROPOSE_ORDER: PublicToolManifestEntry = {
  publicTool: "propose_order",
  description: "基于服务端草稿正式提案创建订单。确认后才落单。模型不可重传行字段。",
  kind: "propose",
  exposure: "primary",
  implemented: true,
  internalActions: ["orders.get_draft", "orders.create_from_draft"],
  publicInput: {
    type: "object",
    properties: { orderDraftId: idField("订单草稿") },
    additionalProperties: false,
    required: ["orderDraftId"],
  },
  paramProvenance: { orderDraftId: "prior-ref" },
  roles: ["ADMIN", "USER"],
};

const PROPOSE_PROJECT: PublicToolManifestEntry = {
  publicTool: "propose_project",
  description: "提案创建项目。可选用户明示预算。",
  kind: "propose",
  exposure: "primary",
  implemented: true,
  internalActions: ["projects.create"],
  publicInput: {
    type: "object",
    properties: {
      name: { type: "string", description: "项目名称" },
      budgetAmountYuan: { type: "number", description: "可选预算（元，用户明示时）" },
    },
    additionalProperties: false,
    required: ["name"],
  },
  paramProvenance: { name: "user-explicit", budgetAmountYuan: "user-explicit" },
  roles: ["ADMIN", "USER"],
};

const PROPOSE_TICKET: PublicToolManifestEntry = {
  publicTool: "propose_ticket",
  description: "提案创建工单。",
  kind: "propose",
  exposure: "primary",
  implemented: true,
  internalActions: ["tickets.create_from_text"],
  publicInput: {
    type: "object",
    properties: {
      projectId: idField("项目"),
      text: { type: "string", description: "工单内容" },
    },
    additionalProperties: false,
    required: ["projectId", "text"],
  },
  paramProvenance: { projectId: "prior-ref", text: "user-explicit" },
  roles: ["ADMIN", "USER"],
};

const PROPOSE_TICKET_REPLY: PublicToolManifestEntry = {
  publicTool: "propose_ticket_reply",
  description: "提案回复工单。",
  kind: "propose",
  exposure: "primary",
  implemented: true,
  internalActions: ["tickets.reply"],
  publicInput: {
    type: "object",
    properties: {
      ticketId: idField("工单"),
      content: { type: "string", description: "回复正文" },
    },
    additionalProperties: false,
    required: ["ticketId", "content"],
  },
  paramProvenance: { ticketId: "prior-ref", content: "user-explicit" },
  roles: ["ADMIN", "USER"],
};

const PROPOSE_FOLLOW_UP: PublicToolManifestEntry = {
  publicTool: "propose_follow_up",
  description:
    "提案创建跟进任务。未传 dueAt 时服务端默认下一个有效周五 18:00（Asia/Shanghai）；"
    + "周五 00:00 起默认下周五。",
  kind: "propose",
  exposure: "primary",
  implemented: true,
  internalActions: ["crm.create_followup_task"],
  publicInput: {
    type: "object",
    properties: {
      customerId: idField("客户"),
      title: { type: "string", description: "任务标题" },
      taskType: { type: "string", enum: ["CONTACT", "VISIT", "OTHER"], description: "可选任务类型" },
      dueAt: { type: "string", description: "可选截止时间（用户明示时）" },
    },
    additionalProperties: false,
    required: ["customerId", "title"],
  },
  paramProvenance: { customerId: "prior-ref", title: "user-explicit", taskType: "constrained", dueAt: "user-explicit" },
  roles: ["ADMIN", "USER"],
};

const PROPOSE_VISIT_CHECKIN: PublicToolManifestEntry = {
  publicTool: "propose_visit_checkin",
  description:
    "提案拜访签到。prepare_visit_checkin 在服务端落 DRAFT 签到 intent（checkinId）；"
    + "定位由浏览器在用户点击保存时注入，create_visit_checkin 一次性消费该 checkinId。模型不填坐标/精度。",
  kind: "propose",
  exposure: "primary",
  implemented: true,
  internalActions: ["crm.prepare_visit_checkin", "crm.create_visit_checkin"],
  publicInput: {
    type: "object",
    properties: { customerId: idField("客户") },
    additionalProperties: false,
    required: ["customerId"],
  },
  paramProvenance: { customerId: "prior-ref" },
  roles: ["ADMIN", "USER"],
};

const PROPOSE_INVOICE: PublicToolManifestEntry = {
  publicTool: "propose_invoice",
  description:
    "提案开票。订单路径走 prepare_invoice_draft（confirm action）；项目路径走 plan_*（safe 只读）→ "
    + "submit_*（confirm）产 PENDING proposal。空计划/字段缺失返回 needs_input；歧义买方/卖方/coverage 返回 needs_selection。"
    + " 多张可执行计划返回 needs_selection + plans（含各自 planKey），用户选定后用 projectId + planKey 重新调用本工具。"
    + " 禁止静默选择。",
  kind: "propose",
  exposure: "primary",
  implemented: true,
  internalActions: ["finance.prepare_invoice_draft", "finance.plan_project_invoice_requests", "finance.submit_invoice_request"],
  publicInput: {
    type: "object",
    properties: {
      orderId: idField("订单"),
      projectId: idField("项目"),
      amountYuan: { type: "number", description: "可选金额（用户明示时）" },
      invoiceType: { type: "string", description: "可选票种 enum" },
      planKey: {
        type: "string",
        description:
          "项目路径下，当返回多张可执行计划（needs_selection）时，用户选定其中一张后必须传入该张的 planKey "
          + "（与 projectId 一起重新调用本工具）以提交该张开票申请。planKey 来自上次返回的 plans[].planKey。",
      },
    },
    additionalProperties: false,
  },
  paramProvenance: {
    orderId: "prior-ref",
    projectId: "prior-ref",
    amountYuan: "user-explicit",
    invoiceType: "constrained",
    planKey: "prior-ref",
  },
  roles: ["ADMIN", "USER"],
};

const PROPOSE_RECEIPT: PublicToolManifestEntry = {
  publicTool: "propose_receipt",
  description:
    "回款提案：先 match_payment；精确唯一匹配 → 自动以该候选建 create_receipt proposal；"
    + "多候选 → needs_selection + 候选发票列表，用户选定后传 selectedOptionId；无候选 → needs_input。"
    + " selectedOptionId 为 match 候选发票 id，service 重跑确定性 match 校验归属后推导 allocations（禁止手写 allocations）。",
  kind: "propose",
  exposure: "primary",
  implemented: true,
  internalActions: ["finance.match_payment", "finance.create_receipt"],
  publicInput: {
    type: "object",
    properties: {
      organizationId: idField("组织"),
      amountYuan: { type: "number", description: "回款金额（元，用户明示）" },
      selectedOptionId: { type: "string", description: "match 候选发票 id（多候选时用户选定后必填；精确唯一匹配时由 facade 自动填充）" },
      receivedAt: { type: "string", description: "可选到账时间（用户明示时）" },
    },
    additionalProperties: false,
    required: ["organizationId", "amountYuan"],
  },
  paramProvenance: {
    organizationId: "prior-ref",
    amountYuan: "user-explicit",
    selectedOptionId: "prior-ref",
    receivedAt: "user-explicit",
  },
  roles: ["ADMIN", "USER"],
};

const PREPARE_CONTRACT: PublicToolManifestEntry = {
  publicTool: "prepare_contract",
  description:
    "合同准备（对外一工具；内：prepare_draft 出预览 + 解析默认模板/卖方，再用 generationIntentId 调 generate 产 PENDING proposal）。"
    + " ordered orderIds；模板/卖方仅来自 options 或默认。销售角色不暴露。",
  kind: "preview_then_confirm_generate",
  exposure: "primary",
  implemented: true,
  internalActions: ["contracts.prepare_draft", "contracts.generate"],
  publicInput: {
    type: "object",
    properties: {
      orderIds: { type: "array", items: { type: "string" }, description: "ordered order ids（来自 find_orders 结果）" },
      templateOptionId: { type: "string", description: "可选模板 option（来自 options）" },
      sellerOptionId: { type: "string", description: "可选卖方 option" },
    },
    additionalProperties: false,
    required: ["orderIds"],
  },
  paramProvenance: {
    orderIds: "prior-ref",
    templateOptionId: "prior-ref",
    sellerOptionId: "prior-ref",
  },
  roles: ["ADMIN", "USER"],
};

const PROPOSE_INVOICE_REGISTRATION: PublicToolManifestEntry = {
  publicTool: "propose_invoice_registration",
  description:
    "发票登记提案：已校验附件（私有 staging）+ 候选 option。"
    + "hash/version 由服务端 verified 上下文注入（public input 禁带，经 finance.get_invoice_staging_context 解析）。"
    + "analyze 唯一匹配（EXACT）时自动产 register 确认提案；多候选/无匹配返回 needs_selection/needs_input。",
  kind: "propose",
  exposure: "contextual",
  implemented: true,
  internalActions: ["finance.get_invoice_staging_context", "finance.analyze_invoice_file", "finance.register_issued_invoice"],
  publicInput: {
    type: "object",
    properties: {
      attachmentId: idField("附件"),
      selectedOptionId: { type: "string", description: "多候选时用户选定的候选 option id" },
    },
    additionalProperties: false,
    required: ["attachmentId"],
  },
  paramProvenance: {
    attachmentId: "verified-context",
    selectedOptionId: "prior-ref",
  },
  roles: ["ADMIN", "USER"],
};

// ── contextual 写 ──

const LINK_ORDER_PROJECT: PublicToolManifestEntry = {
  publicTool: "link_order_project",
  description: "关联订单与项目。需 orderId+projectId，且技术负责人必须同时匹配。",
  kind: "propose",
  exposure: "contextual",
  implemented: true,
  internalActions: ["orders.link_to_project"],
  publicInput: {
    type: "object",
    properties: {
      orderId: idField("订单"),
      projectId: idField("项目"),
    },
    additionalProperties: false,
    required: ["orderId", "projectId"],
  },
  paramProvenance: { orderId: "prior-ref", projectId: "prior-ref" },
  roles: ["ADMIN", "USER"],
};

// ── workflow（§4.3） ──

const START_ORDER_IMPORT: PublicToolManifestEntry = {
  publicTool: "start_order_import",
  description: "启动订单导入工作流。verified upload context only。",
  kind: "workflow",
  exposure: "workflow_step",
  implemented: true,
  internalActions: ["orders.analyze_import_file", "orders.get_import_staging_context"],
  publicInput: {
    type: "object",
    properties: { stagingFileId: idField("导入文件附件") },
    additionalProperties: false,
    required: ["stagingFileId"],
  },
  paramProvenance: { stagingFileId: "verified-context" },
  roles: ["ADMIN", "USER"],
};

const OPERATE_ORDER_IMPORT: PublicToolManifestEntry = {
  publicTool: "operate_order_import",
  description:
    "推进订单导入工作流。sessionId + operation（服务端 offered enum） + 仅该步所需决策。"
    + "operation 由上一步 nextAction 提供：apply_column_mapping / get_row / update_row_draft / commit_row / skip_row / resume。"
    + "commit_row 与 skip_row 走 confirm proposal（确认后才落单/跳过）。",
  kind: "workflow",
  exposure: "workflow_step",
  implemented: true,
  internalActions: [
    "orders.apply_import_column_mapping",
    "orders.get_import_row",
    "orders.update_import_row_draft",
    "orders.import_order_row",
    "orders.skip_import_row",
    "orders.resume_import_session",
    "orders.get_import_staging_context",
  ],
  publicInput: {
    type: "object",
    properties: {
      sessionId: idField("导入会话"),
      operation: {
        type: "string",
        enum: [
          "apply_column_mapping",
          "get_row",
          "update_row_draft",
          "commit_row",
          "skip_row",
          "resume",
        ],
        description: "由上一步 nextAction 提供的操作类型",
      },
      rowId: { type: "string", description: "行 id（get_row / update_row_draft / commit_row / skip_row 必填）" },
      selectedOptionId: {
        type: "string",
        description: "保留位（mapping/row 选项 id），当前未在 facade 中使用",
      },
      columnMapping: {
        type: "object",
        description:
          "apply_column_mapping 必填：source 列名 → target 字段名（target 来自 analyze 返回的 allowedTargets 白名单）",
        additionalProperties: { type: "string" },
      },
      rowPatch: {
        type: "object",
        description: "update_row_draft 必填：字段名 → 字符串值（白名单由服务端定义）",
        additionalProperties: { type: "string" },
      },
    },
    additionalProperties: false,
    required: ["sessionId", "operation"],
  },
  paramProvenance: {
    sessionId: "prior-ref",
    operation: "constrained",
    rowId: "prior-ref",
    selectedOptionId: "prior-ref",
    columnMapping: "user-explicit",
    rowPatch: "user-explicit",
  },
  roles: ["ADMIN", "USER"],
};

const START_BANK_FLOW: PublicToolManifestEntry = {
  publicTool: "start_bank_flow",
  description: "启动银行流水工作流。verified upload context only。",
  kind: "workflow",
  exposure: "workflow_step",
  implemented: true,
  internalActions: ["finance.analyze_bank_flow_file"],
  publicInput: {
    type: "object",
    properties: { stagingFileId: idField("银行流水文件附件") },
    additionalProperties: false,
    required: ["stagingFileId"],
  },
  paramProvenance: { stagingFileId: "verified-context" },
  roles: ["ADMIN", "USER"],
};

const OPERATE_BANK_FLOW: PublicToolManifestEntry = {
  publicTool: "operate_bank_flow",
  description:
    "推进银行流水工作流。workspaceId + operation（服务端 offered enum） + 仅该步所需决策。"
    + "operation 由上一步 nextAction 提供：apply_bank_flow_mapping / match_bank_flow_rows / get_bank_flow_row / "
    + "update_bank_flow_selection / reopen_bank_flow_rows / ocr_bank_flow_receipts / confirm_bank_flow_batch。"
    + "confirm_bank_flow_batch 走 confirm proposal（确认后才核销建回款）。",
  kind: "workflow",
  exposure: "workflow_step",
  implemented: true,
  internalActions: [
    "finance.apply_bank_flow_mapping",
    "finance.match_bank_flow_rows",
    "finance.get_bank_flow_row",
    "finance.update_bank_flow_selection",
    "finance.reopen_bank_flow_rows",
    "finance.ocr_bank_flow_receipts",
    "finance.confirm_bank_flow_batch",
    "finance.get_bank_flow_workspace_state",
  ],
  publicInput: {
    type: "object",
    properties: {
      workspaceId: idField("流水工作区"),
      operation: {
        type: "string",
        enum: [
          "apply_bank_flow_mapping",
          "match_bank_flow_rows",
          "get_bank_flow_row",
          "update_bank_flow_selection",
          "reopen_bank_flow_rows",
          "ocr_bank_flow_receipts",
          "confirm_bank_flow_batch",
        ],
        description: "由上一步 nextAction 提供的操作类型",
      },
      rowIndex: { type: "integer", minimum: 0, description: "行下标（get_row / update_selection 必填）" },
      selectedOptionId: {
        type: "string",
        description: "update_bank_flow_selection 时选中的组织/组合 option id（约定为 organizationId）",
      },
      combinationIndex: {
        type: "integer",
        minimum: 0,
        description: "update_bank_flow_selection 时选中的发票组合下标",
      },
      skip: { type: "boolean", description: "update_bank_flow_selection 时是否跳过该行" },
      rowIndices: {
        type: "array",
        items: { type: "integer", minimum: 0 },
        description: "reopen_bank_flow_rows 时要重开的行下标集合",
      },
      stagingFileIds: {
        type: "array",
        items: { type: "string" },
        description: "ocr_bank_flow_receipts 时的回单 staging 文件 id 集合",
      },
      mapping: {
        type: "object",
        description:
          "apply_bank_flow_mapping 必填：列映射修正。payerName/amount 必填，date/remark/payerAccount 可选。",
        properties: {
          payerName: { type: "string" },
          amount: { type: "string" },
          date: { type: "string" },
          remark: { type: "string" },
          payerAccount: { type: "string" },
        },
        required: ["payerName", "amount"],
        additionalProperties: false,
      },
    },
    additionalProperties: false,
    required: ["workspaceId", "operation"],
  },
  paramProvenance: {
    workspaceId: "prior-ref",
    operation: "constrained",
    rowIndex: "constrained",
    selectedOptionId: "prior-ref",
    combinationIndex: "constrained",
    skip: "user-explicit",
    rowIndices: "constrained",
    stagingFileIds: "prior-ref",
    mapping: "user-explicit",
  },
  roles: ["ADMIN", "USER"],
};

const INSPECT_ATTACHMENT: PublicToolManifestEntry = {
  publicTool: "inspect_attachment",
  description: "附件检查/采纳/分析。verified attachment context；hash/version 注入。",
  kind: "workflow",
  exposure: "workflow_step",
  implemented: true,
  internalActions: ["agent.inspect_attachments"],
  publicInput: {
    type: "object",
    properties: { attachmentId: idField("附件") },
    additionalProperties: false,
    required: ["attachmentId"],
  },
  paramProvenance: { attachmentId: "verified-context" },
  roles: ["ADMIN", "USER"],
};

/**
 * 全量 public manifest。设计目标 ~25-30 工具，但单轮注入 ≤15。
 * P2-2：全部 28 个 public tool implemented:true（静态声明）。
 * assertManifestFacadeParity 在服务启动时校验 manifest↔handler↔action registry 一致。
 */
export const PUBLIC_TOOL_MANIFEST: PublicToolManifestEntry[] = [
  FIND_CUSTOMERS,
  GET_CUSTOMER,
  FIND_PROJECTS,
  GET_PROJECT,
  FIND_ORDERS,
  GET_ORDER,
  FIND_TICKETS,
  FIND_CONTRACTS,
  GET_CONTRACT,
  GET_INVOICE,
  LIST_CONTRACT_TEMPLATES,
  PREPARE_ORDER,
  PROPOSE_ORDER,
  PROPOSE_PROJECT,
  PROPOSE_TICKET,
  PROPOSE_TICKET_REPLY,
  PROPOSE_FOLLOW_UP,
  PROPOSE_VISIT_CHECKIN,
  PROPOSE_INVOICE,
  PROPOSE_RECEIPT,
  PREPARE_CONTRACT,
  PROPOSE_INVOICE_REGISTRATION,
  LINK_ORDER_PROJECT,
  START_ORDER_IMPORT,
  OPERATE_ORDER_IMPORT,
  START_BANK_FLOW,
  OPERATE_BANK_FLOW,
  INSPECT_ATTACHMENT,
];

const MANIFEST_BY_KEY: ReadonlyMap<string, PublicToolManifestEntry> = new Map(
  PUBLIC_TOOL_MANIFEST.map((entry) => [entry.publicTool, entry]),
);

export function getPublicToolManifestEntry(publicToolKey: string): PublicToolManifestEntry | undefined {
  return MANIFEST_BY_KEY.get(publicToolKey);
}

/**
 * public input schema 禁止出现的字段（§6）。manifest 构建后由测试断言无违规。
 */
export const FORBIDDEN_PUBLIC_INPUT_FIELDS = new Set([
  "proposalId",
  "idempotencyKey",
  "expectedSha256",
  "expectedVersion",
  "generationIntentId",
  "sourceAgentProposalId",
  "rawId",
  "dbId",
]);

/**
 * 校验：manifest 中所有 publicInput 的 properties 都不含禁用字段名。
 * 返回违规列表（空 = 通过）。
 */
export function findForbiddenPublicInputFields(): Array<{ publicTool: string; field: string }> {
  const violations: Array<{ publicTool: string; field: string }> = [];
  for (const entry of PUBLIC_TOOL_MANIFEST) {
    const props = entry.publicInput.properties;
    if (!props || typeof props !== "object") continue;
    for (const field of Object.keys(props)) {
      if (FORBIDDEN_PUBLIC_INPUT_FIELDS.has(field)) {
        violations.push({ publicTool: entry.publicTool, field });
      }
    }
  }
  return violations;
}

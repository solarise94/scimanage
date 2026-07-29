/**
 * GenUI normalization adapter.
 *
 * Maps an `AgentUiSource` (from either runtime) to an `AgentUiDescriptor`
 * deterministically.  The model and sidecar never choose a UI type - only the
 * `actionKey` determines which card renders.
 *
 * @see docs/agent-mobile-crm-genui-functional-design-2026-07-14.md §6.2-6.3
 */

import type { AgentUiDescriptor, AgentUiSource, AgentUiType, AgentUiState } from "./agent-ui-types";
import type { AgentProposal } from "./chat-panel";
import { validateAgentUiProps } from "./agent-ui-props-schemas";

/**
 * Unwrap Pi runtime tool output.
 *
 * Pi runtime wraps tool results in:
 *   { content: [...], details: { ok, actionKey, mode, result | proposal | modelFacing } }
 *
 * This function extracts the inner payload so the adapter receives a shape the
 * card can consume:
 *   - mode === "result"        → details.result
 *   - mode === "proposal"      → details.proposal (+ details.result fallback)
 *   - mode === "preview"       → details.modelFacing（public tool prepare_* 产出的
 *                                GenUI 编辑数据，如 prepare_order 的 orderDraftId/
 *                                productOptions/patchEndpoint）
 *   - mode === "needs_input"   → details.modelFacing（同上，多含 needsSelection/error）
 *
 * public facade（src/lib/agent-actions/public/facades/*）返回 { mode, modelFacing }，
 * runtime execute-public 把它包进 details.modelFacing；旧 internal action 直出 result。
 *
 * For legacy or already-unwrapped outputs, returns them as-is.
 */
export function unwrapPiToolOutput(rawOutput: unknown): {
  output: unknown;
  proposal?: AgentProposal;
} {
  if (!rawOutput || typeof rawOutput !== "object") {
    return { output: rawOutput };
  }

  const result = rawOutput as Record<string, unknown>;

  // Check if this is a Pi-wrapped result (has `details` key)
  if (!("details" in result) || !result.details || typeof result.details !== "object") {
    // Not Pi-wrapped - return as-is (legacy or pre-unwrapped)
    return { output: rawOutput };
  }

  const details = result.details as Record<string, unknown>;

  // Extract proposal if mode is "proposal".
  // public propose_* facade 把 proposal 放进 modelFacing.proposal（非顶层 details.proposal），
  // 两种位置都识别。
  let proposal: AgentProposal | undefined;
  if (details.mode === "proposal") {
    if (details.proposal && typeof details.proposal === "object") {
      proposal = details.proposal as AgentProposal;
    } else {
      const mf = details.modelFacing as Record<string, unknown> | undefined;
      if (mf && mf.proposal && typeof mf.proposal === "object") {
        proposal = mf.proposal as AgentProposal;
      }
    }
  }

  // Extract the actual output consumed by extractProps.
  // - result 模式：details.result。
  // - preview / needs_input 模式（public tool prepare_*）：details.modelFacing，
  //   内含 orderDraftId/productOptions/patchEndpoint 等 GenUI 编辑字段。
  // - proposal 模式：优先 modelFacing（含 proposal + 附加上下文），否则 details.result。
  let output: unknown;
  if (details.mode === "result") {
    output = details.result;
  } else if (details.mode === "preview" || details.mode === "needs_input") {
    output = details.modelFacing ?? details.result;
  } else {
    // proposal 或未知 mode：优先 modelFacing，回退 result。
    output = details.modelFacing ?? details.result ?? undefined;
  }

  return { output, proposal };
}

/**
 * Normalize a tool output + optional proposal into an AgentUiSource.
 * Handles both Pi-wrapped and legacy/unwrapped outputs.
 */
export function buildAgentUiSource(params: {
  actionKey: string;
  input: unknown;
  output?: unknown;
  proposal?: AgentProposal;
  status: AgentUiSource["status"];
}): AgentUiSource {
  const { output: unwrappedOutput, proposal: piProposal } = unwrapPiToolOutput(params.output);

  return {
    actionKey: params.actionKey,
    input: params.input,
    output: unwrappedOutput,
    // Prefer the explicitly passed proposal (from inline proposal rendering),
    // fall back to the one extracted from Pi tool output.
    proposal: params.proposal ?? piProposal,
    status: params.status,
  };
}

/**
 * Deterministic actionKey -> UI type mapping.
 * Unregistered actionKeys return null (fallback to generic tool status card).
 */
const ACTION_UI_MAP: Record<string, AgentUiType> = {
  "crm.search_customers": "crm.customer-list",
  // Voice/fuzzy name resolution. Special-cased below by resolution/candidate
  // count: AMBIGUOUS with ≥2 candidates renders the choice card; UNIQUE and
  // NO_MATCH fall through to a generic tool status row (FallbackToolCard) so
  // the model continues (UNIQUE → get_customer_context, NO_MATCH → explain).
  "crm.resolve_customer_name": "crm.customer-choice",
  // Pinyin/homophone recall (docs §6 / §8.1): special-cased below by `resolution`.
  // AMBIGUOUS with candidates → choice card; UNIQUE / NO_MATCH → null (server
  // follow-up emits the detail card on UNIQUE; fallback row on NO_MATCH).
  "crm.search_customers_by_pinyin": "crm.customer-choice",
  // Single-profile snapshot — not a list (list card would render empty white shell).
  "crm.get_customer_context": "crm.customer-detail",
  "crm.prepare_visit_checkin": "crm.checkin-draft",
  "crm.create_visit_checkin": "crm.checkin-draft",
  "crm.create_interaction": "crm.interaction-draft",
  "crm.request_organization_binding": "crm.organization-request-draft",
  "crm.list_my_organizations": "crm.organization-list",
  "crm.submit_customer_application": "crm.customer-application-draft",
  "crm.list_my_customer_applications": "crm.customer-application-list",
  "crm.create_followup_task": "crm.followup-draft",
  // ─── Orders / Projects / Tickets / Finance (第二轮升级) ─────────────────────
  "orders.create": "orders.create-draft",
  // public tool prepare_order（preview）：dynamic bundle 路径下 item.toolName 是
  // public tool key（prepare_order），渲染为可编辑的订单草稿卡（选产品/项目类型/数量/
  // 单价 → PATCH → propose_order）。与 internal orders.prepare_draft 区分。
  "prepare_order": "orders.draft-edit",
  // public tool propose_order（proposal）：草稿确认后生成的订单创建提案，复用现有
  // 订单创建确认卡（消费 proposal.input.lines/totalAmount 等）。
  "propose_order": "orders.create-draft",
  "orders.get_detail": "orders.detail",
  "orders.list_pending_receipts": "orders.pending-receipts",
  "orders.get_finance_snapshot": "orders.finance-snapshot",
  "orders.analyze_import_file": "orders.analyze-import-file",
  "orders.apply_import_column_mapping": "orders.analyze-import-file",
  "orders.get_import_row": "orders.import-row",
  "orders.import_order_row": "orders.import-row",
  "orders.skip_import_row": "orders.import-row",
  "orders.resume_import_session": "orders.import-row",
  "orders.update_import_row_draft": "orders.import-row",
  "projects.create": "projects.create-draft",
  "tickets.create_from_text": "tickets.create-draft",
  "tickets.update_status": "tickets.status-update",
  "tickets.reply": "tickets.reply-draft",
  "finance.match_payment": "finance.match-result",
  "finance.create_receipt": "finance.receipt-draft",
  "finance.register_issued_invoice": "finance.register-issued-invoice",
  "finance.analyze_invoice_file": "finance.analyze-invoice-file",
  "finance.get_invoice_detail": "finance.invoice-detail",
  "finance.plan_project_invoice_requests": "finance.project-invoice-request-plan",
  "finance.submit_invoice_request": "finance.submit-invoice-request",
  // ─── Bank flow (Agent 接入) ─────────────────────────────────────────────────
  "finance.analyze_bank_flow_file": "finance.bank-flow-preview",
  "finance.apply_bank_flow_mapping": "finance.bank-flow-preview",
  "finance.ocr_bank_flow_receipts": "finance.bank-flow-preview",
  "finance.match_bank_flow_rows": "finance.bank-flow-match-results",
  "finance.get_bank_flow_row": "finance.bank-flow-row-detail",
  "finance.update_bank_flow_selection": "finance.bank-flow-row-detail",
  "finance.confirm_bank_flow_batch": "finance.bank-flow-confirm",
  // ─── Contracts (Agent 接入) ─────────────────────────────────────────────────
  "contracts.check_coverage": "contracts.coverage-report",
  "contracts.list_templates": "contracts.template-list",
  "contracts.prepare_draft": "contracts.draft-preview",
  "contracts.generate": "contracts.generate-confirm",
  "contracts.get_detail": "contracts.detail",
};

/** Deterministic UI type for an actionKey, or undefined when unmapped. */
export function getMappedAgentUiType(actionKey: string): AgentUiType | undefined {
  return ACTION_UI_MAP[actionKey];
}

/**
 * UI types that render list-shaped `{ items: [...] }` outputs.
 * Used by the card/minimal contract smoke to reject draft-card mis-mappings.
 */
export const LIST_OUTPUT_UI_TYPES: ReadonlySet<AgentUiType> = new Set([
  "crm.customer-list",
  "crm.organization-list",
  "crm.customer-application-list",
  "orders.pending-receipts",
]);

/** Draft / form cards that expect a single proposal payload, not `items[]`. */
export const DRAFT_UI_TYPES: ReadonlySet<AgentUiType> = new Set([
  "crm.checkin-draft",
  "crm.interaction-draft",
  "crm.organization-request-draft",
  "crm.customer-application-draft",
  "crm.followup-draft",
]);

/**
 * Editable form / draft cards where GenUI state "draft" means the user can still
 * interact. Read-only result cards use "loaded" instead so the header does not
 * say「草稿」and get confused with order DRAFT status.
 */
export const EDITABLE_DRAFT_UI_TYPES: ReadonlySet<AgentUiType> = new Set([
  ...DRAFT_UI_TYPES,
  "orders.create-draft",
  "orders.draft-edit",
  "projects.create-draft",
  "tickets.create-draft",
  "tickets.reply-draft",
  "tickets.status-update",
  "finance.receipt-draft",
  "finance.register-issued-invoice",
  "finance.submit-invoice-request",
  "finance.bank-flow-confirm",
  "contracts.generate-confirm",
  "orders.import-row",
]);

/**
 * Derive the UI state from source status + proposal status.
 *
 * loading   - tool still running
 * loaded    - read-only safe action completed (card is informational)
 * draft     - editable safe/form card, user can still interact
 * pending   - proposal created, awaiting confirm/reject
 * saved     - proposal confirmed & executed successfully
 * cancelled - proposal rejected
 * error     - tool error or proposal execution failed
 */
function deriveState(source: AgentUiSource): AgentUiState {
  if (source.status === "running") return "loading";
  if (source.status === "error") return "error";

  if (source.proposal) {
    switch (source.proposal.status) {
      case "PENDING": return "pending";
      case "PROCESSING": return "loading";
      case "CONFIRMED": return "saved";
      case "REJECTED": return "cancelled";
      case "FAILED": return "error";
      default: return "pending";
    }
  }

  // No proposal: safe action result
  if (source.status === "success") {
    const uiType = ACTION_UI_MAP[source.actionKey];
    if (uiType && EDITABLE_DRAFT_UI_TYPES.has(uiType)) return "draft";
    return "loaded";
  }
  return "loading";
}

/**
 * Extract display props from input/output.
 * Each card component re-validates and normalizes these props internally.
 */
function extractProps(source: AgentUiSource): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  if (source.input && typeof source.input === "object") {
    Object.assign(props, source.input as Record<string, unknown>);
  }
  if (source.output && typeof source.output === "object") {
    // Output fields override input where applicable (e.g. resolved customer name)
    const output = source.output as Record<string, unknown>;
    // For list-type results, keep items accessible
    if (Array.isArray(output.items)) {
      props.items = output.items;
    }
    // Merge non-items output fields
    for (const [key, value] of Object.entries(output)) {
      if (key !== "items") {
        props[key] = value;
      }
    }
  }

  // Proposal input is the canonical stored payload after parseInput(); re-merge it so
  // UI cards see the latest confirmed fields (summary/detail/type).
  if (source.proposal?.input && typeof source.proposal.input === "object") {
    Object.assign(props, source.proposal.input as Record<string, unknown>);
  }

  // Display-only fallback: prefer server-generated displayProps, then parse
  // customer name from proposal.summary when the action schema does not persist
  // customerName (e.g. crm.create_interaction).
  if (!props.customerName || props.customerName === "undefined") {
    const displayName = (source.proposal?.displayProps as Record<string, string | null> | undefined)?.customerName;
    if (displayName) {
      props.customerName = displayName;
    } else if (typeof source.proposal?.summary === "string") {
      const match = source.proposal.summary.match(/客户「(.+?)」/);
      if (match?.[1]) props.customerName = match[1];
    }
  }

  return props;
}

/**
 * Map a `crm.search_customers_by_pinyin` matchType to a short Chinese label,
 * used as the choice-card reason chip when the candidate has no `signals[0]`.
 * Kept in sync with `mapMatchType` in src/lib/agent-actions/actions/crm.ts.
 */
function pinyinMatchTypeLabel(matchType: string): string | undefined {
  switch (matchType) {
    case "exact-homophone":
      return "同音命中";
    case "name-contains":
      return "姓名命中";
    case "near-sound":
      return "近音命中";
    case "pinyin-initial":
      return "拼音/首字母命中";
    default:
      return undefined;
  }
}

/**
 * Normalize an AgentUiSource into an AgentUiDescriptor.
 * Returns null for unrecognized actionKeys (caller falls back to generic card).
 */
export function normalizeAgentUi(source: AgentUiSource): AgentUiDescriptor | null {
  const uiType = ACTION_UI_MAP[source.actionKey];
  if (!uiType) return null;

  // Async bank-flow match → progress card
  if (source.actionKey === "finance.match_bank_flow_rows" && source.output) {
    const output = source.output as Record<string, unknown>;
    if (output.mode === "async") {
      return {
        type: "finance.bank-flow-match-job",
        version: 1,
        state: deriveState(source),
        props: extractProps(source),
      };
    }
  }

  // Special case: CRM search result fan-out by hit count.
  // - 0 hits: fall through to the default crm.customer-list card (empty state)
  // - 1 hit: return null -> the search event degrades to a generic tool status
  //   row (FallbackToolCard). We intentionally do NOT synthesize a detail card
  //   from the search payload, because search results lack email / wechat /
  //   recent interactions. A full detail card must come from a subsequent
  //   crm.get_customer_context call (server-controlled follow-up or model).
  // - 2+ hits: choice card for explicit selection
  if (source.actionKey === "crm.search_customers" && source.output) {
    const output = source.output as Record<string, unknown>;
    const items = Array.isArray(output.items) ? output.items : [];
    if (items.length === 1) {
      return null;
    }
    if (items.length > 1) {
      return {
        type: "crm.customer-choice",
        version: 1,
        state: deriveState(source),
        props: extractProps(source),
      };
    }
  }

  // Special case: CRM voice/fuzzy name resolution.
  // - AMBIGUOUS with ≥1 candidate: render the choice card so the user can
  //   confirm/clarify. A single low-confidence candidate (e.g. zsy → 张三阳, 65
  //   分) is still AMBIGUOUS at the resolver level and needs explicit user
  //   confirmation — falling through to a generic tool card would hide the
  //   only candidate. UNIQUE / NO_MATCH fall through to null → FallbackToolCard
  //   so the model continues (UNIQUE → get_customer_context via server
  //   follow-up, NO_MATCH → explains / asks for clarification).
  if (source.actionKey === "crm.resolve_customer_name" && source.output) {
    const output = source.output as Record<string, unknown>;
    const resolution = typeof output.resolution === "string" ? output.resolution : "";
    const candidates = Array.isArray(output.candidates) ? output.candidates : [];
    if (resolution === "AMBIGUOUS" && candidates.length >= 1) {
      const items = candidates.map((cand) => {
        const c = (cand && typeof cand === "object" ? cand : {}) as Record<string, unknown>;
        const reasons = Array.isArray(c.reasons) ? (c.reasons as string[]).filter((r) => typeof r === "string") : [];
        return {
          profileId: typeof c.profileId === "string" ? c.profileId : "",
          customerName: typeof c.name === "string" ? c.name : "",
          organization: typeof c.organization === "string" ? c.organization : (c.organization ?? undefined),
          ownerName: typeof c.ownerName === "string" ? c.ownerName : (c.ownerName ?? undefined),
          reason: reasons.length > 0 ? reasons[0] : undefined,
        };
      });
      return {
        type: "crm.customer-choice",
        version: 1,
        state: deriveState(source),
        props: { ...extractProps(source), items },
      };
    }
    return null;
  }

  // Special case: CRM pinyin/homophone recall (docs §6 / §8.1).
  //  - resolution==="UNIQUE": null. The server follow-up (chat-stream / legacy
  //    chat) re-validates and emits a crm.get_customer_context detail card, so
  //    rendering a choice card here would duplicate it. UNIQUE 覆盖所有唯一命中
  //    （包括正确姓名 name-contains 与同音 exact-homophone），以 resolution 为
  //    唯一判断依据，不再用 candidates.length / matchType 推断（review P2#1）。
  //  - resolution==="AMBIGUOUS" with ≥1 candidate: choice card for explicit
  //    selection. A single low-confidence candidate (e.g. zsy → 张三阳, 65 分) is
  //    still AMBIGUOUS at the resolver level and needs explicit user confirmation.
  //  - resolution==="NO_MATCH" / 缺失: null (fallback row, model explains).
  //
  // Each item's `reason` chip comes from the candidate's `signals[0]` (a
  // human-readable explanation from the resolver, e.g. "发音相同（同音错字）"),
  // falling back to a Chinese label derived from matchType.
  if (source.actionKey === "crm.search_customers_by_pinyin" && source.output) {
    const output = source.output as Record<string, unknown>;
    const resolution = typeof output.resolution === "string" ? output.resolution : "";
    const candidates = Array.isArray(output.candidates) ? output.candidates : [];
    if (resolution === "AMBIGUOUS" && candidates.length >= 1) {
      const items = candidates.map((cand) => {
        const c = (cand && typeof cand === "object" ? cand : {}) as Record<string, unknown>;
        const signals = Array.isArray(c.signals) ? (c.signals as string[]).filter((s) => typeof s === "string") : [];
        const reason = signals.length > 0 ? signals[0] : pinyinMatchTypeLabel(typeof c.matchType === "string" ? c.matchType : "");
        return {
          profileId: typeof c.profileId === "string" ? c.profileId : "",
          customerName: typeof c.name === "string" ? c.name : "",
          organization: typeof c.organization === "string" ? c.organization : (c.organization ?? undefined),
          ownerName: typeof c.ownerName === "string" ? c.ownerName : (c.ownerName ?? undefined),
          reason,
        };
      });
      return {
        type: "crm.customer-choice",
        version: 1,
        state: deriveState(source),
        props: { ...extractProps(source), items },
      };
    }
    return null;
  }

  // Special case: create_visit_checkin with confirmed proposal -> result card
  if (source.actionKey === "crm.create_visit_checkin" && source.proposal?.status === "CONFIRMED") {
    return {
      type: "crm.checkin-result",
      version: 1,
      state: "saved",
      props: extractProps(source),
    };
  }

  const props = extractProps(source);

  // H7: 验证 props 形状。缺失必需字段时 console.error（所有环境），不阻断渲染但提供可观测性。
  {
    const { warnings } = validateAgentUiProps(uiType, props);
    if (warnings.length > 0) {
      console.error("[AgentUI] props validation failed:", warnings);
    }
  }

  return {
    type: uiType,
    version: 1,
    state: deriveState(source),
    props,
  };
}

/**
 * GenUI type definitions for the Agent mobile UI.
 *
 * The model/sidecar never selects a UI type.  The application deterministically
 * maps `actionKey` + input/output/proposal to a `AgentUiType`, then the local
 * component registry renders the corresponding React card.
 *
 * @see docs/agent-mobile-crm-genui-functional-design-2026-07-14.md §6
 */

import type { AgentResourceRequest } from "@/lib/agent-resources/types";
import type { AgentProposal } from "./chat-panel";

export type AgentUiType =
  | "crm.customer-list"
  | "crm.customer-choice"
  | "crm.customer-detail"
  | "crm.checkin-draft"
  | "crm.checkin-result"
  | "crm.interaction-draft"
  | "crm.organization-request-draft"
  | "crm.organization-list"
  | "crm.customer-application-draft"
  | "crm.customer-application-list"
  | "crm.followup-draft"
  | "orders.create-draft"
  | "orders.draft-edit"
  | "orders.detail"
  | "orders.pending-receipts"
  | "orders.finance-snapshot"
  | "projects.create-draft"
  | "tickets.create-draft"
  | "tickets.status-update"
  | "tickets.reply-draft"
  | "finance.match-result"
  | "finance.receipt-draft"
  | "finance.register-issued-invoice"
  | "finance.analyze-invoice-file"
  | "finance.invoice-detail"
  | "orders.analyze-import-file"
  | "orders.import-row"
  | "finance.project-invoice-request-plan"
  | "finance.submit-invoice-request"
  | "finance.bank-flow-preview"
  | "finance.bank-flow-match-results"
  | "finance.bank-flow-match-job"
  | "finance.bank-flow-row-detail"
  | "finance.bank-flow-confirm"
  | "contracts.coverage-report"
  | "contracts.template-list"
  | "contracts.draft-preview"
  | "contracts.generate-confirm"
  | "contracts.detail"
  /**
   * P1-3 UI 接线：模型调 propose_* 被 409 NEEDS_USER_CONFIRMATION 拒后渲染的确认卡片。
   * 不走 ACTION_UI_MAP（它是错误分支而非 action 输出）；由 agent-message-feed 在 tool
   * error 分支直接构造 descriptor 渲染。注册到 cards/index.ts 仅为统一卡片壳样式。
   */
  | "agent.needs-user-confirmation";

export type AgentUiState =
  | "loading"
  | "loaded"
  | "draft"
  | "pending"
  | "saved"
  | "cancelled"
  | "error";

export interface AgentUiDescriptor {
  type: AgentUiType;
  version: 1;
  state: AgentUiState;
  props: Record<string, unknown>;
}

/**
 * The source structure from which a UI descriptor is derived.
 * Both the legacy chat adapter and the Pi timeline adapter produce this same
 * shape, ensuring identical rendering across runtimes.
 */
export interface AgentUiSource {
  actionKey: string;
  input: unknown;
  output?: unknown;
  proposal?: AgentProposal;
  status: "running" | "success" | "error" | "pending_confirmation";
}

/** Props passed to every registered card component. */
export interface AgentCardProps {
  descriptor: AgentUiDescriptor;
  proposal?: AgentProposal;
  proposalBusyId?: string | null;
  onConfirmProposal: (id: string) => void;
  onRejectProposal: (id: string) => void;
  onUpdateProposal: (id: string, input: Record<string, unknown>) => Promise<AgentProposal>;
  onApplyViewIntent: (intent: import("@/lib/agent-runtime/types").AgentViewIntent) => void;
  /**
   * Open a business resource (customer / order / project / ticket / invoice)
   * inside the Agent workspace — desktop right-hand Resource Panel or mobile
   * full-screen Resource Sheet.  Prefer this over `onApplyViewIntent` for
   * in-app entity links so the user stays in the conversation.
   *
   * If the caller wants a full-page navigation instead (e.g. Cmd/Ctrl-click),
   * pass `target: "page"`.
   */
  onOpenResource?: (
    request: AgentResourceRequest,
    options?: { target?: "workspace" | "page" },
  ) => void;
  /**
   * Create a new PENDING proposal by calling POST /api/agent/tools/execute.
   * Used by cards that originate from a safe action (e.g. prepare_visit_checkin)
   * but need to transition into a confirm flow (e.g. create_visit_checkin).
   * For safe actions, the result is added to the timeline as a new card.
   * Returns the created proposal, or null if the action was safe (result mode)
   * or creation failed.
   */
  onCreateProposal?: (actionKey: string, input: Record<string, unknown>) => Promise<AgentProposal | null>;
  /**
   * Send a pre-filled chat message to the Agent.  Used by cards that need to
   * trigger a new Agent interaction (e.g. "add interaction for this customer")
   * where a confirm proposal can't be created directly because required fields
   * are still empty.
   */
  onSendPrefilled?: (message: string, context?: Record<string, unknown>) => void;
  /**
   * Notify the shell that this card has unsaved local state (e.g. edited
   * summary, geo data).  The shell uses this to prompt before switching or
   * creating sessions.  Call with `false` when the card is saved/cancelled.
   * The registry wraps this to inject a stable cardId for multi-card tracking.
   */
  onCardDirtyChange?: (dirty: boolean) => void;
}

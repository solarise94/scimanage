/**
 * Card registration module.
 *
 * Importing this module registers all GenUI card components with the agent UI
 * registry.  This is imported by agent-mobile-shell.tsx to ensure cards are
 * available before rendering.
 */
import { registerAgentUiCard } from "../agent-ui-registry";
import { CrmCustomerListCard } from "./crm-customer-list-card";
import { CrmCustomerChoiceCard } from "./crm-customer-choice-card";
import { CrmCustomerDetailCard } from "./crm-customer-detail-card";
import { CrmCheckinDraftCard } from "./crm-checkin-draft-card";
import { CrmCheckinResultCard } from "./crm-checkin-result-card";
import { CrmInteractionDraftCard } from "./crm-interaction-draft-card";
import { CrmOrganizationRequestCard } from "./crm-organization-request-card";
import { CrmOrganizationListCard } from "./crm-organization-list-card";
import { CrmCustomerApplicationCard } from "./crm-customer-application-card";
import { CrmCustomerApplicationListCard } from "./crm-customer-application-list-card";
import { CrmFollowUpDraftCard } from "./crm-followup-draft-card";
import { OrderCreateDraftCard } from "./order-create-draft-card";
import { OrderDraftEditCard } from "./order-draft-edit-card";
import { OrderDetailCard } from "./order-detail-card";
import { ProjectCreateDraftCard } from "./project-create-draft-card";
import { TicketCreateDraftCard } from "./ticket-create-draft-card";
import { TicketStatusUpdateCard } from "./ticket-status-update-card";
import { TicketReplyDraftCard } from "./ticket-reply-draft-card";
import { FinanceMatchResultCard } from "./finance-match-result-card";
import { FinanceReceiptDraftCard } from "./finance-receipt-draft-card";
import { RegisterIssuedInvoiceCard } from "./register-issued-invoice-card";
import { AnalyzeInvoiceFileCard } from "./analyze-invoice-file-card";
import { AnalyzeOrderImportCard } from "./analyze-order-import-card";
import { ImportOrderRowCard } from "./import-order-row-card";
import { ProjectInvoiceRequestPlanCard } from "./project-invoice-request-plan-card";
import { SubmitInvoiceRequestCard } from "./submit-invoice-request-card";
import {
  FinanceInvoiceDetailCard,
  OrderFinanceSnapshotCard,
  OrderPendingReceiptsCard,
} from "./order-finance-cards";
import { FinanceBankFlowPreviewCard } from "./finance-bank-flow-preview-card";
import { FinanceBankFlowMatchResultsCard } from "./finance-bank-flow-match-results-card";
import { FinanceBankFlowMatchJobCard } from "./finance-bank-flow-match-job-card";
import { FinanceBankFlowRowDetailCard } from "./finance-bank-flow-row-detail-card";
import { FinanceBankFlowConfirmCard } from "./finance-bank-flow-confirm-card";
import { ContractsCoverageReportCard } from "./contracts-coverage-report-card";
import { ContractsTemplateListCard } from "./contracts-template-list-card";
import { ContractsDraftPreviewCard } from "./contracts-draft-preview-card";
import { ContractsGenerateConfirmCard } from "./contracts-generate-confirm-card";
import { ContractsDetailCard } from "./contracts-detail-card";

let registered = false;

/** Register all GenUI cards (idempotent - safe to call multiple times). */
export function ensureCardsRegistered() {
  if (registered) return;
  registered = true;

  registerAgentUiCard("crm.customer-list", CrmCustomerListCard);
  registerAgentUiCard("crm.customer-choice", CrmCustomerChoiceCard);
  registerAgentUiCard("crm.customer-detail", CrmCustomerDetailCard);
  registerAgentUiCard("crm.checkin-draft", CrmCheckinDraftCard);
  registerAgentUiCard("crm.checkin-result", CrmCheckinResultCard);
  registerAgentUiCard("crm.interaction-draft", CrmInteractionDraftCard);
  registerAgentUiCard("crm.organization-request-draft", CrmOrganizationRequestCard);
  registerAgentUiCard("crm.organization-list", CrmOrganizationListCard);
  registerAgentUiCard("crm.customer-application-draft", CrmCustomerApplicationCard);
  registerAgentUiCard("crm.customer-application-list", CrmCustomerApplicationListCard);
  registerAgentUiCard("crm.followup-draft", CrmFollowUpDraftCard);
  registerAgentUiCard("orders.create-draft", OrderCreateDraftCard);
  registerAgentUiCard("orders.draft-edit", OrderDraftEditCard);
  registerAgentUiCard("orders.detail", OrderDetailCard);
  registerAgentUiCard("orders.pending-receipts", OrderPendingReceiptsCard);
  registerAgentUiCard("orders.finance-snapshot", OrderFinanceSnapshotCard);
  registerAgentUiCard("projects.create-draft", ProjectCreateDraftCard);
  registerAgentUiCard("tickets.create-draft", TicketCreateDraftCard);
  registerAgentUiCard("tickets.status-update", TicketStatusUpdateCard);
  registerAgentUiCard("tickets.reply-draft", TicketReplyDraftCard);
  registerAgentUiCard("finance.match-result", FinanceMatchResultCard);
  registerAgentUiCard("finance.receipt-draft", FinanceReceiptDraftCard);
  registerAgentUiCard("finance.register-issued-invoice", RegisterIssuedInvoiceCard);
  registerAgentUiCard("finance.analyze-invoice-file", AnalyzeInvoiceFileCard);
  registerAgentUiCard("finance.invoice-detail", FinanceInvoiceDetailCard);
  registerAgentUiCard("orders.analyze-import-file", AnalyzeOrderImportCard);
  registerAgentUiCard("orders.import-row", ImportOrderRowCard);
  registerAgentUiCard("finance.project-invoice-request-plan", ProjectInvoiceRequestPlanCard);
  registerAgentUiCard("finance.submit-invoice-request", SubmitInvoiceRequestCard);
  registerAgentUiCard("finance.bank-flow-preview", FinanceBankFlowPreviewCard);
  registerAgentUiCard("finance.bank-flow-match-results", FinanceBankFlowMatchResultsCard);
  registerAgentUiCard("finance.bank-flow-match-job", FinanceBankFlowMatchJobCard);
  registerAgentUiCard("finance.bank-flow-row-detail", FinanceBankFlowRowDetailCard);
  registerAgentUiCard("finance.bank-flow-confirm", FinanceBankFlowConfirmCard);
  registerAgentUiCard("contracts.coverage-report", ContractsCoverageReportCard);
  registerAgentUiCard("contracts.template-list", ContractsTemplateListCard);
  registerAgentUiCard("contracts.draft-preview", ContractsDraftPreviewCard);
  registerAgentUiCard("contracts.generate-confirm", ContractsGenerateConfirmCard);
  registerAgentUiCard("contracts.detail", ContractsDetailCard);
}

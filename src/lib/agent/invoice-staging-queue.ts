/**
 * Shared helpers for Agent invoice staging queue (multi-file orchestration).
 */

import type { AgentStreamEvent } from "../../../agent-runtime/src/stream-protocol";
import type { AgentInvoiceStagingAttachment } from "@/lib/agent/invoice-staging-attachment";
import { buildInvoiceStagingMessageContext } from "@/lib/agent/invoice-staging-attachment";

export type InvoiceQueueStatus = NonNullable<AgentInvoiceStagingAttachment["queueStatus"]>;

export const INVOICE_QUEUE_CONTINUATION_MESSAGE = "请继续处理下一张已验证发票附件";

const TERMINAL: ReadonlySet<InvoiceQueueStatus> = new Set([
  "registered",
  "skipped",
  "failed",
]);

export function isInvoiceQueueTerminal(status: InvoiceQueueStatus | undefined): boolean {
  return TERMINAL.has(status || "uploaded");
}

export function getActiveInvoiceQueue(
  attachments: AgentInvoiceStagingAttachment[],
): AgentInvoiceStagingAttachment[] {
  // Exclude pending_confirm: a staging with a PENDING/PROCESSING proposal must
  // wait for the user's confirm/reject decision. Re-injecting it into a
  // continuation would duplicate the proposal card. Continuation advances only
  // through uploaded/analyzed items.
  return attachments.filter(
    (a) => a.stagingFileId
      && !a.uploadError
      && !isInvoiceQueueTerminal(a.queueStatus)
      && a.queueStatus !== "pending_confirm",
  );
}

export function mapServerStagingStatusToQueue(
  status: string,
  opts?: { hasPendingProposal?: boolean },
): InvoiceQueueStatus {
  switch (status) {
    case "ANALYZING":
      return "analyzing";
    case "ANALYZED":
      return opts?.hasPendingProposal ? "pending_confirm" : "analyzed";
    case "REGISTERED":
      return "registered";
    case "SKIPPED":
    case "EXPIRED":
      return "skipped";
    case "UPLOADED":
    default:
      return "uploaded";
  }
}

export function patchInvoiceQueueItem(
  attachments: AgentInvoiceStagingAttachment[],
  stagingFileId: string,
  patch: Partial<AgentInvoiceStagingAttachment>,
): AgentInvoiceStagingAttachment[] {
  return attachments.map((item) =>
    item.stagingFileId === stagingFileId ? { ...item, ...patch } : item,
  );
}

function readStagingIdFromUnknown(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.stagingFileId === "string" && record.stagingFileId.trim()) {
    return record.stagingFileId.trim();
  }
  const staging = record.staging;
  if (staging && typeof staging === "object" && !Array.isArray(staging)) {
    const id = (staging as Record<string, unknown>).id;
    if (typeof id === "string" && id.trim()) return id.trim();
  }
  return null;
}

function readVersionFromAnalyzeOutput(output: unknown): number | null {
  if (!output || typeof output !== "object" || Array.isArray(output)) return null;
  const staging = (output as Record<string, unknown>).staging;
  if (staging && typeof staging === "object" && !Array.isArray(staging)) {
    const version = (staging as Record<string, unknown>).version;
    if (typeof version === "number" && Number.isFinite(version)) return version;
  }
  return null;
}

function readShaFromAnalyzeOutput(output: unknown): string | null {
  if (!output || typeof output !== "object" || Array.isArray(output)) return null;
  const staging = (output as Record<string, unknown>).staging;
  if (staging && typeof staging === "object" && !Array.isArray(staging)) {
    const sha = (staging as Record<string, unknown>).sha256;
    if (typeof sha === "string" && sha) return sha;
  }
  return null;
}

/**
 * Update queue statuses from a single canonical Agent stream event (design
 * §5.8 / plan §6.6). Consumes `scimanage.tool_execution.*` directly. Mapping:
 *  - started (finance.analyze_invoice_file) → analyzing
 *  - completed                              → analyzed/version/sha (read output.staging)
 *  - failed                                 → current analyzing item failed (advance gated
 *                                            by desktop/mobile per-turn flag, exactly once)
 */
export function applyInvoiceQueueStreamEvent(
  attachments: AgentInvoiceStagingAttachment[],
  event: AgentStreamEvent,
): AgentInvoiceStagingAttachment[] {
  if (attachments.length === 0) return attachments;

  if (event.type === "scimanage.tool_execution.started") {
    const toolName = event.tool_name;
    const stagingFileId = readStagingIdFromUnknown(event.input);
    if (!stagingFileId) return attachments;
    if (toolName === "finance.analyze_invoice_file") {
      return patchInvoiceQueueItem(attachments, stagingFileId, { queueStatus: "analyzing" });
    }
    if (toolName === "finance.register_issued_invoice") {
      return patchInvoiceQueueItem(attachments, stagingFileId, { queueStatus: "pending_confirm" });
    }
    return attachments;
  }

  if (event.type === "scimanage.tool_execution.completed") {
    const toolName = event.tool_name;
    if (toolName === "finance.analyze_invoice_file") {
      const stagingFileId = readStagingIdFromUnknown(event.output);
      if (!stagingFileId) return attachments;
      const version = readVersionFromAnalyzeOutput(event.output);
      const sha256 = readShaFromAnalyzeOutput(event.output);
      return patchInvoiceQueueItem(attachments, stagingFileId, {
        queueStatus: "analyzed",
        ...(version != null ? { version } : {}),
        ...(sha256 ? { sha256 } : {}),
      });
    }
    return attachments;
  }

  if (event.type === "scimanage.tool_execution.failed") {
    const toolName = event.tool_name;
    if (toolName !== "finance.analyze_invoice_file") return attachments;
    const stagingFileId = readStagingIdFromUnknown(event.error);
    const errorMsg = event.error?.message;
    if (stagingFileId) {
      return patchInvoiceQueueItem(attachments, stagingFileId, {
        queueStatus: "failed",
        uploadError: typeof errorMsg === "string" ? errorMsg.slice(0, 120) : "识别失败",
      });
    }
    // failed 常只带 error.message：把当前 analyzing 项标为失败，避免队列卡死。
    return attachments.map((item) =>
      item.queueStatus === "analyzing"
        ? {
            ...item,
            queueStatus: "failed" as const,
            uploadError: typeof errorMsg === "string" ? errorMsg.slice(0, 120) : "识别失败",
          }
        : item,
    );
  }

  return attachments;
}

/**
 * @deprecated Transitional alias (canonical-only implementation; no legacy
 * adapter). New code should call {@link applyInvoiceQueueStreamEvent}.
 */
export const applyInvoiceQueueRuntimeEvent = applyInvoiceQueueStreamEvent;

/**
 * Apply statuses from proposals embedded in an assistant message / toolRuns.
 */
export function applyInvoiceQueueFromProposals(
  attachments: AgentInvoiceStagingAttachment[],
  proposals: Array<{ actionKey?: string; status?: string; input?: unknown }>,
): AgentInvoiceStagingAttachment[] {
  let next = attachments;
  for (const proposal of proposals) {
    if (proposal.actionKey !== "finance.register_issued_invoice") continue;
    const stagingFileId = readStagingIdFromUnknown(proposal.input);
    if (!stagingFileId) continue;
    if (proposal.status === "CONFIRMED") {
      next = patchInvoiceQueueItem(next, stagingFileId, { queueStatus: "registered" });
    } else if (proposal.status === "REJECTED") {
      next = patchInvoiceQueueItem(next, stagingFileId, { queueStatus: "skipped" });
    } else if (proposal.status === "FAILED") {
      next = patchInvoiceQueueItem(next, stagingFileId, { queueStatus: "failed" });
    } else if (proposal.status === "PENDING" || proposal.status === "PROCESSING") {
      next = patchInvoiceQueueItem(next, stagingFileId, { queueStatus: "pending_confirm" });
    }
  }
  return next;
}

export function buildInvoiceQueueContinuation(opts: {
  remaining: AgentInvoiceStagingAttachment[];
}): { content: string; messageContext: ReturnType<typeof buildInvoiceStagingMessageContext> } | null {
  // Global gate: while any file is awaiting a user decision (pending_confirm)
  // or mid-analysis (analyzing), halt all queue advancement. This prevents
  // injecting other uploaded/analyzed files in the same turn, which would
  // generate a second concurrent proposal and let two files compete for the
  // user's attention. The queue resumes only after the pending item is
  // resolved (confirmed / rejected / failed) by the caller's continuation.
  const hasGate = opts.remaining.some(
    (a) => a.stagingFileId && (a.queueStatus === "pending_confirm" || a.queueStatus === "analyzing"),
  );
  if (hasGate) return null;

  const remaining = getActiveInvoiceQueue(opts.remaining);
  if (remaining.length === 0) return null;
  return {
    content: INVOICE_QUEUE_CONTINUATION_MESSAGE,
    messageContext: buildInvoiceStagingMessageContext(remaining),
  };
}

export type RestoredStagingItem = {
  id: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  sha256: string;
  version: number;
  expiresAt: string;
  status: string;
  pendingProposalId?: string | null;
};

export function restoreInvoiceQueueFromServer(
  items: RestoredStagingItem[],
): AgentInvoiceStagingAttachment[] {
  return items
    .filter((item) => !["REGISTERED", "SKIPPED", "EXPIRED"].includes(item.status))
    .map((item) => ({
      stagingFileId: item.id,
      fileName: item.fileName,
      mimeType: item.mimeType,
      fileSize: item.fileSize,
      sha256: item.sha256,
      version: item.version,
      expiresAt: item.expiresAt,
      queueStatus: mapServerStagingStatusToQueue(item.status, {
        hasPendingProposal: Boolean(item.pendingProposalId),
      }),
    }));
}

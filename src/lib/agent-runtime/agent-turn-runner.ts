/**
 * Phase 3/5 — the single Agent turn executor (design §7 / plan §5).
 *
 * The native `/api/agent/chat-stream` route and the future OpenAI-compatible
 * facade both call this function. It owns the fixed 12-step turn lifecycle:
 *
 *  1.  trusted actor/source (caller-resolved; route does NextAuth)
 *  2.  create/load session/run
 *  3.  validate + bind attachments (409/413 typed errors thrown verbatim)
 *  4.  atomic user-message commit
 *  5.  load history/memory/hot entities
 *  6.  fetch runtime (/chat-stream)
 *  7.  pre-stream validation (Content-Type / protocol / build version)
 *  8.  parse event stream (shared SSE decoder)
 *  9.  per event: validate → projector → yield
 *  10. runtime EOF: invoice ingest synthetic error + CRM follow-up +
 *      compact summary + assistant message persistence
 *  11. emit `response.completed` only AFTER persistence succeeds AND no fatal
 *      `error` event was observed from the runtime (design §12.3: a fatal
 *      runtime error → `response.failed`, never `completed`)
 *  12. on failure: `error` + `response.failed`
 *
 * Constraints (design §7.1 / §7.3 / plan §5.6):
 *  - no Prisma direct access (only existing application services)
 *  - no server-side fetch of `/api/**`
 *  - synthetic events use the same canonical factory + response_id + sequencer
 *    as runtime events (continues monotonic numbering, no local 0..N, no reuse
 *    of runtime's last sequence)
 *  - the ENTIRE synthetic tail (CRM follow-up, ingest error, completed, and
 *    the failure-path error + response.failed) shares ONE sequencer instance
 *    so the catch path never rebuilds from lastRuntimeSequence (which would
 *    reuse/regress numbers already handed out)
 *  - runtime EOF is never surfaced as success; a fatal runtime `error` event
 *    is never surfaced as `response.completed`
 *
 * Phase 5 (plan §7): SSE is the only wire transport. The runner yields canonical
 * `AgentStreamEvent` objects parsed from the runtime's SSE stream via the shared
 * decoder (`@/lib/agent-stream/decode-sse`); framing into SSE bytes for the
 * browser is the route's responsibility.
 */
import { randomUUID } from "crypto";

import {
  AGENT_STREAM_PROTOCOL,
  AgentStreamProtocolError,
  type AgentEventSpec,
  type AgentStreamEvent,
} from "../../../agent-runtime/src/stream-protocol";
import { createSseEventDecoder } from "@/lib/agent-stream/decode-sse";
import { executeAgentToolForRun } from "@/lib/agent-actions/execute-tool-for-run";
import { listAvailableAgentActions } from "@/lib/agent-actions/registry";
import { getInternalToolToken, getOrCreateAgentRunFromSession } from "@/lib/agent-actions/run-context";
import { actionToTool } from "@/lib/agent-actions/tool-adapter";
import { AgentActionError, AgentActionInputError } from "@/lib/agent-actions/errors";
import { getAgentInternalAppBaseUrl } from "@/lib/app-url";
import {
  commitAgentChatUserMessage,
  createAgentChatMessage,
  getAgentChatSessionDetail,
  updateAgentChatSession,
} from "@/lib/agent-runtime/chat-sessions";
import {
  getAgentRuntimeBaseUrl,
  getAgentRuntimeFlags,
  getAgentRuntimeToken,
} from "@/lib/agent-runtime/config";
import { listAgentMemory } from "@/lib/agent-runtime/memory";
import type { AgentTimelineItem } from "@/lib/agent-runtime/types";
import { listHotCustomersForActor } from "@/lib/crm/hot-customers";
import { listHotProjectsForActor } from "@/lib/agent-runtime/hot-projects";
import { listActiveEntityMemoriesForActor } from "@/lib/agent-runtime/entity-memory-access";
import { validateCustomerTarget } from "@/lib/crm/customer-target-validator";
import { appendVerifiedCustomerHistoryContext } from "@/lib/agent-runtime/history-context";
import {
  shouldFollowCrmCustomerContext,
  extractCrmFollowUpProfileId,
} from "@/lib/agent-runtime/crm-follow-up";
import {
  assertAndBindStagingToAgentRun,
  validateVerifiedInvoiceStagingContextList,
  type VerifiedInvoiceStagingContext,
} from "@/lib/finance/invoice-staging";
import { createInvoiceIngestJob } from "@/lib/finance/invoice-ingest-job";
import {
  assertAndBindImportStagingToAgentRun,
  validateVerifiedImportStagingContext,
  IMPORT_KIND,
  type VerifiedImportStagingContext,
} from "@/lib/import-staging";
import {
  getOwnedAgentAttachment,
  validateVerifiedAgentAttachmentContext,
  verifyAttachmentIntegrity,
  type VerifiedAgentAttachmentContext,
} from "@/lib/agent-attachments/staging";
import {
  ATTACHMENT_MAX_FILES_PER_MESSAGE,
  ATTACHMENT_MAX_TOTAL_BYTES_PER_MESSAGE,
} from "@/lib/agent-attachments/constants";
import { StagingError } from "@/lib/staging-common";
import type { BusinessActor } from "@/lib/application/actor";
import type { Session } from "next-auth";

import {
  createAgentTurnAggregate,
  normalizeTimelineForPersistence,
  projectAgentStreamEvent,
  type AgentTurnAggregate,
} from "./agent-stream-projector";
import { readOnlyPublicToolSpecs } from "./openai-compat-policy";

/** App build version, same source as runtime config / build-version route. */
export function getAppBuildVersion(): string {
  return (
    process.env.APP_BUILD_VERSION ||
    process.env.NEXT_PUBLIC_APP_BUILD_VERSION ||
    "development"
  ).trim() || "development";
}

// ── Typed runner errors (design §5.7) ────────────────────────────────────────

/**
 * Pre-stream transport mismatch (design §6.1 / plan §5.5). The route maps this
 * to HTTP 503 `{ code: "STREAM_TRANSPORT_MISMATCH" }` WITHOUT forwarding any
 * runtime body byte. Not auto-recoverable; never cross-parses protocols.
 */
export class AgentStreamTransportMismatchError extends Error {
  readonly code = "STREAM_TRANSPORT_MISMATCH" as const;
  readonly details: Record<string, unknown>;
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "AgentStreamTransportMismatchError";
    this.details = details;
  }
}

// ── Synthetic event sequencer (plan §5.6) ────────────────────────────────────

/**
 * Mutable sequencer for server-controlled synthetic events. Continues strictly
 * monotonically from the runtime's last seen sequence number (or 0 if runtime
 * emitted nothing). Uses the runtime's response_id so all events in the turn
 * share it. Never reuses a runtime sequence; never builds a local 0..N.
 *
 * Plan §5.6: synthetic events must use the same canonical event factory + same
 * response_id + Runner's current sequencer. This is the runner's sequencer.
 */
export interface SyntheticSequencer {
  /** The runtime response_id all synthetic events carry. */
  readonly responseId: string;
  /** Produce the next synthetic event, stamped with the next sequence number. */
  next(spec: AgentEventSpec): AgentStreamEvent;
}

function createSyntheticSequencer(
  responseId: string,
  lastRuntimeSequence: number,
  sessionId: string,
  agentRunId: string,
): SyntheticSequencer {
  let next_ = lastRuntimeSequence + 1;
  return {
    get responseId() {
      return responseId;
    },
    next(spec) {
      const sequence_number = next_;
      next_ += 1;
      const event = {
        ...spec,
        protocol: AGENT_STREAM_PROTOCOL,
        response_id: responseId,
        sequence_number,
        session_id: sessionId,
        agent_run_id: agentRunId,
        created_at: Date.now(),
      } as unknown as AgentStreamEvent;
      return event;
    },
  };
}

// ── Input / output contract ──────────────────────────────────────────────────

export interface RunAgentTurnInput {
  actor: BusinessActor;
  /** Trusted NextAuth session (used by getOrCreateAgentRunFromSession). */
  session: Session;
  message: string;
  sessionId?: string;
  agentRunId?: string;
  inputMode?: "voice" | "text";
  /** Untrusted messageContext envelope straight from JSON parse. */
  messageContext?: AgentMessageContextEnvelope;
  /** AbortSignal wired to the HTTP request signal (design §12.1). */
  signal?: AbortSignal;
  /**
   * Phase 6: trusted AgentRun.source to stamp on the created run/session
   * (design §8.4). Defaults to "CHAT". Native callers must NOT set this.
   * The value is trusted (server-set), never from request body.
   */
  source?: "CHAT" | "OPENAI_COMPAT";
  /**
   * Phase 6: tool injection policy (design §8.4 Layer 1).
   *  - "native" (default): inject the full internal-action tool list (CHAT).
   *  - "openai_read_only": inject only discovery/context public tools.
   * Native CHAT behaviour is byte-level unchanged when omitted.
   */
  toolPolicy?: "native" | "openai_read_only";
  /**
   * Phase 6: cold-start external history (OpenAI messages), used ONLY as
   * bootstrap context for a brand-new OPENAI_COMPAT session. Server-side
   * history is always the source of truth; this never overwrites/deletes/
   * reorders persisted history (design §8.7 / §11.3).
   */
  externalHistory?: Array<{ role: "system" | "user" | "assistant"; content: string }>;
}

export interface AgentMessageContextEnvelope {
  verifiedCustomerProfileId?: unknown;
  verifiedInvoiceStaging?: unknown;
  verifiedInvoiceStagingFiles?: unknown;
  verifiedImportStagingFiles?: unknown;
  verifiedAgentAttachments?: unknown;
}

export interface RunAgentTurnResult {
  sessionId: string;
  agentRunId: string;
  /** Runtime's response_id (resolved from response.created); placeholder before. */
  responseId: string;
  /** Canonical events for the whole turn, in order. Route frames them as SSE. */
  events: AsyncGenerator<AgentStreamEvent, void, unknown>;
}

interface ResolvedEarlyAttachments {
  invoiceStagingFiles: VerifiedInvoiceStagingContext[];
  importStagingFiles: VerifiedImportStagingContext[];
  verifiedCustomerProfileId: string;
  /** Non-null when the invoice ingest job envelope creation failed. */
  ingestJobError: string | null;
}

const NATIVE_IMAGE_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);

// ── Attachment validation (step 3) ───────────────────────────────────────────

async function resolveEarlyAttachments(
  actor: BusinessActor,
  agentRunId: string,
  raw: AgentMessageContextEnvelope | undefined,
): Promise<ResolvedEarlyAttachments> {
  const verifiedCustomerProfileIdRaw =
    typeof raw?.verifiedCustomerProfileId === "string"
      ? raw.verifiedCustomerProfileId.trim()
      : "";
  let verifiedCustomerProfileId = "";
  if (verifiedCustomerProfileIdRaw) {
    const validation = await validateCustomerTarget(actor, verifiedCustomerProfileIdRaw);
    if (validation.ok) {
      verifiedCustomerProfileId = validation.profile.profileId;
    } else {
      console.warn(
        "[agent-turn-runner] ignored unverifiedCustomerProfileId:",
        validation.reason,
      );
    }
  }

  const rawInvoiceStaging =
    raw?.verifiedInvoiceStaging &&
    typeof raw.verifiedInvoiceStaging === "object" &&
    !Array.isArray(raw.verifiedInvoiceStaging)
      ? (raw.verifiedInvoiceStaging as Record<string, unknown>)
      : null;
  const rawInvoiceStagingFiles = Array.isArray(raw?.verifiedInvoiceStagingFiles)
    ? raw!.verifiedInvoiceStagingFiles
    : null;

  let invoiceStagingFiles: VerifiedInvoiceStagingContext[] = [];
  let ingestJobError: string | null = null;
  if (actor.role === "ADMIN") {
    const rawItems: Array<{ stagingFileId?: unknown; sha256?: unknown; version?: unknown }> = [];
    if (rawInvoiceStagingFiles) {
      for (const item of rawInvoiceStagingFiles) {
        if (item && typeof item === "object" && !Array.isArray(item)) {
          rawItems.push(item as Record<string, unknown>);
        }
      }
    } else if (rawInvoiceStaging) {
      rawItems.push(rawInvoiceStaging);
    }
    if (rawItems.length > 0) {
      const candidates = await validateVerifiedInvoiceStagingContextList({
        userId: actor.userId,
        items: rawItems,
        agentRunId,
      });
      if (candidates.length > 0) {
        try {
          await assertAndBindStagingToAgentRun({
            stagingFileIds: candidates.map((f) => f.stagingFileId),
            userId: actor.userId,
            agentRunId,
          });
          invoiceStagingFiles = candidates;
        } catch (err) {
          console.warn(
            "[agent-turn-runner] refused invoice staging bind:",
            err instanceof Error ? err.message : err,
          );
          invoiceStagingFiles = [];
        }
        if (invoiceStagingFiles.length > 0) {
          try {
            await createInvoiceIngestJob({
              ownerUserId: actor.userId,
              stagingFileIds: candidates.map((f) => f.stagingFileId),
              agentRunId,
            });
          } catch (err) {
            console.error(
              "[agent-turn-runner] createInvoiceIngestJob failed (binding preserved):",
              err instanceof Error ? err.message : err,
            );
            ingestJobError = err instanceof Error ? err.message : "unknown";
          }
        }
      }
    }
  }

  let importStagingFiles: VerifiedImportStagingContext[] = [];
  if (actor.role === "ADMIN" && Array.isArray(raw?.verifiedImportStagingFiles)) {
    const rawItems: Array<{ stagingFileId?: unknown; sha256?: unknown; version?: unknown }> = [];
    for (const item of raw!.verifiedImportStagingFiles!) {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        rawItems.push(item as Record<string, unknown>);
      }
    }
    const verified: VerifiedImportStagingContext[] = [];
    const seen = new Set<string>();
    for (const item of rawItems.slice(0, 10)) {
      const stagingFileId = typeof item.stagingFileId === "string" ? item.stagingFileId.trim() : "";
      if (!stagingFileId || seen.has(stagingFileId)) continue;
      seen.add(stagingFileId);
      const sha256 = typeof item.sha256 === "string" ? item.sha256.trim() : undefined;
      const version = typeof item.version === "number" ? item.version : undefined;
      const validated = await validateVerifiedImportStagingContext({
        userId: actor.userId,
        stagingFileId,
        expectedSha256: sha256,
        expectedVersion: version,
        importKind: IMPORT_KIND.ORDER,
        agentRunId,
      });
      if (validated) verified.push(validated);
    }
    if (verified.length > 0) {
      try {
        await assertAndBindImportStagingToAgentRun({
          stagingFileIds: verified.map((f) => f.stagingFileId),
          userId: actor.userId,
          agentRunId,
        });
        importStagingFiles = verified;
      } catch (err) {
        console.warn(
          "[agent-turn-runner] refused import staging bind:",
          err instanceof Error ? err.message : err,
        );
        importStagingFiles = [];
      }
    }
  }

  return {
    invoiceStagingFiles,
    importStagingFiles,
    verifiedCustomerProfileId,
    ingestJobError,
  };
}

/**
 * Validate + bind generic agent attachments. Throws typed 409/413 errors that
 * the route maps verbatim. Requires the existing-session id (or null for new).
 */
async function resolveGenericAttachments(
  actor: BusinessActor,
  agentRunId: string,
  rawAttachments: unknown[] | null,
  needsNewSession: boolean,
  existingSessionId: string | null,
): Promise<{
  verified: VerifiedAgentAttachmentContext[];
  images: Array<{ stagingFileId: string; mimeType: string; dataBase64: string }>;
}> {
  if (!rawAttachments || rawAttachments.length === 0) {
    return { verified: [], images: [] };
  }

  const requestedIds: string[] = [];
  const seenAtt = new Set<string>();
  for (const item of rawAttachments.slice(0, ATTACHMENT_MAX_FILES_PER_MESSAGE)) {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const sid =
        typeof (item as Record<string, unknown>).stagingFileId === "string"
          ? ((item as Record<string, unknown>).stagingFileId as string).trim()
          : "";
      if (sid && !seenAtt.has(sid)) {
        seenAtt.add(sid);
        requestedIds.push(sid);
      }
    }
  }
  if (requestedIds.length === 0) return { verified: [], images: [] };

  const verified: VerifiedAgentAttachmentContext[] = [];
  for (const item of rawAttachments.slice(0, ATTACHMENT_MAX_FILES_PER_MESSAGE)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    const stagingFileId = typeof rec.stagingFileId === "string" ? rec.stagingFileId.trim() : "";
    if (!stagingFileId) continue;
    const sha256 = typeof rec.sha256 === "string" ? rec.sha256.trim() : undefined;
    const version = typeof rec.version === "number" ? rec.version : undefined;
    const validated = await validateVerifiedAgentAttachmentContext({
      userId: actor.userId,
      stagingFileId,
      expectedSha256: sha256,
      expectedVersion: version,
      chatSessionId: needsNewSession ? null : existingSessionId,
      agentRunId,
    });
    if (!validated) {
      throw new AgentActionError(
        "部分附件无效、已过期或不可注入当前会话",
        409,
        "ATTACHMENT_CHANGED",
      );
    }
    verified.push(validated);
  }
  if (verified.length !== requestedIds.length) {
    throw new AgentActionError("附件校验失败", 409, "ATTACHMENT_CHANGED");
  }
  const totalBytes = verified.reduce((sum, a) => sum + a.fileSize, 0);
  if (totalBytes > ATTACHMENT_MAX_TOTAL_BYTES_PER_MESSAGE) {
    throw new AgentActionError(
      "附件总大小超过每条消息 30 MB 上限",
      413,
      "ATTACHMENT_TOO_LARGE",
    );
  }

  const images: Array<{ stagingFileId: string; mimeType: string; dataBase64: string }> = [];
  for (const att of verified) {
    if (!NATIVE_IMAGE_MIME.has(att.mimeType)) continue;
    try {
      const staging = await getOwnedAgentAttachment({
        stagingId: att.stagingFileId,
        userId: actor.userId,
        requireActive: true,
      });
      const buffer = await verifyAttachmentIntegrity({
        staging,
        expectedSha256: att.sha256,
        expectedVersion: att.version,
      });
      images.push({
        stagingFileId: att.stagingFileId,
        mimeType: att.mimeType,
        dataBase64: buffer.toString("base64"),
      });
    } catch (err) {
      console.warn(
        "[agent-turn-runner] skip native image attachment:",
        err instanceof Error ? err.message : err,
      );
    }
  }
  return { verified, images };
}

// ── Pre-stream validation (step 7) ───────────────────────────────────────────

/**
 * Validate runtime response headers BEFORE reading any body byte (design §6.1 /
 * plan §5.5). Phase 5: SSE is the only transport, so Content-Type must be
 * `text/event-stream`. Throws {@link AgentStreamTransportMismatchError} on any
 * mismatch.
 */
export function assertRuntimeStreamHeaders(
  headers: Headers,
  appBuildVersion: string,
): void {
  const contentType = (headers.get("content-type") || "").toLowerCase();
  const protocolHeader = headers.get("x-agent-stream-protocol");
  const runtimeBuildVersion = headers.get("x-agent-runtime-build-version");

  const expectedContentType = "text/event-stream";

  if (!contentType.startsWith(expectedContentType)) {
    throw new AgentStreamTransportMismatchError(
      `runtime Content-Type "${contentType}" does not match expected "${expectedContentType}"`,
      {
        field: "content-type",
        expected: expectedContentType,
        actual: contentType,
      },
    );
  }
  if (protocolHeader !== AGENT_STREAM_PROTOCOL) {
    throw new AgentStreamTransportMismatchError(
      `runtime X-Agent-Stream-Protocol "${protocolHeader}" does not match "${AGENT_STREAM_PROTOCOL}"`,
      { field: "x-agent-stream-protocol", expected: AGENT_STREAM_PROTOCOL, actual: protocolHeader },
    );
  }
  if (runtimeBuildVersion !== appBuildVersion) {
    throw new AgentStreamTransportMismatchError(
      `runtime build version "${runtimeBuildVersion}" does not match app build version "${appBuildVersion}"`,
      {
        field: "x-agent-runtime-build-version",
        expected: appBuildVersion,
        actual: runtimeBuildVersion,
      },
    );
  }
}

// ── Synthetic event builders (steps 10) ──────────────────────────────────────

/**
 * Build the invoice-ingest-job synthetic error event pair (started + failed),
 * mirroring the legacy route's TransformStream `start` hook. Emitted at runtime
 * EOF (after the main reply) so canonical ordering (created → ... → completed)
 * is preserved. Routed through the same sequencer/response_id (plan §5.6).
 */
function buildIngestJobErrorEvents(
  seq: SyntheticSequencer,
  agentRunId: string,
  ingestJobError: string,
): AgentStreamEvent[] {
  const errorId = `ingest_job_error_${agentRunId}`;
  return [
    seq.next({
      type: "scimanage.tool_execution.started",
      tool_execution_id: errorId,
      tool_name: "invoice.ingest",
      label: "发票分析任务创建失败",
    }),
    seq.next({
      type: "scimanage.tool_execution.failed",
      tool_execution_id: errorId,
      tool_name: "invoice.ingest",
      label: "发票分析任务创建失败",
      error: { message: ingestJobError },
    }),
  ];
}

/**
 * Build canonical synthetic events for the CRM get_customer_context follow-up
 * (design §7.2 step 10 / plan §5.6). Sequence numbers continue monotonically
 * from the runtime's last; never reuses; never local 0..N.
 */
async function buildCrmFollowUpEvents(
  seq: SyntheticSequencer,
  timeline: AgentTimelineItem[],
  agentRunId: string,
  actor: BusinessActor,
): Promise<AgentStreamEvent[]> {
  const out: AgentStreamEvent[] = [];

  function hasMatchingContext(profileId: string): boolean {
    return timeline.some((other) => {
      if (other.kind !== "tool") return false;
      if (other.toolName !== "crm.get_customer_context") return false;
      if (other.status !== "done") return false;
      if (other.error) return false;
      const otherInput = other.input as Record<string, unknown> | undefined;
      return otherInput?.profileId === profileId;
    });
  }

  let targetSearchItem: Extract<AgentTimelineItem, { kind: "tool" }> | null = null;
  let targetProfileId: string | null = null;
  for (const item of timeline) {
    if (item.kind !== "tool") continue;
    if (item.status !== "done") continue;
    if (!shouldFollowCrmCustomerContext(item.toolName)) continue;
    const profileId = extractCrmFollowUpProfileId(item.toolName, item.output);
    if (!profileId) continue;
    if (hasMatchingContext(profileId)) continue;
    targetSearchItem = item;
    targetProfileId = profileId;
    break;
  }
  if (!targetSearchItem || !targetProfileId) return out;

  const validation = await validateCustomerTarget(actor, targetProfileId);
  const label = "查看客户详情";

  if (!validation.ok) {
    const validationErrorId = `followup_validation_${targetSearchItem.id}`;
    out.push(
      seq.next({
        type: "scimanage.tool_execution.started",
        tool_execution_id: validationErrorId,
        tool_name: "crm.get_customer_context",
        label: "客户校验失败",
        input: { profileId: targetProfileId },
      }),
    );
    out.push(
      seq.next({
        type: "scimanage.tool_execution.failed",
        tool_execution_id: validationErrorId,
        tool_name: "crm.get_customer_context",
        label: "客户校验失败",
        error: { message: validation.reason },
      }),
    );
    return out;
  }

  const followUpId = `followup_get_context_${targetSearchItem.id}`;
  out.push(
    seq.next({
      type: "scimanage.tool_execution.started",
      tool_execution_id: followUpId,
      tool_name: "crm.get_customer_context",
      label,
      input: { profileId: targetProfileId },
    }),
  );

  try {
    const toolData = await executeAgentToolForRun({
      agentRunId,
      actionKey: "crm.get_customer_context",
      input: { profileId: targetProfileId },
    });
    if (toolData.mode !== "result") {
      out.push(
        seq.next({
          type: "scimanage.tool_execution.failed",
          tool_execution_id: followUpId,
          tool_name: "crm.get_customer_context",
          label,
          error: { message: "客户档案读取未返回结果" },
        }),
      );
      return out;
    }
    out.push(
      seq.next({
        type: "scimanage.tool_execution.completed",
        tool_execution_id: followUpId,
        tool_name: "crm.get_customer_context",
        label,
        output: toolData.result,
      }),
    );
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : "Customer context follow-up failed";
    out.push(
      seq.next({
        type: "scimanage.tool_execution.failed",
        tool_execution_id: followUpId,
        tool_name: "crm.get_customer_context",
        label,
        error: { message: errorMsg },
      }),
    );
  }
  return out;
}

// ── Phase 6: read-only tool surface (Layer 1, design §8.4) ───────────────────

/**
 * Build the tool list the model sees for this turn.
 *
 * - `native` (default, CHAT): inject the full internal-action tool list. This
 *   is byte-level identical to the pre-Phase-6 behaviour — same actions, same
 *   order, same adapter output.
 * - `openai_read_only`: inject ONLY the public-manifest discovery/context tools.
 *   The model literally never sees propose/preview/workflow/confirm tools. The
 *   public tool definitions (name/description/input_schema) come straight from
 *   the manifest; internal action keys are never exposed.
 *
 * Layer 2 (public executor source gate) enforces this again at execution time,
 * so even a model that hand-crafts a write tool name is refused (403).
 */
function buildTurnTools(
  actions: Awaited<ReturnType<typeof listAvailableAgentActions>>,
  policy: "native" | "openai_read_only",
): Array<{ name: string; description: string; input_schema: unknown }> {
  if (policy !== "openai_read_only") {
    return actions.map(actionToTool);
  }
  // Read-only surface: project only discovery/context public manifest tools.
  // PUBLIC_TOOL_MANIFEST is a static, Prisma-free module; importing it at the
  // top of this file would not change the native CHAT path, but we keep the
  // import local to buildTurnTools to minimise the native import graph and keep
  // the diff focused. isAllowedForReadOnlyRun is the single filter source.
  return readOnlyPublicToolSpecs();
}

// ── Public entry point ───────────────────────────────────────────────────────

/**
 * Execute one Agent turn. See {@link RunAgentTurnInput}.
 *
 * Pre-stream errors (steps 1–7) throw — the route maps them to JSON HTTP
 * responses (401/403/409/413/503). Post-stream errors (steps 8–12) surface as
 * `error` + `response.failed` events inside the SSE stream.
 */
export async function runAgentTurn(input: RunAgentTurnInput): Promise<RunAgentTurnResult> {
  const appBuildVersion = getAppBuildVersion();

  // Step 1 — trusted actor.
  const { actor, session, signal } = input;
  const messageText = input.message.trim();
  if (!messageText) {
    throw new AgentActionInputError("message is required");
  }

  // Step 2 — create/load run. Phase 6: trusted source from the caller
  // (default "CHAT"). OPENAI_COMPAT is only ever set by the facade route.
  const trustedSource = input.source ?? "CHAT";
  const agentRun = await getOrCreateAgentRunFromSession(
    session,
    typeof input.agentRunId === "string" ? input.agentRunId.trim() : null,
    trustedSource,
  );

  // Step 3a — early attachment validation (invoice/import/customer profile).
  const early = await resolveEarlyAttachments(actor, agentRun.id, input.messageContext);

  const existingSessionId =
    typeof input.sessionId === "string" ? input.sessionId.trim() : "";
  const needsNewSession = !existingSessionId;
  let sessionDetail: Awaited<ReturnType<typeof getAgentChatSessionDetail>> | null = null;
  if (!needsNewSession) {
    sessionDetail = await getAgentChatSessionDetail(actor, existingSessionId);
  }

  // Step 3b — generic attachments (throws typed 409/413).
  const rawAttachments = Array.isArray(input.messageContext?.verifiedAgentAttachments)
    ? input.messageContext!.verifiedAgentAttachments!
    : null;
  const genericAttachments = await resolveGenericAttachments(
    actor,
    agentRun.id,
    rawAttachments,
    needsNewSession,
    sessionDetail?.id ?? null,
  );

  // Step 4 — atomic user-message commit.
  const attachmentStagingIds = genericAttachments.verified.map((a) => a.stagingFileId);
  let committedSessionId: string;
  try {
    committedSessionId = await commitAgentChatUserMessage(actor, {
      needsNewSession,
      existingSessionId: sessionDetail?.id ?? null,
      agentRunId: agentRun.id,
      newSessionTitle: messageText.slice(0, 48),
      source: trustedSource,
      message: messageText,
      inputMode: input.inputMode ?? null,
      attachmentStagingIds,
    });
  } catch (err) {
    if (err instanceof StagingError) {
      throw new AgentActionError(
        "附件已绑定到其他会话，无法注入当前对话",
        409,
        err.code,
      );
    }
    throw err;
  }
  if (needsNewSession || !sessionDetail) {
    sessionDetail = await getAgentChatSessionDetail(actor, committedSessionId);
  }

  // Step 5 — load history/memory/hot entities in parallel.
  const [actions, memories, hotCustomers, hotProjects, entityMemories, historyDetail] =
    await Promise.all([
      listAvailableAgentActions(actor),
      listAgentMemory(actor, { status: "ACTIVE", limit: 20 }),
      listHotCustomersForActor(actor).catch((err) => {
        console.error("listHotCustomersForActor failed:", err);
        return [];
      }),
      listHotProjectsForActor(actor).catch((err) => {
        console.error("listHotProjectsForActor failed:", err);
        return [];
      }),
      listActiveEntityMemoriesForActor(actor, 15).catch((err) => {
        console.error("listActiveEntityMemoriesForActor failed:", err);
        return [];
      }),
      getAgentChatSessionDetail(actor, sessionDetail.id),
    ]);
  const tools = buildTurnTools(actions, input.toolPolicy ?? "native");
  const flags = getAgentRuntimeFlags();
  const history = historyDetail.messages.map((item) => ({
    role: item.role,
    content:
      item.role === "assistant"
        ? appendVerifiedCustomerHistoryContext(item.content, item.timeline)
        : item.content,
    createdAt: item.createdAt,
  }));
  // Phase 6 (design §8.7 / §11.3): external cold-start history is prepended ONLY
  // as bootstrap context for the runtime. It is never persisted, never
  // overwrites/deletes/reorders server-side history (server session is always
  // the source of truth). Only OPENAI_COMPAT facade passes externalHistory.
  const externalHistory = input.externalHistory ?? [];
  const runtimeHistory =
    externalHistory.length > 0
      ? [
          ...externalHistory.map((m) => ({ role: m.role, content: m.content })),
          ...history,
        ]
      : history;
  const imageBase64ByStagingId = new Map<string, string>(
    genericAttachments.images.map((img) => [img.stagingFileId, img.dataBase64]),
  );
  const verifiedInvoiceStaging = early.invoiceStagingFiles[0]
    ? {
        stagingFileId: early.invoiceStagingFiles[0].stagingFileId,
        sha256: early.invoiceStagingFiles[0].sha256,
        version: early.invoiceStagingFiles[0].version,
        fileName: early.invoiceStagingFiles[0].fileName,
      }
    : null;

  // Build the optional messageContext payload separately so the runtime request
  // body stays flat and unambiguous (the inline `...(cond ? a : b)` form is hard
  // to read and was a parse-error magnet).
  const hasMessageContext =
    Boolean(early.verifiedCustomerProfileId) ||
    early.invoiceStagingFiles.length > 0 ||
    early.importStagingFiles.length > 0 ||
    genericAttachments.verified.length > 0;
  const messageContext: Record<string, unknown> | null = hasMessageContext
    ? {
        ...(early.verifiedCustomerProfileId
          ? { verifiedCustomerProfileId: early.verifiedCustomerProfileId }
          : {}),
        ...(verifiedInvoiceStaging ? { verifiedInvoiceStaging } : {}),
        ...(early.invoiceStagingFiles.length > 0
          ? {
              verifiedInvoiceStagingFiles: early.invoiceStagingFiles.map((f) => ({
                stagingFileId: f.stagingFileId,
                sha256: f.sha256,
                version: f.version,
                fileName: f.fileName,
              })),
            }
          : {}),
        ...(early.importStagingFiles.length > 0
          ? {
              verifiedImportStagingFiles: early.importStagingFiles.map((f) => ({
                stagingFileId: f.stagingFileId,
                sha256: f.sha256,
                version: f.version,
                fileName: f.fileName,
                importKind: f.importKind,
              })),
            }
          : {}),
        ...(genericAttachments.verified.length > 0
          ? {
              verifiedAgentAttachments: genericAttachments.verified.map((a) => ({
                stagingFileId: a.stagingFileId,
                sha256: a.sha256,
                version: a.version,
                fileName: a.fileName,
                mimeType: a.mimeType,
                fileSize: a.fileSize,
                ...(imageBase64ByStagingId.has(a.stagingFileId)
                  ? { imageDataBase64: imageBase64ByStagingId.get(a.stagingFileId) }
                  : {}),
              })),
            }
          : {}),
      }
    : null;

  // Step 6 — fetch runtime.
  const runtimeRes = await fetch(`${getAgentRuntimeBaseUrl()}/chat-stream`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-agent-runtime-token": getAgentRuntimeToken(),
    },
    body: JSON.stringify({
      requestId: randomUUID(),
      agentRunId: agentRun.id,
      sessionId: sessionDetail.id,
      user: {
        id: actor.userId,
        role: actor.role,
        name: actor.name,
        email: actor.email,
      },
      message: messageText,
      ...(messageContext ? { messageContext } : {}),
      inputMode: input.inputMode ?? undefined,
      history: runtimeHistory,
      compactSummary: sessionDetail.compactSummary,
      memories: memories.map((item) => ({
        id: item.id,
        kind: item.kind,
        content: item.content,
        confidence: item.confidence,
        status: item.status,
      })),
      hotCustomers,
      hotProjects,
      entityMemories: entityMemories.map((item) => ({
        entityType: item.entityType,
        entityId: item.entityId,
        name: item.name,
        summary: item.summary,
        lastActiveAt: item.lastActiveAt?.toISOString() ?? null,
      })),
      availableTools: tools,
      bridge: {
        appBaseUrl: getAgentInternalAppBaseUrl(),
        internalToolToken: getInternalToolToken(),
      },
      context: {
        currentView: null,
        viewControlEnabled: flags.viewControlEnabled,
        webSearchEnabled: flags.webSearchEnabled,
        proactiveEnabled: flags.proactiveEnabled,
        dynamicToolBundlesEnabled: flags.dynamicToolBundlesEnabled,
      },
      // P1 (defect 2): when the Runner injected public read-only tool keys
      // (openai_read_only policy), tell the runtime to dispatch them through
      // execute-public (Layer-2 read-only 403 gate) and to SKIP the bundle
      // selector (which would re-introduce write tools, defeating Layer 1).
      // Native CHAT omits this → dynamicToolBundlesEnabled alone decides
      // dispatch (byte-level unchanged).
      ...(input.toolPolicy === "openai_read_only"
        ? { toolDispatch: "public_read_only" as const }
        : {}),
    }),
    signal,
  });

  if (!runtimeRes.ok || !runtimeRes.body) {
    const text = await runtimeRes.text().catch(() => "");
    throw new Error(text || "Runtime stream failed");
  }

  // Step 7 — pre-stream header validation. MUST happen before any body byte
  // is read/framed. On mismatch we abort without forwarding (design §6.1).
  assertRuntimeStreamHeaders(runtimeRes.headers, appBuildVersion);

  const sessionId = sessionDetail.id;
  const agentRunId = agentRun.id;

  // Mutable turn state shared across the generator below.
  const aggregate = createAgentTurnAggregate();
  const ingestJobError = early.ingestJobError;
  // Runtime response_id + last sequence number, resolved as we read the stream.
  // Synthetic events continue from lastRuntimeSequence + 1 (plan §5.6).
  let runtimeResponseId = `resp_pending_${randomUUID()}`;
  let lastRuntimeSequence = -1;
  let sawRuntimeCreated = false;
  // P1: track whether the runtime emitted a fatal top-level `error` event.
  // Design §5.7 / §12.3: a single scimanage.tool_execution.failed is NOT fatal
  // (the agent can interpret the tool failure and reply normally). Only the
  // canonical `error` event type (model failure / runtime fatal) is fatal, in
  // which case the turn MUST NOT be surfaced as response.completed.
  // We store the value on a const object (mutating a property) so TypeScript
  // preserves a stable property-access type across closures + awaits, instead
  // of widening to `never` after the cross-function mutation.
  const runtimeFatalError = { message: null as string | null };

  // Step 8–12 — event stream.
  const events = (async function* (): AsyncGenerator<AgentStreamEvent, void, unknown> {
    // P1 (defect 3): the entire synthetic tail — CRM follow-up, ingest error,
    // completed, AND the failure-path error/response.failed — shares ONE
    // sequencer instance created after EOF. It is created here (outside the
    // try/catch) so the catch branch reuses the same monotonic counter instead
    // of rebuilding from lastRuntimeSequence (which would reuse/regress
    // sequence numbers already handed out by CRM follow-up / ingest events).
    // Until the stream is drained we don't know lastRuntimeSequence, so the
    // sequencer is assigned in the try block right after EOF. The catch block
    // only reads `seq` if it was already assigned; otherwise it falls back to a
    // fresh sequencer (catastrophic pre-EOF error). See observeRuntimeEvent.
    let seq: SyntheticSequencer | null = null;

    try {
      // Step 8 + 9 — parse + project + yield (SSE is the only transport).
      const decoder = createSseEventDecoder();
      const reader = runtimeRes.body!.getReader();
      try {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const ev of decoder.push(value).events) {
            observeRuntimeEvent(ev);
            projectAgentStreamEvent(aggregate, ev);
            yield ev;
          }
        }
        decoder.flush();
      } finally {
        reader.releaseLock();
      }

      // Step 10 — runtime EOF (NOT a success terminal).
      seq = createSyntheticSequencer(
        runtimeResponseId,
        lastRuntimeSequence,
        sessionId,
        agentRunId,
      );

      // 10a — invoice ingest synthetic error (was historically pre-stream; moved
      // to EOF to preserve canonical created→...→completed ordering).
      if (ingestJobError) {
        for (const ev of buildIngestJobErrorEvents(seq, agentRunId, ingestJobError)) {
          projectAgentStreamEvent(aggregate, ev);
          yield ev;
        }
      }

      // 10b — CRM follow-up. Failures are swallowed so they never block the
      // main reply persistence (mirrors legacy behaviour).
      try {
        for (const ev of await buildCrmFollowUpEvents(seq, aggregate.assistantTimeline, agentRunId, actor)) {
          projectAgentStreamEvent(aggregate, ev);
          yield ev;
        }
      } catch (followUpError) {
        console.error("crm customer context follow-up failed:", followUpError);
      }

      // 10c — persist compact summary (must precede assistant message so the
      // next turn loads the fresh summary).
      if (aggregate.compactSummaryUpdate) {
        try {
          await updateAgentChatSession(actor, sessionId, {
            compactSummary: aggregate.compactSummaryUpdate,
          });
        } catch (compactPersistError) {
          console.error("persist compactSummary failed:", compactPersistError);
        }
      }

      // P1 (defect 1): runtime emitted a fatal `error` event before EOF. The
      // turn is unreliable — model failed mid-stream. Design §12.3: do NOT
      // emit response.completed. We still persist the partial assistant
      // content (same as the existing stop/error 收尾: any text/timeline the
      // model produced before failing is preserved as an assistant message in
      // the `error` state), then emit response.failed carrying the runtime's
      // fatal error message. The error event itself was already yielded above
      // when it arrived, so here we only emit the terminal response.failed.
      if (runtimeFatalError.message !== null) {
        // Capture the message in a const so the value is fixed across the
        // await + seq.next() calls below.
        const fatalErrorMessage = runtimeFatalError.message;
        // Persist the partial assistant message (best-effort; mirrors the
        // existing stop/error 收尾 semantics — failures here surface as a
        // second response.failed, but persistence is not the turn's verdict).
        await persistAssistantMessageOrThrow(actor, aggregate, sessionId, agentRunId).catch(
          (persistError) => {
            console.error("persist partial assistant (fatal) failed:", persistError);
          },
        );
        const failedEvent = seq.next({
          type: "response.failed",
          error: { message: fatalErrorMessage },
        });
        projectAgentStreamEvent(aggregate, failedEvent);
        yield failedEvent;
        return;
      }

      // 10d — persist assistant message. On failure → response.failed (step 12).
      await persistAssistantMessageOrThrow(actor, aggregate, sessionId, agentRunId);

      // Step 11 — emit response.completed ONLY after persistence succeeds.
      const completedEvent = seq.next({
        type: "response.completed",
        status: "completed",
        ...(aggregate.tokenUsage ? { usage: aggregate.tokenUsage as never } : {}),
      });
      projectAgentStreamEvent(aggregate, completedEvent);
      yield completedEvent;
    } catch (error) {
      // Step 12 — failure. Emit error + response.failed reusing the SAME
      // sequencer instance that already produced CRM follow-up / ingest
      // synthetic events (defect 3: never rebuild from lastRuntimeSequence,
      // which would reuse/regress numbers already handed out).
      const message = error instanceof Error ? error.message : "Agent turn failed";
      const failureSeq =
        seq ??
        createSyntheticSequencer(runtimeResponseId, lastRuntimeSequence, sessionId, agentRunId);
      const errorEvent = failureSeq.next({ type: "error", error: { message } });
      projectAgentStreamEvent(aggregate, errorEvent);
      yield errorEvent;
      const failedEvent = failureSeq.next({
        type: "response.failed",
        error: { message },
      });
      projectAgentStreamEvent(aggregate, failedEvent);
      yield failedEvent;
    }
  })();

  function observeRuntimeEvent(ev: AgentStreamEvent) {
    if (!sawRuntimeCreated && ev.type === "response.created") {
      sawRuntimeCreated = true;
      runtimeResponseId = ev.response_id;
    }
    if (ev.sequence_number > lastRuntimeSequence) {
      lastRuntimeSequence = ev.sequence_number;
    }
    // P1 (defect 1): capture the runtime's fatal top-level `error` event.
    // scimanage.tool_execution.failed is intentionally NOT captured here —
    // only the canonical `error` type is fatal (design §5.7).
    if (ev.type === "error" && runtimeFatalError.message === null) {
      runtimeFatalError.message =
        ev.error && typeof ev.error.message === "string" && ev.error.message.length > 0
          ? ev.error.message
          : "Agent runtime failed";
    }
  }

  return {
    sessionId,
    agentRunId,
    responseId: runtimeResponseId,
    events,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Persist the assistant message; on failure throw so the runner's catch block
 * emits response.failed instead of response.completed (design §12.3).
 */
async function persistAssistantMessageOrThrow(
  actor: BusinessActor,
  aggregate: AgentTurnAggregate,
  sessionId: string,
  agentRunId: string,
): Promise<void> {
  if (!aggregate.assistantContent.trim() && aggregate.assistantTimeline.length === 0) {
    return;
  }
  await createAgentChatMessage(actor, {
    sessionId,
    agentRunId,
    role: "assistant",
    content: aggregate.assistantContent.trim() || "Pi runtime returned an empty reply.",
    state: aggregate.assistantState,
    timeline: normalizeTimelineForPersistence(aggregate.assistantTimeline),
    tokenUsage: aggregate.tokenUsage,
  });
}

// Re-exports for route/tests.
export {
  createAgentTurnAggregate,
  projectAgentStreamEvent,
  normalizeTimelineForPersistence,
  type AgentTurnAggregate,
};
export type { AgentStreamEvent };
export { AgentStreamProtocolError };

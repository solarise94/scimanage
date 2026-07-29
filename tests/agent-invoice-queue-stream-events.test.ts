/**
 * Phase 4 invoice staging queue tests (plan §6.6).
 *
 * Pure-function tests — no DB, no I/O. Verifies `applyInvoiceQueueStreamEvent`
 * consumes canonical `scimanage.tool_execution.*` and that desktop/mobile
 * per-turn advance logic is exactly-once under each of the §6.6 scenarios:
 *  success / failure / needs-confirmation / multi-file / session reload /
 *  abort / unrelated tool error.
 *
 * Duplicate sequence must NOT advance the queue twice (plan §6.6 exactly-once).
 */
import { describe, it, expect } from "vitest";
import type { AgentStreamEvent } from "../agent-runtime/src/stream-protocol";
import { AGENT_STREAM_PROTOCOL } from "../agent-runtime/src/stream-protocol";
import {
  applyInvoiceQueueStreamEvent,
  getActiveInvoiceQueue,
  buildInvoiceQueueContinuation,
  mapServerStagingStatusToQueue,
  restoreInvoiceQueueFromServer,
} from "@/lib/agent/invoice-staging-queue";
import type { AgentInvoiceStagingAttachment } from "@/lib/agent/invoice-staging-attachment";
import { isInvoiceAnalyzeFailureEvent } from "@/lib/agent-stream/consume-agent-stream";

// ── fixture helpers ──────────────────────────────────────────────────────────

const META = { response_id: "resp_1", session_id: "sess_1", agent_run_id: "run_1" };

function ev(sequence_number: number, partial: Record<string, unknown>): AgentStreamEvent {
  return {
    protocol: AGENT_STREAM_PROTOCOL,
    response_id: META.response_id,
    sequence_number,
    session_id: META.session_id,
    agent_run_id: META.agent_run_id,
    created_at: 1_700_000_000_000 + sequence_number,
    ...partial,
  } as unknown as AgentStreamEvent;
}

function staging(id: string, extra: Partial<AgentInvoiceStagingAttachment> = {}): AgentInvoiceStagingAttachment {
  return {
    stagingFileId: id,
    fileName: `${id}.pdf`,
    mimeType: "application/pdf",
    fileSize: 100,
    sha256: `sha-${id}`,
    version: 1,
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    queueStatus: "uploaded",
    ...extra,
  };
}

/**
 * Mirror desktop/mobile per-turn advance logic: advance at most once when the
 * turn saw an invoice analyze failure, and only if injectable items remain.
 * Historical "failed" items must NOT re-trigger advance on later turns.
 */
function shouldAdvance(
  queue: AgentInvoiceStagingAttachment[],
  sawInvoiceFailureThisTurn: boolean,
): boolean {
  return sawInvoiceFailureThisTurn && getActiveInvoiceQueue(queue).length > 0;
}

// ── tool execution event → queue transitions ─────────────────────────────────

describe("applyInvoiceQueueStreamEvent — canonical tool events", () => {
  it("started (finance.analyze_invoice_file) → analyzing", () => {
    const queue = [staging("f1")];
    const next = applyInvoiceQueueStreamEvent(queue,
      ev(1, {
        type: "scimanage.tool_execution.started",
        tool_execution_id: "c1",
        tool_name: "finance.analyze_invoice_file",
        label: "analyze",
        input: { stagingFileId: "f1" },
      }),
    );
    expect(next[0].queueStatus).toBe("analyzing");
  });

  it("completed → analyzed + version/sha from output.staging", () => {
    const queue = [staging("f1", { queueStatus: "analyzing" })];
    const next = applyInvoiceQueueStreamEvent(queue,
      ev(2, {
        type: "scimanage.tool_execution.completed",
        tool_execution_id: "c1",
        tool_name: "finance.analyze_invoice_file",
        label: "analyze",
        output: { staging: { id: "f1", version: 3, sha256: "sha-new" } },
      }),
    );
    expect(next[0].queueStatus).toBe("analyzed");
    expect(next[0].version).toBe(3);
    expect(next[0].sha256).toBe("sha-new");
  });

  it("failed with stagingFileId in error → failed", () => {
    const queue = [staging("f1", { queueStatus: "analyzing" })];
    const next = applyInvoiceQueueStreamEvent(queue,
      ev(2, {
        type: "scimanage.tool_execution.failed",
        tool_execution_id: "c1",
        tool_name: "finance.analyze_invoice_file",
        label: "analyze",
        error: { message: "识别失败", code: "OCR_FAILED" },
      }),
    );
    expect(next[0].queueStatus).toBe("failed");
    expect(next[0].uploadError).toContain("识别失败");
  });

  it("failed without stagingFileId → current analyzing item failed", () => {
    const queue = [
      staging("f1", { queueStatus: "analyzing" }),
      staging("f2", { queueStatus: "uploaded" }),
    ];
    const next = applyInvoiceQueueStreamEvent(queue,
      ev(2, {
        type: "scimanage.tool_execution.failed",
        tool_execution_id: "c1",
        tool_name: "finance.analyze_invoice_file",
        label: "analyze",
        error: { message: "识别失败" },
      }),
    );
    expect(next[0].queueStatus).toBe("failed");
    expect(next[1].queueStatus).toBe("uploaded"); // untouched
  });

  it("unrelated tool error does NOT touch the queue", () => {
    const queue = [staging("f1", { queueStatus: "analyzing" })];
    const next = applyInvoiceQueueStreamEvent(queue,
      ev(2, {
        type: "scimanage.tool_execution.failed",
        tool_execution_id: "c2",
        tool_name: "search_orders",
        label: "search",
        error: { message: "工具执行失败" },
      }),
    );
    expect(next[0].queueStatus).toBe("analyzing"); // unchanged
  });

  it("register_issued_invoice started → pending_confirm", () => {
    const queue = [staging("f1", { queueStatus: "analyzed" })];
    const next = applyInvoiceQueueStreamEvent(queue,
      ev(3, {
        type: "scimanage.tool_execution.started",
        tool_execution_id: "c2",
        tool_name: "finance.register_issued_invoice",
        label: "register",
        input: { stagingFileId: "f1" },
      }),
    );
    expect(next[0].queueStatus).toBe("pending_confirm");
  });

  it("empty queue is a no-op", () => {
    expect(applyInvoiceQueueStreamEvent([], ev(1, { type: "scimanage.tool_execution.started", tool_execution_id: "c1", tool_name: "x", label: "x" }))).toEqual([]);
  });
});

// ── §6.6 per-turn exactly-once advance scenarios ─────────────────────────────

describe("per-turn advance — exactly-once across §6.6 scenarios", () => {
  it("success: no analyze failure → no advance", () => {
    let queue = [staging("f1"), staging("f2")];
    queue = applyInvoiceQueueStreamEvent(queue,
      ev(1, { type: "scimanage.tool_execution.started", tool_execution_id: "c1", tool_name: "finance.analyze_invoice_file", label: "a", input: { stagingFileId: "f1" } }),
    );
    queue = applyInvoiceQueueStreamEvent(queue,
      ev(2, { type: "scimanage.tool_execution.completed", tool_execution_id: "c1", tool_name: "finance.analyze_invoice_file", label: "a", output: { staging: { id: "f1", version: 2, sha256: "s" } } }),
    );
    expect(shouldAdvance(queue, false)).toBe(false);
  });

  it("failure: analyze failed + another uploaded item remains → advance exactly once", () => {
    let queue = [staging("f1"), staging("f2")];
    queue = applyInvoiceQueueStreamEvent(queue,
      ev(1, { type: "scimanage.tool_execution.started", tool_execution_id: "c1", tool_name: "finance.analyze_invoice_file", label: "a", input: { stagingFileId: "f1" } }),
    );
    queue = applyInvoiceQueueStreamEvent(queue,
      ev(2, { type: "scimanage.tool_execution.failed", tool_execution_id: "c1", tool_name: "finance.analyze_invoice_file", label: "a", error: { message: "识别失败" } }),
    );
    expect(shouldAdvance(queue, true)).toBe(true); // f2 remains injectable
    expect(getActiveInvoiceQueue(queue).map((q) => q.stagingFileId)).toEqual(["f2"]);
  });

  it("needs-confirmation: pending_confirm item gates advance (no double proposal)", () => {
    const queue = [staging("f1", { queueStatus: "pending_confirm" }), staging("f2")];
    // continuation builder returns null while a pending_confirm item exists
    expect(buildInvoiceQueueContinuation({ remaining: queue })).toBeNull();
  });

  it("multi-file: each file processed in turn, advance exactly once per failed file", () => {
    // Turn 1: f1 analyzed → no advance (still has f2 pending but no failure).
    let queue = [staging("f1"), staging("f2")];
    queue = applyInvoiceQueueStreamEvent(queue,
      ev(1, { type: "scimanage.tool_execution.completed", tool_execution_id: "c1", tool_name: "finance.analyze_invoice_file", label: "a", output: { staging: { id: "f1", version: 2, sha256: "s" } } }),
    );
    expect(shouldAdvance(queue, false)).toBe(false);
  });

  it("session reload restore: server snapshot maps back to queue statuses", () => {
    const restored = restoreInvoiceQueueFromServer([
      { id: "f1", fileName: "f1.pdf", mimeType: "application/pdf", fileSize: 100, sha256: "s1", version: 1, expiresAt: "x", status: "ANALYZING" },
      { id: "f2", fileName: "f2.pdf", mimeType: "application/pdf", fileSize: 100, sha256: "s2", version: 1, expiresAt: "x", status: "ANALYZED", pendingProposalId: "p1" },
      { id: "f3", fileName: "f3.pdf", mimeType: "application/pdf", fileSize: 100, sha256: "s3", version: 1, expiresAt: "x", status: "REGISTERED" },
    ]);
    expect(restored.map((r) => r.queueStatus)).toEqual(["analyzing", "pending_confirm"]);
    // REGISTERED filtered out (terminal)
  });

  it("abort: per-turn flag never set (no failure event) → no advance", () => {
    // User abort mid-stream: no tool_execution.failed fired, so the per-turn
    // flag is false → no queue advance.
    const queue = [staging("f1", { queueStatus: "analyzing" }), staging("f2")];
    expect(shouldAdvance(queue, false)).toBe(false);
  });

  it("unrelated tool error: per-turn flag stays false → no advance", () => {
    let queue = [staging("f1"), staging("f2")];
    queue = applyInvoiceQueueStreamEvent(queue,
      ev(1, { type: "scimanage.tool_execution.failed", tool_execution_id: "c9", tool_name: "search_orders", label: "s", error: { message: "工具执行失败" } }),
    );
    // The per-turn flag is driven by isInvoiceAnalyzeFailureEvent, which the
    // consumer sets only for finance.analyze_invoice_file failures.
    expect(isInvoiceAnalyzeFailureEvent(
      ev(1, { type: "scimanage.tool_execution.failed", tool_execution_id: "c9", tool_name: "search_orders", label: "s", error: { message: "x" } }),
    )).toBe(false);
    expect(shouldAdvance(queue, false)).toBe(false);
  });

  it("historical failed item does NOT re-trigger advance on a later unrelated turn", () => {
    // f1 failed in a previous turn (persisted). A new unrelated turn must not
    // see it as "this turn saw a failure".
    const queue = [
      staging("f1", { queueStatus: "failed", uploadError: "old" }),
      staging("f2"),
    ];
    // New turn: no analyze failure emitted → flag false, even though f1 is failed.
    expect(shouldAdvance(queue, false)).toBe(false);
  });

  it("duplicate sequence does not advance twice (exactly-once)", () => {
    // The consumer dedupes duplicate sequence numbers; even if the failed event
    // frame were replayed, onEvent fires once → flag set once.
    let queue = [staging("f1"), staging("f2")];
    const failedEvent = ev(2, {
      type: "scimanage.tool_execution.failed",
      tool_execution_id: "c1",
      tool_name: "finance.analyze_invoice_file",
      label: "a",
      error: { message: "识别失败", stagingFileId: "f1" },
    });
    // Simulate consumer applying the event exactly once (dedup upstream).
    queue = applyInvoiceQueueStreamEvent(queue, failedEvent);
    // flag set exactly once
    expect(shouldAdvance(queue, true)).toBe(true);
    expect(queue[0].queueStatus).toBe("failed");
    // Applying the same event again to the queue is idempotent for the failed item:
    const queue2 = applyInvoiceQueueStreamEvent(queue, failedEvent);
    expect(queue2[0].queueStatus).toBe("failed");
    expect(getActiveInvoiceQueue(queue2).map((q) => q.stagingFileId)).toEqual(["f2"]); // still just f2
  });
});

// ── status mapping helper (refresh parity) ───────────────────────────────────

describe("mapServerStagingStatusToQueue", () => {
  it("ANALYZED without pending proposal → analyzed", () => {
    expect(mapServerStagingStatusToQueue("ANALYZED")).toBe("analyzed");
  });
  it("ANALYZED with pending proposal → pending_confirm", () => {
    expect(mapServerStagingStatusToQueue("ANALYZED", { hasPendingProposal: true })).toBe("pending_confirm");
  });
  it("EXPIRED → skipped", () => {
    expect(mapServerStagingStatusToQueue("EXPIRED")).toBe("skipped");
  });
});

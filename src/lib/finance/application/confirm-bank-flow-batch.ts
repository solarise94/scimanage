/**
 * Canonical actor-aware bank-flow batch confirm command (T7.4).
 *
 * Shared by Agent `finance.confirm_bank_flow_batch`.
 * Each row creates receipts via T6.5 `createReceiptForActor` with
 * idempotency key sourceWorkspaceId + sourceRowIndex.
 */
import { getAgentProposalStatus } from "@/lib/application/agent-proposals";
import type { BusinessActor, InvocationContext } from "@/lib/application/actor";
import {
  ConflictError,
  ForbiddenError,
  StaleStateError,
} from "@/lib/application/errors";
import {
  WORKSPACE_STATUS,
  updateWorkspaceManifestCAS,
} from "@/lib/agent-task-workspace";
import { AllocationReceiptError } from "@/lib/finance/create-allocation-receipt";
import { createReceiptForActor } from "@/lib/finance/application/create-receipt";
import {
  assertExpectedBankFlowWorkspaceVersion,
  loadBankFlowWorkspaceForActor,
} from "@/lib/finance/application/bank-flow-workspace-access";
import {
  type BankFlowManifest,
  type BankFlowPhase,
} from "@/lib/finance/application/bank-flow-workspace-types";
import { canWriteFinance } from "@/lib/finance/permissions";
import { centsToYuan } from "@/lib/finance/money";
import { ReceiptMissingProfileError } from "@/lib/finance/receipt-profile";

export type ConfirmBankFlowBatchInput = {
  workspaceId: string;
  expectedVersion: number;
  proposalId: string;
};

export type ConfirmBankFlowBatchRowResult = {
  rowIndex: number;
  receiptId?: string;
  error?: string;
};

export type ConfirmBankFlowBatchResult = {
  created: number;
  failed: number;
  skipped: number;
  totalAmountCents: number;
  results: ConfirmBankFlowBatchRowResult[];
};

export type ConfirmBankFlowBatchPreview = {
  title: string;
  summary: string;
  target: { type: "bank_flow_workspace"; id: string };
  displayProps: Record<string, string>;
  proposalInput: {
    workspaceId: string;
    expectedVersion: number;
  };
};

function assertConfirmCapability(actor: BusinessActor): void {
  if (!canWriteFinance(actor.role)) {
    throw new ForbiddenError();
  }
}

/** EXECUTING 且旧 bound proposal 已非 PROCESSING 时，允许生成接管 proposal。 */
async function assertConfirmableOrTakeover(opts: {
  phase: BankFlowPhase;
  boundProposalId: string | null | undefined;
}): Promise<"normal" | "takeover"> {
  if (opts.phase === "MATCHED" || opts.phase === "PARTIAL_FAILED") return "normal";
  if (opts.phase === "EXECUTING") {
    if (opts.boundProposalId) {
      const oldStatus = await getAgentProposalStatus(opts.boundProposalId);
      if (oldStatus === "PROCESSING") {
        throw new ConflictError("WORKSPACE_FROZEN：另一 proposal 正在执行");
      }
    }
    return "takeover";
  }
  throw new ConflictError(`当前 phase=${opts.phase}，无法确认`);
}

function collectConfirmableRows(manifest: BankFlowManifest, mode: "normal" | "takeover") {
  return manifest.rows.filter((r) => {
    if (r.status === "CONFIRMED" || r.status === "SKIPPED") return false;
    if (manifest.phase === "PARTIAL_FAILED" && mode === "normal") {
      return r.status === "FAILED";
    }
    if (r.status === "FAILED") return mode === "takeover";
    return r.status === "MATCHED" || r.status === "AMBIGUOUS_MATCH";
  });
}

function assertExecutablePhase(phase: BankFlowPhase): void {
  if (phase !== "MATCHED" && phase !== "PARTIAL_FAILED" && phase !== "EXECUTING") {
    throw new ConflictError(`当前 phase=${phase}，无法执行`);
  }
}

export async function previewConfirmBankFlowBatchForActor(
  actor: BusinessActor,
  input: Pick<ConfirmBankFlowBatchInput, "workspaceId" | "expectedVersion">,
): Promise<ConfirmBankFlowBatchPreview> {
  assertConfirmCapability(actor);

  const loaded = await loadBankFlowWorkspaceForActor({
    workspaceId: input.workspaceId,
    actorUserId: actor.userId,
  });

  const mode = await assertConfirmableOrTakeover({
    phase: loaded.manifest.phase,
    boundProposalId: loaded.boundProposalId ?? loaded.manifest.boundProposalId,
  });

  assertExpectedBankFlowWorkspaceVersion(loaded.version, input.expectedVersion);

  const readyRows = collectConfirmableRows(loaded.manifest, mode);
  const matchByRow = new Map((loaded.manifest.matchResults || []).map((m) => [m.rowIndex, m]));

  const actionable = readyRows.filter((r) => {
    if (r.status === "FAILED") return true;
    const m = matchByRow.get(r.index);
    return (
      m?.organization &&
      m.selectedCombinationIndex != null &&
      m.combinations?.[m.selectedCombinationIndex]
    );
  });

  const totalAmountCents = actionable.reduce((s, r) => s + Math.max(r.amountCents, 0), 0);
  const titlePrefix = mode === "takeover" ? "恢复并确认银行流水核销" : "确认银行流水核销";

  return {
    title: `${titlePrefix}：${actionable.length} 笔`,
    summary: `将创建 ${actionable.length} 笔回款，合计 ¥${centsToYuan(totalAmountCents).toFixed(2)}。`,
    target: { type: "bank_flow_workspace", id: input.workspaceId },
    displayProps: {
      rowCount: String(actionable.length),
      totalAmount: `¥${centsToYuan(totalAmountCents).toFixed(2)}`,
      ...(mode === "takeover" ? { takeover: "true" } : {}),
    },
    proposalInput: {
      workspaceId: input.workspaceId,
      expectedVersion: input.expectedVersion,
    },
  };
}

export async function confirmBankFlowBatchForActor(
  actor: BusinessActor,
  input: ConfirmBankFlowBatchInput,
  opts: { invocation?: InvocationContext } = {},
): Promise<ConfirmBankFlowBatchResult> {
  assertConfirmCapability(actor);

  const loaded = await loadBankFlowWorkspaceForActor({
    workspaceId: input.workspaceId,
    actorUserId: actor.userId,
  });
  const { proposalId } = input;
  const manifest = loaded.manifest;

  assertExecutablePhase(manifest.phase);

  let working = { ...manifest };
  let version = loaded.version;
  const workspaceId = loaded.workspaceId;

  if (manifest.phase === "MATCHED" || manifest.phase === "PARTIAL_FAILED") {
    assertExpectedBankFlowWorkspaceVersion(version, input.expectedVersion);
    const frozen: BankFlowManifest = {
      ...manifest,
      phase: "EXECUTING",
      boundProposalId: proposalId,
    };
    const cas = await updateWorkspaceManifestCAS({
      workspaceId,
      userId: actor.userId,
      expectedVersion: input.expectedVersion,
      expectedBoundProposalId: null,
      nextBoundProposalId: proposalId,
      manifest: frozen as unknown as Record<string, unknown>,
    });
    if (!cas.ok) throw new StaleStateError("WORKSPACE_VERSION_CONFLICT");
    working = frozen;
    version = cas.newVersion;
  } else if (manifest.phase === "EXECUTING") {
    if (loaded.boundProposalId && loaded.boundProposalId !== proposalId) {
      const oldStatus = await getAgentProposalStatus(loaded.boundProposalId);
      if (oldStatus === "PROCESSING") {
        throw new ConflictError("WORKSPACE_FROZEN：另一 proposal 正在执行");
      }
      const rebound: BankFlowManifest = {
        ...manifest,
        boundProposalId: proposalId,
      };
      const cas = await updateWorkspaceManifestCAS({
        workspaceId,
        userId: actor.userId,
        expectedVersion: loaded.version,
        expectedBoundProposalId: loaded.boundProposalId,
        nextBoundProposalId: proposalId,
        manifest: rebound as unknown as Record<string, unknown>,
      });
      if (!cas.ok) {
        throw new StaleStateError("WORKSPACE_VERSION_CONFLICT：接管失败");
      }
      working = rebound;
      version = cas.newVersion;
    } else if (loaded.boundProposalId === proposalId) {
      working = manifest;
      version = loaded.version;
    } else {
      throw new ConflictError("WORKSPACE_FROZEN");
    }
  }

  const matchByRow = new Map((working.matchResults || []).map((m) => [m.rowIndex, m]));
  const execPrev = new Map((working.executionResults || []).map((e) => [e.rowIndex, e]));

  const candidates = working.rows.filter((r) => {
    if (r.status === "CONFIRMED") return false;
    if (r.status === "SKIPPED") return false;
    if (manifest.phase === "PARTIAL_FAILED" || r.status === "FAILED") {
      return r.status === "FAILED" || execPrev.get(r.index)?.error;
    }
    const m = matchByRow.get(r.index);
    return (
      (r.status === "MATCHED" || r.status === "AMBIGUOUS_MATCH") &&
      m?.organization &&
      m.selectedCombinationIndex != null &&
      m.combinations?.[m.selectedCombinationIndex]
    );
  });

  let created = 0;
  let failed = 0;
  let totalAmountCents = 0;
  const results: ConfirmBankFlowBatchRowResult[] = [
    ...(working.executionResults || []).filter((e) => {
      const row = working.rows.find((r) => r.index === e.rowIndex);
      return row?.status === "CONFIRMED" || Boolean(e.receiptId && !e.error);
    }),
  ];

  const nextRows = [...working.rows];

  for (const row of candidates) {
    const m = matchByRow.get(row.index);
    const combo = m?.combinations?.[m.selectedCombinationIndex ?? -1];
    if (!m?.organization || !combo) {
      failed += 1;
      results.push({ rowIndex: row.index, error: "缺少组织或匹配组合" });
      const idx = nextRows.findIndex((r) => r.index === row.index);
      if (idx >= 0) nextRows[idx] = { ...nextRows[idx], status: "FAILED" };
      continue;
    }

    try {
      const result = await createReceiptForActor(
        actor,
        {
          amountYuan: centsToYuan(row.amountCents),
          receivedAt: row.date,
          source: "BANK",
          remark:
            row.remark ||
            `银行流水导入：${row.payerName}，行 #${row.index}`,
          organizationId: m.organization.id,
          allocations: combo.invoices.map((inv) => ({
            invoiceId: inv.invoiceId,
            amountYuan: centsToYuan(inv.amountCents),
          })),
          sourceWorkspaceId: workspaceId,
          sourceRowIndex: row.index,
        },
        opts,
      );

      created += 1;
      totalAmountCents += row.amountCents;
      results.push({ rowIndex: row.index, receiptId: result.receipt.id });
      const idx = nextRows.findIndex((r) => r.index === row.index);
      if (idx >= 0) nextRows[idx] = { ...nextRows[idx], status: "CONFIRMED" };
    } catch (err) {
      failed += 1;
      const message = err instanceof Error ? err.message : "创建回款失败";
      results.push({ rowIndex: row.index, error: message });
      const idx = nextRows.findIndex((r) => r.index === row.index);
      if (idx >= 0) nextRows[idx] = { ...nextRows[idx], status: "FAILED" };
      if (
        !(err instanceof AllocationReceiptError) &&
        !(err instanceof ReceiptMissingProfileError)
      ) {
        console.error("[bank-flow] row failed", row.index, err);
      }
    }

    const progress: BankFlowManifest = {
      ...working,
      phase: "EXECUTING",
      boundProposalId: proposalId,
      rows: nextRows,
      executionResults: results,
    };
    const progressCas = await updateWorkspaceManifestCAS({
      workspaceId,
      userId: actor.userId,
      expectedVersion: version,
      expectedBoundProposalId: proposalId,
      manifest: progress as unknown as Record<string, unknown>,
    });
    if (!progressCas.ok) {
      throw new StaleStateError("WORKSPACE_VERSION_CONFLICT：执行权已丢失，停止写入");
    }
    version = progressCas.newVersion;
    working = progress;
  }

  const hasFailedRows = nextRows.some((r) => r.status === "FAILED") || failed > 0;
  const hasActionableLeft = nextRows.some(
    (r) =>
      r.status === "MATCHED" ||
      r.status === "AMBIGUOUS_MATCH" ||
      r.status === "AMBIGUOUS_ORG" ||
      r.status === "NO_MATCH" ||
      r.status === "ORG_NOT_FOUND" ||
      r.status === "PENDING",
  );

  if (!hasFailedRows && !hasActionableLeft) {
    const confirmed: BankFlowManifest = {
      ...working,
      phase: "CONFIRMED",
      boundProposalId: undefined,
      rows: nextRows,
      executionResults: results,
    };
    const cas = await updateWorkspaceManifestCAS({
      workspaceId,
      userId: actor.userId,
      expectedVersion: version,
      expectedBoundProposalId: proposalId,
      nextBoundProposalId: null,
      nextStatus: WORKSPACE_STATUS.COMPLETED,
      manifest: confirmed as unknown as Record<string, unknown>,
    });
    if (!cas.ok) {
      throw new StaleStateError("WORKSPACE_VERSION_CONFLICT：终态写入失败");
    }
  } else {
    const partial: BankFlowManifest = {
      ...working,
      phase: "PARTIAL_FAILED",
      boundProposalId: undefined,
      rows: nextRows,
      executionResults: results,
    };
    const cas = await updateWorkspaceManifestCAS({
      workspaceId,
      userId: actor.userId,
      expectedVersion: version,
      expectedBoundProposalId: proposalId,
      nextBoundProposalId: null,
      manifest: partial as unknown as Record<string, unknown>,
    });
    if (!cas.ok) {
      throw new StaleStateError("WORKSPACE_VERSION_CONFLICT：终态写入失败");
    }
  }

  return {
    created,
    failed,
    skipped: nextRows.filter((r) => r.status === "SKIPPED").length,
    totalAmountCents,
    results,
  };
}

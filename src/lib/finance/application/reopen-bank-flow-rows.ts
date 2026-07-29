/**
 * Canonical actor-aware bank-flow row reopen command (T7.3).
 *
 * Shared by Agent `finance.reopen_bank_flow_rows`.
 * Resets FAILED rows to PENDING in PARTIAL_FAILED workspace and returns to MATCHED.
 */
import type { BusinessActor } from "@/lib/application/actor";
import { ForbiddenError, StaleStateError } from "@/lib/application/errors";
import { updateWorkspaceManifestCAS } from "@/lib/agent-task-workspace";
import { canReadFinance } from "@/lib/finance/permissions";
import {
  assertExpectedBankFlowWorkspaceVersion,
  loadBankFlowWorkspaceForActor,
} from "@/lib/finance/application/bank-flow-workspace-access";
import {
  assertBankFlowReopenPhase,
  mapBankFlowPhaseError,
  type BankFlowManifest,
} from "@/lib/finance/application/bank-flow-workspace-types";

export type ReopenBankFlowRowsInput = {
  workspaceId: string;
  rowIndices: number[];
  expectedVersion: number;
};

export type ReopenBankFlowRowsResult = {
  workspaceId: string;
  reopened: number;
  newVersion: number;
};

function assertReopenCapability(actor: BusinessActor): void {
  if (!canReadFinance(actor.role)) {
    throw new ForbiddenError();
  }
}

export async function reopenBankFlowRowsForActor(
  actor: BusinessActor,
  input: ReopenBankFlowRowsInput,
): Promise<ReopenBankFlowRowsResult> {
  assertReopenCapability(actor);

  const loaded = await loadBankFlowWorkspaceForActor({
    workspaceId: input.workspaceId,
    actorUserId: actor.userId,
  });

  try {
    assertBankFlowReopenPhase(loaded.manifest.phase);
  } catch (err) {
    mapBankFlowPhaseError(err);
  }

  assertExpectedBankFlowWorkspaceVersion(loaded.version, input.expectedVersion);

  const reopenSet = new Set(input.rowIndices);
  let reopened = 0;
  const nextRows = loaded.manifest.rows.map((r) => {
    if (!reopenSet.has(r.index)) return r;
    if (r.status !== "FAILED") return r;
    reopened += 1;
    return { ...r, status: "PENDING" as const };
  });

  const nextMatches = (loaded.manifest.matchResults || []).filter((m) => {
    if (!reopenSet.has(m.rowIndex)) return true;
    const row = nextRows.find((r) => r.index === m.rowIndex);
    return row?.status !== "PENDING";
  });

  const next: BankFlowManifest = {
    ...loaded.manifest,
    phase: "MATCHED",
    boundProposalId: undefined,
    rows: nextRows,
    matchResults: nextMatches,
  };

  const cas = await updateWorkspaceManifestCAS({
    workspaceId: loaded.workspaceId,
    userId: actor.userId,
    expectedVersion: input.expectedVersion,
    expectedBoundProposalId: loaded.boundProposalId,
    nextBoundProposalId: null,
    manifest: next as unknown as Record<string, unknown>,
  });
  if (!cas.ok) throw new StaleStateError("WORKSPACE_VERSION_CONFLICT");

  return {
    workspaceId: loaded.workspaceId,
    reopened,
    newVersion: cas.newVersion,
  };
}

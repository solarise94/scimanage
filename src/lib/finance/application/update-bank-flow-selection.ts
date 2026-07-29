/**
 * Canonical actor-aware bank-flow row selection command (T7.2).
 *
 * Shared by Agent `finance.update_bank_flow_selection`.
 */
import type { BusinessActor } from "@/lib/application/actor";
import {
  ForbiddenError,
  NotFoundError,
  StaleStateError,
  ValidationError,
} from "@/lib/application/errors";
import { updateWorkspaceManifestCAS } from "@/lib/agent-task-workspace";
import {
  rematchBankFlowRowWithOrganization,
  type BankFlowMatchResult,
  type BankFlowRowStatus,
} from "@/lib/finance/bank-flow-matcher";
import { canReadFinance } from "@/lib/finance/permissions";
import {
  assertExpectedBankFlowWorkspaceVersion,
  loadBankFlowWorkspaceForActor,
} from "@/lib/finance/application/bank-flow-workspace-access";
import {
  assertBankFlowSelectionPhase,
  mapBankFlowPhaseError,
  type BankFlowManifest,
} from "@/lib/finance/application/bank-flow-workspace-types";

export type UpdateBankFlowSelectionInput = {
  workspaceId: string;
  rowIndex: number;
  organizationId?: string;
  combinationIndex?: number;
  skip?: boolean;
  expectedVersion: number;
};

export type UpdateBankFlowSelectionResult = {
  workspaceId: string;
  updated: boolean;
  row: BankFlowManifest["rows"][number] & { match?: BankFlowMatchResult | null };
  newVersion: number;
};

function assertSelectionCapability(actor: BusinessActor): void {
  if (!canReadFinance(actor.role)) {
    throw new ForbiddenError();
  }
}

export async function updateBankFlowSelectionForActor(
  actor: BusinessActor,
  input: UpdateBankFlowSelectionInput,
): Promise<UpdateBankFlowSelectionResult> {
  assertSelectionCapability(actor);

  const loaded = await loadBankFlowWorkspaceForActor({
    workspaceId: input.workspaceId,
    actorUserId: actor.userId,
  });

  try {
    assertBankFlowSelectionPhase(loaded.manifest.phase);
  } catch (err) {
    mapBankFlowPhaseError(err);
  }

  assertExpectedBankFlowWorkspaceVersion(loaded.version, input.expectedVersion);

  const rowIdx = loaded.manifest.rows.findIndex((r) => r.index === input.rowIndex);
  if (rowIdx < 0) throw new NotFoundError(`row ${input.rowIndex}`);

  const next = {
    ...loaded.manifest,
    rows: [...loaded.manifest.rows],
    matchResults: [...(loaded.manifest.matchResults || [])],
  };
  const row = { ...next.rows[rowIdx] };

  if (input.skip) {
    row.status = "SKIPPED";
    next.rows[rowIdx] = row;
    next.matchResults = next.matchResults.filter((m) => m.rowIndex !== input.rowIndex);
  } else if (input.organizationId) {
    const rematch = await rematchBankFlowRowWithOrganization({
      userId: actor.userId,
      role: actor.role,
      row: {
        index: row.index,
        payerName: row.payerName,
        amountCents: row.amountCents,
        date: row.date,
        remark: row.remark,
      },
      organizationId: input.organizationId,
    });
    if (rematch.status === "ORG_NOT_FOUND") {
      throw new NotFoundError(input.organizationId);
    }

    const match = { ...rematch.match };
    if (input.combinationIndex != null) {
      if (!match.combinations || input.combinationIndex >= match.combinations.length) {
        throw new ValidationError("combinationIndex 超出范围");
      }
      match.selectedCombinationIndex = input.combinationIndex;
    }

    const status: BankFlowRowStatus =
      input.combinationIndex != null && match.organization ? "MATCHED" : rematch.status;

    const mi = next.matchResults.findIndex((m) => m.rowIndex === input.rowIndex);
    if (mi >= 0) next.matchResults[mi] = match;
    else next.matchResults.push(match);
    row.status = status;
    next.rows[rowIdx] = row;
  } else {
    let match = next.matchResults.find((m) => m.rowIndex === input.rowIndex);
    if (!match) {
      throw new ValidationError("该行尚无匹配结果，请先指定 organizationId 或重新 match");
    }
    match = { ...match };
    const mi = next.matchResults.findIndex((m) => m.rowIndex === input.rowIndex);
    next.matchResults[mi] = match;

    if (input.combinationIndex != null) {
      if (!match.combinations || input.combinationIndex >= match.combinations.length) {
        throw new ValidationError("combinationIndex 超出范围");
      }
      match.selectedCombinationIndex = input.combinationIndex;
    }

    if (match.organization && match.selectedCombinationIndex != null) {
      row.status = "MATCHED";
    } else if (match.organization && (match.combinations?.length ?? 0) > 1) {
      row.status = "AMBIGUOUS_MATCH";
    }
    next.rows[rowIdx] = row;
  }

  const cas = await updateWorkspaceManifestCAS({
    workspaceId: loaded.workspaceId,
    userId: actor.userId,
    expectedVersion: input.expectedVersion,
    expectedBoundProposalId: null,
    manifest: next as unknown as Record<string, unknown>,
  });
  if (!cas.ok) throw new StaleStateError("WORKSPACE_VERSION_CONFLICT");

  const updatedMatch = next.matchResults.find((m) => m.rowIndex === input.rowIndex) ?? null;
  return {
    workspaceId: loaded.workspaceId,
    updated: true,
    row: { ...next.rows[rowIdx], match: updatedMatch },
    newVersion: cas.newVersion,
  };
}

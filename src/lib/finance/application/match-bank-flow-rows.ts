/**
 * Canonical actor-aware bank-flow row match command (T7.2).
 *
 * Shared by Agent `finance.match_bank_flow_rows`. Sync path runs matcher and
 * CAS-updates manifest; large batches enqueue async job (phase=MATCHING).
 */
import type { BusinessActor } from "@/lib/application/actor";
import {
  ForbiddenError,
  StaleStateError,
  ValidationError,
} from "@/lib/application/errors";
import { updateWorkspaceManifestCAS } from "@/lib/agent-task-workspace";
import {
  BANK_FLOW_SYNC_MATCH_MAX_ROWS,
  createBankFlowMatchJob,
} from "@/lib/finance/bank-flow-match-job";
import {
  matchBankFlowRows,
  type BankFlowMatchResult,
  type BankFlowMatchSummary,
} from "@/lib/finance/bank-flow-matcher";
import { canReadFinance } from "@/lib/finance/permissions";
import {
  assertExpectedBankFlowWorkspaceVersion,
  loadBankFlowWorkspaceForActor,
} from "@/lib/finance/application/bank-flow-workspace-access";
import {
  assertBankFlowMatchPhase,
  mapBankFlowPhaseError,
  type BankFlowManifest,
} from "@/lib/finance/application/bank-flow-workspace-types";

export type MatchBankFlowRowsInput = {
  workspaceId: string;
  expectedVersion: number;
  rowIndices?: number[];
  async?: boolean;
  agentRunId?: string | null;
};

export type MatchBankFlowRowsSyncResult = {
  mode: "sync";
  workspaceId: string;
  results: BankFlowMatchResult[];
  summary: BankFlowMatchSummary;
  newVersion: number;
  truncated: boolean;
};

export type MatchBankFlowRowsAsyncResult = {
  mode: "async";
  jobId: string;
  workspaceId: string;
  rowCount: number;
  version: number;
  newVersion: number;
  summary: {
    queued: number;
    syncThreshold: number;
  };
};

export type MatchBankFlowRowsResult = MatchBankFlowRowsSyncResult | MatchBankFlowRowsAsyncResult;

const SYNC_DETAIL_LIMIT = 30;

function assertMatchCapability(actor: BusinessActor): void {
  if (!canReadFinance(actor.role)) {
    throw new ForbiddenError();
  }
}

function mapMatchJobError(err: unknown): never {
  if (err && typeof err === "object" && "code" in err) {
    const code = String((err as { code: string }).code);
    if (code === "WORKSPACE_VERSION_CONFLICT") {
      throw new StaleStateError("WORKSPACE_VERSION_CONFLICT");
    }
    if (code === "NO_PENDING_ROWS") {
      throw new ValidationError("没有待匹配的 PENDING 行");
    }
  }
  throw err;
}

export async function matchBankFlowRowsForActor(
  actor: BusinessActor,
  input: MatchBankFlowRowsInput,
): Promise<MatchBankFlowRowsResult> {
  assertMatchCapability(actor);

  const loaded = await loadBankFlowWorkspaceForActor({
    workspaceId: input.workspaceId,
    actorUserId: actor.userId,
  });

  try {
    assertBankFlowMatchPhase(loaded.manifest.phase);
  } catch (err) {
    mapBankFlowPhaseError(err);
  }

  assertExpectedBankFlowWorkspaceVersion(loaded.version, input.expectedVersion);

  const pendingCount = loaded.manifest.rows.filter((r) => {
    if (r.status !== "PENDING" || r.amountCents <= 0) return false;
    if (input.rowIndices && input.rowIndices.length > 0) {
      return input.rowIndices.includes(r.index);
    }
    return true;
  }).length;

  const forceAsync = input.async === true;
  const mustAsync = pendingCount > BANK_FLOW_SYNC_MATCH_MAX_ROWS;
  if (forceAsync || mustAsync) {
    try {
      const job = await createBankFlowMatchJob({
        ownerUserId: actor.userId,
        workspaceId: input.workspaceId,
        expectedVersion: input.expectedVersion,
        rowIndices: input.rowIndices,
        agentRunId: input.agentRunId ?? null,
      });
      return {
        mode: "async",
        jobId: job.jobId,
        workspaceId: job.workspaceId,
        rowCount: job.rowCount || pendingCount,
        version: job.version,
        newVersion: job.version,
        summary: {
          queued: job.rowCount || pendingCount,
          syncThreshold: BANK_FLOW_SYNC_MATCH_MAX_ROWS,
        },
      };
    } catch (err) {
      mapMatchJobError(err);
    }
  }

  const { results, rowUpdates, summary } = await matchBankFlowRows({
    userId: actor.userId,
    role: actor.role,
    rows: loaded.manifest.rows,
    rowIndices: input.rowIndices,
  });

  const statusByIndex = new Map(rowUpdates.map((u) => [u.index, u.status]));
  const nextRows = loaded.manifest.rows.map((r) =>
    statusByIndex.has(r.index) ? { ...r, status: statusByIndex.get(r.index)! } : r,
  );

  const prevMatches = new Map(
    (loaded.manifest.matchResults || []).map((m) => [m.rowIndex, m]),
  );
  for (const m of results) prevMatches.set(m.rowIndex, m);

  const next: BankFlowManifest = {
    ...loaded.manifest,
    phase: "MATCHED",
    matchJobId: null,
    rows: nextRows,
    matchResults: [...prevMatches.values()].sort((a, b) => a.rowIndex - b.rowIndex),
  };

  const cas = await updateWorkspaceManifestCAS({
    workspaceId: loaded.workspaceId,
    userId: actor.userId,
    expectedVersion: input.expectedVersion,
    expectedBoundProposalId: null,
    manifest: next as unknown as Record<string, unknown>,
  });
  if (!cas.ok) throw new StaleStateError("WORKSPACE_VERSION_CONFLICT");

  return {
    mode: "sync",
    workspaceId: loaded.workspaceId,
    results: results.slice(0, SYNC_DETAIL_LIMIT),
    summary,
    newVersion: cas.newVersion,
    truncated: results.length > SYNC_DETAIL_LIMIT,
  };
}

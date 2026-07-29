/**
 * Canonical actor-aware bank-flow column mapping command (T7.1).
 *
 * Re-parses staging with explicit mapping/encoding and CAS-updates workspace manifest.
 * Shared by Agent `finance.apply_bank_flow_mapping`.
 */
import type { BusinessActor } from "@/lib/application/actor";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  StaleStateError,
  ValidationError,
} from "@/lib/application/errors";
import { updateWorkspaceManifestCAS } from "@/lib/agent-task-workspace";
import {
  StagingError,
  getOwnedImportStaging,
  readImportStagingBuffer,
} from "@/lib/import-staging";
import {
  applyBankFlowMapping,
  parseBankFlowFile,
  type BankFlowColumnMapping,
  type BankFlowEncoding,
} from "@/lib/finance/bank-flow-parser";
import { canReadFinance } from "@/lib/finance/permissions";
import {
  assertExpectedBankFlowWorkspaceVersion,
  loadBankFlowWorkspaceForActor,
} from "@/lib/finance/application/bank-flow-workspace-access";
import {
  assertBankFlowMappingPhase,
  mapBankFlowPhaseError,
  previewBankFlowRows,
  type BankFlowManifest,
} from "@/lib/finance/application/bank-flow-workspace-types";

export type ApplyBankFlowMappingInput = {
  workspaceId: string;
  mapping: BankFlowColumnMapping;
  encoding?: BankFlowEncoding extends infer E
    ? E extends "utf-8" | "gb18030" | "utf-8-bom" | "unknown"
      ? "utf-8" | "gb18030"
      : never
    : never;
  expectedVersion: number;
};

export type ApplyBankFlowMappingResult = {
  workspaceId: string;
  rowCount: number;
  columns: string[];
  mapping: BankFlowManifest["mapping"];
  preview: ReturnType<typeof previewBankFlowRows>;
  encoding: BankFlowManifest["encoding"];
  warnings: string[];
  version: number;
  expectedVersion: number;
  newVersion: number;
};

function assertApplyCapability(actor: BusinessActor): void {
  if (!canReadFinance(actor.role)) {
    throw new ForbiddenError();
  }
}

function mapStagingError(err: StagingError): never {
  if (err.httpStatus === 404) {
    throw new NotFoundError(err.message);
  }
  if (err.httpStatus === 410) {
    throw new ConflictError(err.message);
  }
  if (err.httpStatus === 400) {
    throw new ValidationError(err.message);
  }
  throw new ConflictError(err.message);
}

export async function applyBankFlowMappingForActor(
  actor: BusinessActor,
  input: ApplyBankFlowMappingInput,
): Promise<ApplyBankFlowMappingResult> {
  assertApplyCapability(actor);

  const loaded = await loadBankFlowWorkspaceForActor({
    workspaceId: input.workspaceId,
    actorUserId: actor.userId,
  });

  try {
    assertBankFlowMappingPhase(loaded.manifest.phase);
  } catch (err) {
    mapBankFlowPhaseError(err);
  }

  assertExpectedBankFlowWorkspaceVersion(loaded.version, input.expectedVersion);

  let staging;
  try {
    staging = await getOwnedImportStaging({
      stagingFileId: loaded.manifest.stagingFileId,
      userId: actor.userId,
      requireActive: false,
    });
  } catch (err) {
    if (err instanceof StagingError) mapStagingError(err);
    throw err;
  }

  const buffer = await readImportStagingBuffer(staging);
  const parsed = parseBankFlowFile(buffer, staging.originalName, {
    encoding: input.encoding,
  });

  for (const col of [input.mapping.payerName, input.mapping.amount]) {
    if (!parsed.headers.includes(col)) {
      throw new ValidationError(`列「${col}」不存在于表头`);
    }
  }

  const applied = applyBankFlowMapping(parsed, input.mapping);
  const next: BankFlowManifest = {
    ...loaded.manifest,
    phase: "MAPPED",
    encoding: parsed.encoding,
    headers: parsed.headers,
    rowCount: parsed.rowCount,
    mapping: input.mapping,
    rows: applied.rows.map((r) => ({
      index: r.index,
      payerName: r.payerName,
      amountCents: r.amountCents,
      date: r.date,
      remark: r.remark,
      status: r.status,
    })),
    matchResults: undefined,
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
    workspaceId: loaded.workspaceId,
    rowCount: next.rowCount,
    columns: next.headers,
    mapping: next.mapping,
    preview: previewBankFlowRows(next.rows),
    encoding: next.encoding,
    warnings: applied.warnings,
    version: cas.newVersion,
    expectedVersion: cas.newVersion,
    newVersion: cas.newVersion,
  };
}

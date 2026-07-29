/**
 * Canonical actor-aware bank-flow row detail query (T7.2).
 *
 * Shared by Agent `finance.get_bank_flow_row`.
 */
import type { BusinessActor } from "@/lib/application/actor";
import { ForbiddenError, NotFoundError } from "@/lib/application/errors";
import type { BankFlowMatchResult } from "@/lib/finance/bank-flow-matcher";
import { canReadFinance } from "@/lib/finance/permissions";
import { loadBankFlowWorkspaceForActor } from "@/lib/finance/application/bank-flow-workspace-access";
import type { BankFlowManifest } from "@/lib/finance/application/bank-flow-workspace-types";

export type GetBankFlowRowInput = {
  workspaceId: string;
  rowIndex: number;
};

export type GetBankFlowRowResult = {
  workspaceId: string;
  row: BankFlowManifest["rows"][number];
  match: BankFlowMatchResult | null;
  phase: BankFlowManifest["phase"];
  version: number;
};

function assertReadCapability(actor: BusinessActor): void {
  if (!canReadFinance(actor.role)) {
    throw new ForbiddenError();
  }
}

export async function getBankFlowRowForActor(
  actor: BusinessActor,
  input: GetBankFlowRowInput,
): Promise<GetBankFlowRowResult> {
  assertReadCapability(actor);

  const loaded = await loadBankFlowWorkspaceForActor({
    workspaceId: input.workspaceId,
    actorUserId: actor.userId,
  });

  const row = loaded.manifest.rows.find((r) => r.index === input.rowIndex);
  if (!row) throw new NotFoundError(`row ${input.rowIndex}`);

  const match =
    (loaded.manifest.matchResults || []).find((m) => m.rowIndex === input.rowIndex) || null;

  return {
    workspaceId: loaded.workspaceId,
    row,
    match,
    phase: loaded.manifest.phase,
    version: loaded.version,
  };
}

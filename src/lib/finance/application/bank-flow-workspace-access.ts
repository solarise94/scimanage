/**
 * Actor-scoped bank-flow workspace read helpers (AgentTaskWorkspace §1.4).
 */
import {
  WORKSPACE_KIND,
  WORKSPACE_STATUS,
  getOwnedWorkspace,
} from "@/lib/agent-task-workspace";
import { reconcileBankFlowMatchIfNeeded } from "@/lib/finance/bank-flow-match-job";
import {
  ConflictError,
  NotFoundError,
  StaleStateError,
  ValidationError,
} from "@/lib/application/errors";
import {
  parseBankFlowManifest,
  type BankFlowManifest,
} from "@/lib/finance/application/bank-flow-workspace-types";

function mapManifestError(err: unknown): never {
  if (err instanceof Error) {
    if (err.message.includes("manifest")) {
      throw new ValidationError(err.message);
    }
  }
  throw err;
}

/** Shared optimistic-lock check for bank-flow workspace CAS commands (T7.1–T7.3). */
export function assertExpectedBankFlowWorkspaceVersion(
  actualVersion: number,
  expectedVersion: number,
): void {
  if (actualVersion !== expectedVersion) {
    throw new StaleStateError("WORKSPACE_VERSION_CONFLICT");
  }
}

export async function loadBankFlowWorkspaceForActor(opts: {
  workspaceId: string;
  actorUserId: string;
}): Promise<{
  workspaceId: string;
  version: number;
  boundProposalId: string | null;
  manifest: BankFlowManifest;
}> {
  let ws = await getOwnedWorkspace({
    workspaceId: opts.workspaceId,
    userId: opts.actorUserId,
  });
  if (!ws) throw new NotFoundError(opts.workspaceId);
  if (ws.kind !== WORKSPACE_KIND.BANK_FLOW) {
    throw new ValidationError("workspace 类型不是 BANK_FLOW");
  }
  if (ws.status !== WORKSPACE_STATUS.ACTIVE && ws.status !== WORKSPACE_STATUS.COMPLETED) {
    throw new ConflictError(`workspace 状态为 ${ws.status}`);
  }

  let manifest: BankFlowManifest;
  try {
    manifest = parseBankFlowManifest(ws.manifestJson);
  } catch (err) {
    mapManifestError(err);
  }

  if (manifest.phase === "MATCHING" && manifest.matchJobId) {
    await reconcileBankFlowMatchIfNeeded({
      workspaceId: opts.workspaceId,
      ownerUserId: opts.actorUserId,
      matchJobId: manifest.matchJobId,
    });
    const refreshed = await getOwnedWorkspace({
      workspaceId: opts.workspaceId,
      userId: opts.actorUserId,
    });
    if (!refreshed) throw new NotFoundError(opts.workspaceId);
    ws = refreshed;
    try {
      manifest = parseBankFlowManifest(ws.manifestJson);
    } catch (err) {
      mapManifestError(err);
    }
  }

  return {
    workspaceId: ws.id,
    version: ws.version,
    boundProposalId: ws.boundProposalId,
    manifest,
  };
}

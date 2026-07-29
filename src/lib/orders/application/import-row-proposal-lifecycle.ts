/**
 * Domain proposal-lifecycle handler for `orders.import_order_row`.
 *
 * Minimally extracted (unchanged behavior) from the Agent action definition so
 * the transaction client stays server-side and the action only declares a
 * lifecycle key. See migration standard §4.3.2 / T1.1.
 */
import {
  registerProposalLifecycle,
  type ProposalLifecycleHandler,
} from "@/lib/application/proposal-lifecycle";
import {
  AgentActionConflictError,
  AgentActionNotFoundError,
} from "@/lib/agent-actions/errors";
import { DECISION_TYPE, ROW_STATUS } from "@/lib/orders/import-session";

export const IMPORT_ROW_PROPOSAL_LIFECYCLE_KEY = "orders.import_order_row";

type ImportRowPersistInput = {
  sessionId: string;
  rowId: string;
  expectedRowVersion: number;
};

export const importRowProposalLifecycle: ProposalLifecycleHandler = {
  key: IMPORT_ROW_PROPOSAL_LIFECYCLE_KEY,
  async persist(tx, _actor, rawInput, proposalId) {
    const input = rawInput as ImportRowPersistInput;
    // §4.3.2：proposal 创建事务内原子 CONFIRMED_* → PROPOSED。
    // prepareImportRow 已在外层 buildProposal 用全局 prisma 写过 CONFIRMED_*（V0→V0+1），
    // 这里用同一事务的 tx 做带 version 的原子推进；count 0 → 结构化 409，整笔回滚。
    // 注意：本推进【不再 bump version】——PROPOSED 期间行版本必须等于冻结输入里的
    // expectedRowVersion（即 prepared.version），否则 confirm 时 commitImportRow
    // 按冻结版本认领会 0 行 → 永远 409。状态机迁移（CONFIRMED_*→PROPOSED）本身是并发令牌。
    // createAgentProposal 传入的是冻结输入（proposalInput），其 expectedRowVersion
    // 即 prepareImportRow 写入后的 version。
    const row = await tx.orderImportRow.findUnique({
      where: { id: input.rowId },
      select: { version: true, reviewStatus: true, sessionId: true },
    });
    if (!row || row.sessionId !== input.sessionId) {
      throw new AgentActionNotFoundError(input.rowId);
    }
    const claimed = await tx.orderImportRow.updateMany({
      where: {
        id: input.rowId,
        sessionId: input.sessionId,
        version: input.expectedRowVersion,
        reviewStatus: { in: [ROW_STATUS.CONFIRMED_EXISTING, ROW_STATUS.CONFIRMED_CREATE] },
      },
      data: {
        reviewStatus: ROW_STATUS.PROPOSED,
        proposalId,
      },
    });
    if (claimed.count === 0) {
      const fresh = await tx.orderImportRow.findUnique({
        where: { id: input.rowId },
        select: { version: true, reviewStatus: true, proposalId: true },
      });
      const e = new AgentActionConflictError("行状态/版本已变化（ROW_VERSION_CONFLICT），proposal 未创建");
      (e as AgentActionConflictError & { details?: unknown }).details = {
        code: "ROW_VERSION_CONFLICT",
        rowId: input.rowId,
        currentVersion: fresh?.version ?? input.expectedRowVersion,
        currentStatus: fresh?.reviewStatus ?? row.reviewStatus,
        currentProposalId: fresh?.proposalId ?? null,
        retryable: true,
      };
      throw e;
    }
  },
  async revert(tx, _actor, proposal) {
    // §4.3.2：reject 事务内恢复 PROPOSED → 对应 CONFIRMED_*，清 claim，version++。
    // 从 proposal.inputJson 解析 rowId 与决策类型。
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(proposal.inputJson) as Record<string, unknown>;
    } catch {
      parsed = {};
    }
    const rowId = typeof parsed.rowId === "string" ? parsed.rowId : null;
    if (!rowId) return;
    const decisionType =
      typeof parsed.decision === "object" && parsed.decision
        ? ((parsed.decision as Record<string, unknown>).type as string | undefined)
        : undefined;
    const restoreStatus = decisionType === DECISION_TYPE.CREATE_NEW
      ? ROW_STATUS.CONFIRMED_CREATE
      : ROW_STATUS.CONFIRMED_EXISTING;
    await tx.orderImportRow.updateMany({
      where: { proposalId: proposal.id, reviewStatus: ROW_STATUS.PROPOSED },
      data: {
        reviewStatus: restoreStatus,
        proposalId: null,
        claimStartedAt: null,
        claimRunId: null,
        version: { increment: 1 },
      },
    });
  },
};

export function registerImportRowProposalLifecycle(): void {
  registerProposalLifecycle(importRowProposalLifecycle);
}

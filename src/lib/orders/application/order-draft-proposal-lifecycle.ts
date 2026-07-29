/**
 * Phase C (P0-2 修复): order-draft proposal lifecycle handler。
 *
 * 绑定到 orders.create_from_draft action（proposalLifecycleKey）。
 *
 * - persist（proposal 创建事务内）：锁定草稿——把 status 从 DRAFT 改为 PROPOSED，
 *   带版本乐观锁。若草稿已是 PROPOSED/CONSUMED 或版本不匹配 → 409，整笔回滚，
 *   不产生第二个 pending proposal（防重复落单）。
 * - revert（reject/confirm 失败/超时回收）：草稿从 PROPOSED 回 DRAFT，可重新提案。
 * - confirm 成功：createOrderFromDraftForActor 在最终写事务内标 CONSUMED（与订单原子）。
 *
 * 注意：真正的订单写入在 execute（createOrderFromDraftForActor）内；lifecycle 只管
 * persist/revert 草稿状态机，不单独开第二笔消费事务。
 */
import {
  registerProposalLifecycle,
  type ProposalLifecycleHandler,
} from "@/lib/application/proposal-lifecycle";
import { AgentActionConflictError, AgentActionNotFoundError } from "@/lib/agent-actions/errors";

export const ORDER_DRAFT_PROPOSAL_LIFECYCLE_KEY = "orders.create_from_draft";

type OrderDraftPersistInput = {
  orderDraftId: string;
  expectedVersion: number;
};

export const orderDraftProposalLifecycle: ProposalLifecycleHandler = {
  key: ORDER_DRAFT_PROPOSAL_LIFECYCLE_KEY,
  async persist(tx, _actor, rawInput, _proposalId) {
    const input = rawInput as OrderDraftPersistInput;
    if (!input?.orderDraftId) {
      throw new AgentActionNotFoundError("orderDraftId");
    }
    // 锁定草稿：DRAFT + 版本匹配 → PROPOSED。带条件的 updateMany 保证原子；
    // count=0 表示草稿已被改/已 PROPOSED/已 CONSUMED → 409，整笔回滚。
    const claimed = await tx.orderDraft.updateMany({
      where: {
        id: input.orderDraftId,
        status: "DRAFT",
        version: input.expectedVersion,
      },
      data: { status: "PROPOSED" },
    });
    if (claimed.count === 0) {
      const fresh = await tx.orderDraft.findUnique({
        where: { id: input.orderDraftId },
        select: { version: true, status: true },
      });
      if (!fresh) throw new AgentActionNotFoundError(input.orderDraftId);
      throw new AgentActionConflictError(
        `草稿已被锁定或版本已变更（当前 status=${fresh.status}, version=${fresh.version}）`,
      );
    }
  },
  async revert(tx, _actor, proposal) {
    // proposal.inputJson 是冻结输入；草稿从 PROPOSED 回 DRAFT（带状态条件，避免误改 CONSUMED）。
    try {
      const input = JSON.parse(proposal.inputJson) as Partial<OrderDraftPersistInput>;
      if (input.orderDraftId) {
        await tx.orderDraft.updateMany({
          where: { id: input.orderDraftId, status: "PROPOSED" },
          data: { status: "DRAFT" },
        });
      }
    } catch {
      // inputJson 解析失败不阻塞 revert
    }
  },
};

let registered = false;
export function ensureOrderDraftProposalLifecycleRegistered(): void {
  if (registered) return;
  registered = true;
  registerProposalLifecycle(orderDraftProposalLifecycle);
}

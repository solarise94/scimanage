/**
 * Domain proposal-lifecycle handler for `projects.add_note`.
 *
 * Minimally extracted (unchanged behavior) from the Agent action definition so
 * the transaction client stays server-side and the action only declares a
 * lifecycle key. See migration standard §4.3.2 / T1.1.
 */
import {
  registerProposalLifecycle,
  type ProposalLifecycleHandler,
} from "@/lib/application/proposal-lifecycle";
import { AgentActionInputError } from "@/lib/agent-actions/errors";
import {
  assertAttachmentInCurrentRun,
  assertAttachmentInCurrentSession,
  extendAttachmentTtlForActiveRoute,
} from "@/lib/agent-attachments/staging";
import { projectNoteItemRouteKey } from "@/lib/agent-attachments/routes";

export const NOTE_ATTACHMENT_PROPOSAL_LIFECYCLE_KEY = "projects.add_note";

type NoteAttachmentPersistInput = {
  attachments: Array<{
    stagingFileId: string;
    expectedSha256: string;
    expectedVersion: number;
  }>;
};

export const noteAttachmentProposalLifecycle: ProposalLifecycleHandler = {
  key: NOTE_ATTACHMENT_PROPOSAL_LIFECYCLE_KEY,
  /**
   * proposal 创建事务内：为每个附件建立 PROJECT_NOTE 路由（proposalItemKey 逐文件唯一）并延长 TTL。
   * 影响行数为 0（附件已变化/过期）时抛 409，整笔事务回滚，不留孤儿 proposal。
   */
  async persist(tx, actor, rawInput, proposalId) {
    const input = rawInput as NoteAttachmentPersistInput;
    for (const att of input.attachments) {
      const staging = await tx.agentAttachmentStagingFile.findUnique({
        where: { id: att.stagingFileId },
        select: { id: true, ownerUserId: true, sha256: true, version: true, expiresAt: true, status: true, agentRunId: true, chatSessionId: true },
      });
      if (
        !staging
        || staging.ownerUserId !== actor.userId
        || staging.sha256 !== att.expectedSha256
        || staging.version !== att.expectedVersion
        || staging.expiresAt.getTime() <= Date.now()
        || staging.status === "EXPIRED" || staging.status === "FAILED"
      ) {
        throw new AgentActionInputError("ATTACHMENT_CHANGED：附件在生成 proposal 后已变化，请重新检查");
      }
      // P1#2：事务内再次强校验 run/session（防 buildProposal 与 persist 之间被改）。
      assertAttachmentInCurrentRun(staging, actor.agentRunId);
      assertAttachmentInCurrentSession(staging, actor.chatSessionId);
      await tx.agentAttachmentRoute.create({
        data: {
          stagingId: staging.id,
          sourceProposalId: proposalId,
          proposalItemKey: projectNoteItemRouteKey(proposalId, staging.id),
          targetType: "PROJECT_NOTE",
          state: "PENDING",
          expectedSha256: att.expectedSha256,
          expectedVersion: att.expectedVersion,
        },
      });
      await extendAttachmentTtlForActiveRoute({ tx, stagingId: staging.id });
    }
  },
};

export function registerNoteAttachmentProposalLifecycle(): void {
  registerProposalLifecycle(noteAttachmentProposalLifecycle);
}

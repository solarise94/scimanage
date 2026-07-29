import { prisma } from "@/lib/prisma";
import { buildInvocationContext, resolveCurrentBusinessActor, resolveUserRoleById } from "@/lib/application/actor";
import type { AgentExecutionContext, BusinessActor } from "@/lib/application/actor";
import { getProposalLifecycle } from "@/lib/application/proposal-lifecycle";
import { appendConfirmedProposalChatEvent } from "@/lib/application/agent-proposal-chat-events";
import { consumeConfirmationEventForProposal } from "@/lib/application/agent-confirmation-events";
import { AgentActionConflictError, AgentActionForbiddenError, AgentActionInputError, AgentActionNeedsConfirmationError, AgentActionNotFoundError } from "@/lib/agent-actions/errors";
import { createAgentActionLog, writeAgentActionLog } from "@/lib/agent-actions/logs";
import { executeAgentAction, getAgentAction } from "@/lib/agent-actions/registry";
import type { AgentActionProposalRecord } from "@/lib/agent-actions/types";

function parseStoredObject(value: string, label: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(label);
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new AgentActionInputError(`${label} is invalid`);
  }
}

function parseStoredJson(value: string | null) {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

export function mapAgentProposalRecord(proposal: {
  id: string;
  userId: string;
  agentRunId: string | null;
  actionKey: string;
  title: string;
  summary: string;
  riskLevel: string;
  status: string;
  inputJson: string;
  resultJson: string | null;
  error: string | null;
  targetType: string | null;
  targetId: string | null;
  displayPropsJson: string | null;
  publicToolKey?: string | null;
  createdAt: Date;
  updatedAt: Date;
  decidedAt: Date | null;
}): AgentActionProposalRecord {
  let displayProps: Record<string, string | null> | undefined;
  if (proposal.displayPropsJson) {
    try {
      const parsed = JSON.parse(proposal.displayPropsJson) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        displayProps = Object.fromEntries(
          Object.entries(parsed as Record<string, unknown>)
            // P1#2 层 B：过滤内部元数据键（__chatSessionId 等），不暴露给 UI。
            .filter(([k]) => !k.startsWith("__"))
            .map(([k, v]) => [
              k,
              typeof v === "string" ? v : v === null ? null : String(v),
            ]),
        ) as Record<string, string | null>;
      }
    } catch {
      displayProps = undefined;
    }
  }
  return {
    id: proposal.id,
    userId: proposal.userId,
    agentRunId: proposal.agentRunId,
    actionKey: proposal.actionKey,
    title: proposal.title,
    summary: proposal.summary,
    riskLevel: proposal.riskLevel as AgentActionProposalRecord["riskLevel"],
    status: proposal.status,
    input: parseStoredObject(proposal.inputJson, "proposal input"),
    result: parseStoredJson(proposal.resultJson),
    error: proposal.error,
    targetType: proposal.targetType,
    targetId: proposal.targetId,
    displayProps,
    publicToolKey: proposal.publicToolKey ?? null,
    createdAt: proposal.createdAt.toISOString(),
    updatedAt: proposal.updatedAt.toISOString(),
    decidedAt: proposal.decidedAt?.toISOString() ?? null,
  };
}

/**
 * 只读某 proposal 的当前 status（不做所有权校验）。
 *
 * 用于 workspace fencing：判断旧 bound proposal 是否仍 PROCESSING。
 * 让 adapter 无需直连 Prisma。AgentProposal 为 Agent 自身模型（§1.4）。
 */
export async function getAgentProposalStatus(proposalId: string): Promise<string | null> {
  const proposal = await prisma.agentProposal.findUnique({
    where: { id: proposalId },
    select: { status: true },
  });
  return proposal?.status ?? null;
}

export async function listAgentProposals(actor: BusinessActor, status?: string) {
  const proposals = await prisma.agentProposal.findMany({
    where: {
      userId: actor.userId,
      ...(status ? { status } : {}),
    },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    take: 50,
  });

  return proposals.map(mapAgentProposalRecord);
}

export async function createAgentProposal(ctx: AgentExecutionContext, actionKey: string, rawInput: unknown) {
  const action = getAgentAction(actionKey);
  if (!action) {
    throw new AgentActionNotFoundError(actionKey);
  }
  if (action.riskLevel !== "confirm") {
    throw new AgentActionInputError(`${actionKey} is not a confirm action`);
  }

  const available = await action.availability(ctx.actor);
  if (!available) {
    throw new AgentActionForbiddenError();
  }
  if (!action.buildProposal) {
    throw new AgentActionInputError(`${actionKey} does not support proposals`);
  }

  const input = action.parseInput(rawInput);
  const proposal = await action.buildProposal(ctx, input);

  // 串行化：部分 confirm action 要求"同一时间最多一个 PENDING/PROCESSING proposal"。
  // 例如 finance.submit_invoice_request 的逐张确认编排：模型重试、重复工具调用或并发
  // API 请求都不能绕过该约束。由 action 声明 `serialByUser=true` 启用。
  //
  // 原子性：写入唯一字段 serialActiveKey=`${userId}::${actionKey}`。
  // 第二个并发 create 会命中 P2002，而不是依赖 findFirst+create 的竞态窗口。
  // 终态（CONFIRMED/FAILED/REJECTED）必须清掉该键，见 confirm/reject 路由。
  const serialActiveKey = action.serialByUser
    ? buildSerialActiveKey(ctx.actor.userId, action.key)
    : null;

  if (serialActiveKey) {
    // 先回收超时卡死的 PROCESSING，避免进程崩溃后永久占用唯一键
    await recoverStaleProcessingProposals({
      userId: ctx.actor.userId,
      actionKey: action.key,
    });

    const existing = await prisma.agentProposal.findFirst({
      where: {
        userId: ctx.actor.userId,
        actionKey: action.key,
        status: { in: ["PENDING", "PROCESSING"] },
      },
      select: { id: true, title: true, createdAt: true },
      orderBy: { createdAt: "desc" },
    });
    if (existing) {
      throw new AgentActionConflictError(
        `已有未完成的「${action.title}」待确认（${existing.title}），请先确认或拒绝后再创建新的。`,
      );
    }
  }

  let created;
  // §4.3.2：proposal 创建与领域状态持久化（persistProposalState）在同一事务中完成。
  // 若 persistProposalState 抛错（如 row version 冲突），整笔回滚，不留孤儿 proposal。
  //
  // P1-3 allowProposal gate（docs/agent-public-surface-cleanup-plan §六 P1-3）：
  // 【作用域：仅 public tool 路径（invocation.publicToolKey 非空）】。
  // public executor 执行 propose_* 等 public facade 时会把 publicToolKey 注入 invocation
  // （dynamic bundle 链路，runtime 经 execute-public 桥接调用）——此时模型驱动的
  // proposal 创建必须先在同事务内消费一个由浏览器 UI 经 NextAuth 颁发的
  // AgentUserConfirmationEvent。
  //
  // 不覆盖的路径（有意）：
  //  - channel="web"（GenUI 点击本身就是可信用户动作）；
  //  - 静态 /chat-stream 与 legacy /api/agent/chat 的 internal confirm action
  //    （无 publicToolKey）：这些路径的 ProposalCard 确认按钮就是既有的用户确认 UX，
  //    flag OFF 时行为必须字节级不变（2026-07-27 回归修复：初版按 channel==="agent"
  //    拦截，误伤了 runtime 桥接与浏览器 run 绑定调用，导致静态路径提案全灭）。
  //
  // consume 失败（无事件 / 已消费 / 跨 run / targetIntent 不匹配）
  // → 抛 AgentActionNeedsConfirmationError(409, NEEDS_USER_CONFIRMATION)，整事务回滚，
  // 不产生半消费状态。targetIntent 用 action.key（与 UI mint 时约定的 confirm actionKey 一致）。
  const requireConfirmationEvent =
    ctx.invocation.channel === "agent" && Boolean(ctx.invocation.publicToolKey);
  const agentRunIdForGate = ctx.invocation.agentRunId ?? null;
  const createInTx = () =>
    prisma.$transaction(async (tx) => {
      if (requireConfirmationEvent) {
        if (!agentRunIdForGate) {
          // agent channel 必须贯穿 runId；缺失 = 配置 bug，fail-closed。
          // targetIntent 透出（P1-3 UI 接线）：让前端卡片知道要 mint 哪个 confirm actionKey。
          throw new AgentActionNeedsConfirmationError(undefined, action.key);
        }
        const consumed = await consumeConfirmationEventForProposal(tx, {
          actorUserId: ctx.actor.userId,
          agentRunId: agentRunIdForGate,
          targetIntent: action.key,
        });
        if (!consumed) {
          // consume 失败（无事件 / 已消费 / 跨 run / targetIntent 不匹配）：
          // 同样透出 action.key 作为 targetIntent，引导用户去界面 mint 匹配事件后重试。
          throw new AgentActionNeedsConfirmationError(undefined, action.key);
        }
      }
      // P1#2 层 B：把 chatSessionId 随 proposal 持久化（复用 displayPropsJson 元数据包，
      // 避免改 schema 停服迁移）。confirm 时从该键恢复，注入 actor 用于 add_note 的 session 校验。
      const displayPropsWithSession: Record<string, string | null> = { ...(proposal.displayProps ?? {}) };
      if (ctx.invocation.chatSessionId) {
        displayPropsWithSession.__chatSessionId = ctx.invocation.chatSessionId;
      }
      const row = await tx.agentProposal.create({
        data: {
          userId: ctx.actor.userId,
          agentRunId: ctx.invocation.agentRunId ?? null,
          actionKey: action.key,
          title: proposal.title,
          summary: proposal.summary,
          riskLevel: action.riskLevel,
          inputJson: JSON.stringify(proposal.proposalInput ?? input),
          status: "PENDING",
          targetType: proposal.target?.type ?? null,
          targetId: proposal.target?.id ?? null,
          // 受控元数据：仅来自 invocation（public executor 注入），不来自模型输入。
          publicToolKey: ctx.invocation.publicToolKey ?? null,
          displayPropsJson: Object.keys(displayPropsWithSession).length > 0
            ? JSON.stringify(displayPropsWithSession)
            : null,
          serialActiveKey,
        },
      });
      const lifecycle = getProposalLifecycle(action.proposalLifecycleKey);
      if (lifecycle?.persist) {
        // 必须传冻结输入（proposalInput ?? input）而非原始 parsed input：
        // buildProposal 可能已推进领域状态（如 import_order_row 的 prepareImportRow
        // version++），冻结输入里的 expectedRowVersion 才是 persist/execute 应看到的值。
        // 传原始 input 会导致 persist 按旧 version 认领 0 行 → 409 回滚，proposal 永远建不成。
        await lifecycle.persist(
          tx,
          // P1#2 层 B：identity + invocation（run/session）供 add_note 等 lifecycle 校验
          { ...ctx.actor, agentRunId: ctx.invocation.agentRunId, chatSessionId: ctx.invocation.chatSessionId },
          (proposal.proposalInput ?? input) as Record<string, unknown>,
          row.id,
        );
      }
      return row;
    });

  try {
    created = await createInTx();
  } catch (err) {
    if (serialActiveKey && isPrismaUniqueConstraintViolation(err)) {
      // 可能是超时 PROCESSING 仍占键：回收后若已清空则重试一次 create
      const recovered = await recoverStaleProcessingProposals({
        userId: ctx.actor.userId,
        actionKey: action.key,
      });
      if (recovered > 0) {
        try {
          created = await createInTx();
        } catch (retryErr) {
          if (!isPrismaUniqueConstraintViolation(retryErr)) throw retryErr;
          // fall through to conflict below
          created = undefined;
        }
      }
      if (!created) {
        const raced = await prisma.agentProposal.findFirst({
          where: {
            userId: ctx.actor.userId,
            actionKey: action.key,
            status: { in: ["PENDING", "PROCESSING"] },
          },
          select: { title: true },
          orderBy: { createdAt: "desc" },
        });
        throw new AgentActionConflictError(
          raced
            ? `已有未完成的「${action.title}」待确认（${raced.title}），请先确认或拒绝后再创建新的。`
            : `已有未完成的「${action.title}」待确认，请先确认或拒绝后再创建新的。`,
        );
      }
    } else {
      throw err;
    }
  }

  await createAgentActionLog(ctx, action, {
    status: "PROPOSED",
    input,
    proposalId: created.id,
    target: proposal.target,
  });

  return mapAgentProposalRecord(created);
}

/** PROCESSING 超过此时长且无 heartbeat 视为租约过期，可自动 FAILED 并释放 serialActiveKey。 */
export const PROCESSING_STALE_MS = 5 * 60 * 1000;

/** confirm 执行期间刷新 updatedAt 的间隔，避免长任务被误回收。 */
export const PROCESSING_HEARTBEAT_MS = 60 * 1000;

export function newProcessingLeaseToken(): string {
  return `lease_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * 仅当 status=PROCESSING 且 leaseToken 匹配时写入终态。
 * 超时回收会清掉 token，旧 worker 因此失去提交资格（count=0）。
 */
export async function finalizeProcessingProposal(opts: {
  proposalId: string;
  leaseToken: string;
  data: {
    status: "CONFIRMED" | "FAILED";
    resultJson?: string | null;
    error?: string | null;
    targetType?: string | null;
    targetId?: string | null;
  };
}): Promise<{ ok: true; proposal: NonNullable<Awaited<ReturnType<typeof prisma.agentProposal.findUnique>>> } | { ok: false }> {
  const result = await prisma.agentProposal.updateMany({
    where: {
      id: opts.proposalId,
      status: "PROCESSING",
      processingLeaseToken: opts.leaseToken,
    },
    data: {
      status: opts.data.status,
      resultJson: opts.data.resultJson ?? undefined,
      error: opts.data.error ?? null,
      targetType: opts.data.targetType === undefined ? undefined : opts.data.targetType,
      targetId: opts.data.targetId === undefined ? undefined : opts.data.targetId,
      decidedAt: new Date(),
      serialActiveKey: null,
      processingLeaseToken: null,
    },
  });
  if (result.count === 0) return { ok: false };
  const proposal = await prisma.agentProposal.findUnique({ where: { id: opts.proposalId } });
  if (!proposal) return { ok: false };
  return { ok: true, proposal };
}

/**
 * 回收超时卡死的 PROCESSING proposal（进程崩溃、claim 后未写终态等）。
 * 通过清 processingLeaseToken 使仍在跑的旧 worker 无法再提交终态。
 * 每条回收写入 AgentActionLog（PROCESSING_LEASE_EXPIRED）。
 * 返回回收条数。
 */
export async function recoverStaleProcessingProposals(opts: {
  userId: string;
  actionKey?: string;
  proposalId?: string;
}): Promise<number> {
  const cutoff = new Date(Date.now() - PROCESSING_STALE_MS);
  const candidates = await prisma.agentProposal.findMany({
    where: {
      userId: opts.userId,
      status: "PROCESSING",
      updatedAt: { lt: cutoff },
      ...(opts.actionKey ? { actionKey: opts.actionKey } : {}),
      ...(opts.proposalId ? { id: opts.proposalId } : {}),
    },
    select: {
      id: true,
      userId: true,
      agentRunId: true,
      actionKey: true,
      riskLevel: true,
      inputJson: true,
      processingLeaseToken: true,
      targetType: true,
      targetId: true,
    },
  });

  let recovered = 0;
  for (const row of candidates) {
    const updated = await prisma.agentProposal.updateMany({
      where: {
        id: row.id,
        status: "PROCESSING",
        updatedAt: { lt: cutoff },
        // 令牌匹配（含 null：旧数据无令牌时仍可按 id+status+updatedAt 回收）
        processingLeaseToken: row.processingLeaseToken,
      },
      data: {
        status: "FAILED",
        error: "处理超时或进程中断，串行锁已释放，请重试",
        decidedAt: new Date(),
        serialActiveKey: null,
        processingLeaseToken: null,
      },
    });
    if (updated.count === 0) continue;
    recovered += 1;
    // 回收为 FAILED 的同时回滚领域状态（§4.3.2）：如 import row 停在 PROPOSED
    // 且挂着该 proposalId，不回滚将永远无法再生成 proposal。
    // revert 内部按 proposalId+PROPOSED 条件更新：若行实际已 IMPORTED
    // （业务事务已提交、仅 finalize 崩溃）则 0 行 no-op，天然安全。
    const staleAction = getAgentAction(row.actionKey);
    const staleLifecycle = getProposalLifecycle(staleAction?.proposalLifecycleKey);
    if (staleLifecycle?.revert) {
      try {
        // 业务模型读取走 application/actor canonical 入口（T9.1a）
        const staleRole = await resolveUserRoleById(row.userId);
        await prisma.$transaction((tx) =>
          staleLifecycle.revert!(
            tx,
            { userId: row.userId, role: staleRole ?? "USER", agentRunId: row.agentRunId },
            { id: row.id, actionKey: row.actionKey, inputJson: row.inputJson },
          ),
        );
      } catch {
        // 回收兜底：回滚失败不阻断串行锁释放，行状态由人工/后续回收处理
      }
    }
    try {
      // AgentActionLog 统一写入入口（T9.1a：原为直连 prisma.agentActionLog.create）
      await writeAgentActionLog({
        userId: row.userId,
        agentRunId: row.agentRunId,
        actionKey: row.actionKey,
        riskLevel: row.riskLevel,
        status: "PROCESSING_LEASE_EXPIRED",
        input: JSON.parse(row.inputJson || "{}"),
        error: "处理超时或进程中断，串行锁已释放，请重试",
        proposalId: row.id,
        target: row.targetType ? { type: row.targetType, id: row.targetId } : null,
      });
    } catch {
      // 审计日志失败不影响回收本身
    }
  }
  return recovered;
}

/** serialByUser 活跃唯一键：同一用户同一 action 同时最多一条 PENDING/PROCESSING。 */
export function buildSerialActiveKey(userId: string, actionKey: string): string {
  return `${userId}::${actionKey}`;
}

function isPrismaUniqueConstraintViolation(err: unknown): boolean {
  return !!err && typeof err === "object" && (err as { code?: string }).code === "P2002";
}

export async function getAgentProposalForActor(actor: BusinessActor, proposalId: string) {
  const proposal = await prisma.agentProposal.findUnique({
    where: { id: proposalId },
  });

  if (!proposal || proposal.userId !== actor.userId) {
    throw new AgentActionForbiddenError("Proposal not found");
  }

  return proposal;
}

/**
 * Update a PENDING proposal's input.
 *
 * Constraints (design doc §6.6):
 * 1. Only the proposal owner may modify.
 * 2. Only PENDING proposals can be updated.
 * 3. Re-runs parseInput() on the new raw input.
 * 4. Re-runs buildProposal() including CRM scope and target object checks.
 * 5. Updates inputJson, title, summary, target.
 * 6. Writes AgentActionLog with status PROPOSAL_UPDATED.
 * 7. Target changes re-check visibility; old target is never carried over.
 */
export async function updateAgentProposal(
  ctx: AgentExecutionContext,
  proposalId: string,
  rawInput: unknown,
) {
  const existing = await getAgentProposalForActor(ctx.actor, proposalId);

  if (existing.status !== "PENDING") {
    throw new AgentActionInputError("Only PENDING proposals can be updated");
  }

  const action = getAgentAction(existing.actionKey);
  if (!action) {
    throw new AgentActionNotFoundError(existing.actionKey);
  }
  if (!action.buildProposal) {
    throw new AgentActionInputError(`${existing.actionKey} does not support proposals`);
  }

  const available = await action.availability(ctx.actor);
  if (!available) {
    throw new AgentActionForbiddenError();
  }

  // Re-parse and re-build proposal (re-checks CRM scope + target visibility)
  const input = action.parseInput(rawInput);
  const proposalDescriptor = await action.buildProposal(ctx, input);

  // ── Atomic conditional update: only succeeds if still PENDING ──
  // Prevents race with concurrent confirm/reject.
  const claimed = await prisma.agentProposal.updateMany({
    where: {
      id: proposalId,
      userId: ctx.actor.userId,
      status: "PENDING",
    },
    data: {
      title: proposalDescriptor.title,
      summary: proposalDescriptor.summary,
      inputJson: JSON.stringify(proposalDescriptor.proposalInput ?? input),
      targetType: proposalDescriptor.target?.type ?? null,
      targetId: proposalDescriptor.target?.id ?? null,
      displayPropsJson: proposalDescriptor.displayProps ? JSON.stringify(proposalDescriptor.displayProps) : null,
    },
  });

  if (claimed.count === 0) {
    throw new AgentActionConflictError("该操作已处理或正在处理中，无法修改");
  }

  const updated = await prisma.agentProposal.findUnique({
    where: { id: proposalId },
  });
  if (!updated) {
    throw new AgentActionInputError("Proposal not found after update");
  }

  await createAgentActionLog(ctx, action, {
    status: "PROPOSAL_UPDATED",
    input,
    proposalId: updated.id,
    target: proposalDescriptor.target,
  });

  return mapAgentProposalRecord(updated);
}

export type ConfirmAgentProposalResult = {
  proposal: AgentActionProposalRecord;
  result: unknown;
};

/**
 * Claim → execute → finalize a PENDING proposal (T1.1 runtime proposal service).
 *
 * Fixed order (§1.4): authenticated actor in → refresh current actor
 * (resolveCurrentBusinessActor, live User.role) → proposal ownership + atomic
 * PENDING→PROCESSING lease claim → canonical action execute → terminal state +
 * action log. Failures distinguish retryable (lease lost / claim conflict) from
 * terminal (FAILED + domain lifecycle revert). Idempotency for the business
 * command is still keyed off proposalId inside execute, not the claim.
 */
export async function confirmAgentProposal(
  ctx: AgentExecutionContext,
  proposalId: string,
): Promise<ConfirmAgentProposalResult> {
  if (!proposalId) {
    throw new AgentActionInputError("proposal id is required");
  }

  // 刷新当前 actor：使用 DB 中实时 role/存在性，不长期信任 session 快照。
  const baseActor = await refreshActorForProposal(ctx.actor);

  // 进入确认前先回收本用户超时 PROCESSING，避免串行键永久占用
  await recoverStaleProcessingProposals({ userId: baseActor.userId });

  const proposal = await getAgentProposalForActor(baseActor, proposalId);

  if (proposal.status !== "PENDING") {
    throw new AgentActionConflictError(
      proposal.status === "PROCESSING"
        ? "该操作正在处理中，请稍候"
        : "该操作已处理，请刷新当前会话状态",
    );
  }

  const action = getAgentAction(proposal.actionKey);
  if (!action) {
    throw new AgentActionInputError(`Unknown action: ${proposal.actionKey}`);
  }

  const leaseToken = newProcessingLeaseToken();

  // ── Atomic claim: PENDING -> PROCESSING + lease token ──
  // Prevents concurrent confirm / reject / PATCH from executing the business
  // action twice. Only one request wins the claim.
  const claimed = await prisma.agentProposal.updateMany({
    where: { id: proposal.id, userId: baseActor.userId, status: "PENDING" },
    data: { status: "PROCESSING", processingLeaseToken: leaseToken },
  });

  if (claimed.count === 0) {
    const cur = await prisma.agentProposal.findUnique({
      where: { id: proposal.id },
      select: { status: true },
    });
    const currentStatus = cur?.status ?? "UNKNOWN";
    throw new AgentActionConflictError(
      currentStatus === "PROCESSING"
        ? "该操作正在处理中，请稍候"
        : "该操作已处理，请刷新当前会话状态",
    );
  }

  const claimedProposal = await prisma.agentProposal.findUnique({
    where: { id: proposal.id },
  });
  if (!claimedProposal) {
    throw new AgentActionInputError("Proposal not found after claim");
  }

  // 长任务期间刷新 updatedAt，避免仍存活的 confirm 被误回收
  const heartbeat = setInterval(() => {
    void prisma.agentProposal
      .updateMany({
        where: { id: proposal.id, status: "PROCESSING", processingLeaseToken: leaseToken },
        // 同值写入仍触发 @updatedAt，延长租约窗口
        data: { processingLeaseToken: leaseToken },
      })
      .catch((err: unknown) => {
        // SQLite busy / 连接抖动不应变成 unhandled rejection；
        // 连续失败时由 lease 超时回收兜底。
        console.warn(
          "[agent proposal heartbeat] refresh failed:",
          proposal.id,
          err instanceof Error ? err.message : err,
        );
      });
  }, PROCESSING_HEARTBEAT_MS);

  // claim 之后的所有失败路径都必须带 lease 条件释放，
  // 若租约已被回收则不再覆盖终态。
  try {
    let input: unknown;
    try {
      input = JSON.parse(claimedProposal.inputJson) as unknown;
    } catch {
      throw new AgentActionInputError("proposal input is invalid");
    }

    // P1#2 层 B：从 proposal 恢复 agentRunId + chatSessionId 注入 actor，
    // 使 add_note 的 session/run 校验可用。
    let restoredChatSessionId: string | null = null;
    if (claimedProposal.displayPropsJson) {
      try {
        const dp = JSON.parse(claimedProposal.displayPropsJson) as Record<string, unknown>;
        if (dp && typeof dp.__chatSessionId === "string") {
          restoredChatSessionId = dp.__chatSessionId;
        }
      } catch {
        // 忽略损坏的 displayPropsJson（非致命）。
      }
    }
    const executeCtx: AgentExecutionContext = {
      actor: baseActor,
      invocation: buildInvocationContext({
        channel: "agent",
        agentRunId: claimedProposal.agentRunId ?? ctx.invocation.agentRunId ?? null,
        chatSessionId: restoredChatSessionId,
        proposalId: proposal.id,
        // 从 proposal 复原 publicToolKey，使 CONFIRMED_EXECUTED / CONFIRMED_FAILED 审计可追溯。
        publicToolKey: claimedProposal.publicToolKey ?? null,
      }),
    };

    const executed = await executeAgentAction(executeCtx, proposal.actionKey, input, {
      allowConfirm: true,
      proposalId: proposal.id,
    });
    const target = action.resolveTarget
      ? await action.resolveTarget(action.parseInput(input), executed.result)
      : null;

    const finalized = await finalizeProcessingProposal({
      proposalId: proposal.id,
      leaseToken,
      data: {
        status: "CONFIRMED",
        resultJson: JSON.stringify(executed.result),
        error: null,
        targetType: target?.type ?? proposal.targetType,
        targetId: target?.id ?? proposal.targetId,
      },
    });

    if (!finalized.ok) {
      // 业务可能已执行成功，但租约被回收：禁止再写成 CONFIRMED
      const leaseLost = new AgentActionConflictError(
        "该操作的处理租约已失效（可能超时回收），请刷新后核对业务结果，勿重复确认",
      );
      (leaseLost as AgentActionConflictError & { leaseLost?: boolean }).leaseLost = true;
      throw leaseLost;
    }

    // 写入会话历史，供下一轮模型看到确认结果（orderId/orderNo/profileId 等）
    await appendConfirmedProposalChatEvent({
      actor: baseActor,
      proposal: {
        id: proposal.id,
        actionKey: proposal.actionKey,
        title: proposal.title,
        agentRunId: proposal.agentRunId,
        inputJson: claimedProposal.inputJson,
      },
      result: executed.result,
    });

    return {
      proposal: mapAgentProposalRecord(finalized.proposal),
      result: executed.result,
    };
  } catch (error) {
    const leaseAlreadyGone =
      error instanceof AgentActionConflictError &&
      (error as AgentActionConflictError & { leaseLost?: boolean }).leaseLost === true;
    if (!leaseAlreadyGone) {
      await finalizeProcessingProposal({
        proposalId: proposal.id,
        leaseToken,
        data: {
          status: "FAILED",
          error: error instanceof Error ? error.message : "Proposal execution failed",
        },
      });
      // lease 已失效时 count=0：保持回收后的 FAILED，不覆盖。
      //
      // 执行失败必须回滚领域状态（§4.3.2）：如 import row 仍停在 PROPOSED
      // 且挂着本 proposalId，不回滚该行将永远无法再生成 proposal。
      const lifecycle = getProposalLifecycle(action.proposalLifecycleKey);
      if (lifecycle?.revert) {
        await prisma
          .$transaction((tx) =>
            lifecycle.revert!(tx, baseActor, {
              id: claimedProposal.id,
              actionKey: claimedProposal.actionKey,
              inputJson: claimedProposal.inputJson,
            }),
          )
          .catch((revertErr: unknown) => {
            console.error(
              "[agent proposal confirm] revert lifecycle failed:",
              proposal.id,
              revertErr instanceof Error ? revertErr.message : revertErr,
            );
          });
      }
    }
    throw error;
  } finally {
    clearInterval(heartbeat);
  }
}

/**
 * Strictly parse proposal inputJson into an object. Throws on malformed JSON or
 * non-object payload so reject never proceeds with an unreadable proposal.
 */
function parseProposalInputStrict(inputJson: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(inputJson);
  } catch {
    throw new AgentActionInputError("proposal input is invalid");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AgentActionInputError("proposal input is invalid");
  }
  return parsed as Record<string, unknown>;
}

/**
 * Extract/validate stagingFileId from a register_issued_invoice input. A
 * register proposal without a valid stagingFileId is corrupt and must not be
 * rejected without staging cleanup (a refresh would rehydrate the file).
 */
function requireStagingIdFromInput(input: Record<string, unknown>): string {
  const id = input.stagingFileId;
  if (typeof id !== "string" || !id.trim()) {
    throw new AgentActionInputError("proposal 缺少 stagingFileId，无法关联发票文件");
  }
  return id.trim();
}

/**
 * Reject a PENDING proposal (T1.1 runtime proposal service).
 *
 * Atomic PENDING→REJECTED + optional invoice-staging SKIP + domain lifecycle
 * revert in one transaction. Any staging/lifecycle conflict rolls back the whole
 * reject and surfaces a 409 so the user reconciles the real state.
 */
export async function rejectAgentProposal(
  ctx: AgentExecutionContext,
  proposalId: string,
): Promise<{ proposal: AgentActionProposalRecord }> {
  if (!proposalId) {
    throw new AgentActionInputError("proposal id is required");
  }

  const baseActor = await refreshActorForProposal(ctx.actor);

  const proposal = await getAgentProposalForActor(baseActor, proposalId);

  if (proposal.status !== "PENDING") {
    throw new AgentActionConflictError(
      proposal.status === "PROCESSING"
        ? "该操作正在处理中，无法取消"
        : "该操作已处理，请刷新当前会话状态",
    );
  }

  const action = getAgentAction(proposal.actionKey);
  if (!action) {
    throw new AgentActionInputError(`Unknown action: ${proposal.actionKey}`);
  }

  // Parse input strictly, once, before touching the transaction. For
  // register_issued_invoice a missing/blank stagingFileId is a corrupt proposal.
  const parsedInput = parseProposalInputStrict(proposal.inputJson);
  const stagingFileId =
    proposal.actionKey === "finance.register_issued_invoice"
      ? requireStagingIdFromInput(parsedInput)
      : null;

  const lifecycle = getProposalLifecycle(action.proposalLifecycleKey);

  const updated = await prisma.$transaction(async (tx) => {
    const rejected = await tx.agentProposal.updateMany({
      where: { id: proposal.id, userId: baseActor.userId, status: "PENDING" },
      data: { status: "REJECTED", decidedAt: new Date(), serialActiveKey: null },
    });

    if (rejected.count === 0) {
      throw new AgentActionConflictError("该操作已处理或正在处理中，无法取消");
    }

    if (stagingFileId) {
      const skipped = await tx.agentInvoiceStagingFile.updateMany({
        where: {
          id: stagingFileId,
          createdById: baseActor.userId,
          status: { in: ["UPLOADED", "ANALYZED", "ANALYZING"] },
        },
        data: { status: "SKIPPED" },
      });
      if (skipped.count !== 1) {
        throw new AgentActionConflictError("关联的发票文件状态已变化，请刷新后重试");
      }
    }

    // §4.3.2：领域状态回滚。与 proposal REJECTED 同事务，任一步失败整体回滚。
    if (lifecycle?.revert) {
      await lifecycle.revert(tx, baseActor, {
        id: proposal.id,
        actionKey: proposal.actionKey,
        inputJson: proposal.inputJson,
      });
    }

    const row = await tx.agentProposal.findUnique({ where: { id: proposal.id } });
    if (!row) {
      throw new AgentActionInputError("Proposal not found after reject");
    }
    return row;
  });

  await createAgentActionLog(
    {
      actor: baseActor,
      invocation: buildInvocationContext({
        channel: ctx.invocation.channel,
        agentRunId: proposal.agentRunId ?? ctx.invocation.agentRunId ?? null,
        chatSessionId: ctx.invocation.chatSessionId ?? null,
        proposalId: proposal.id,
        // 从 proposal 复原，使 Web UI reject 的 ActionLog 不丢 publicToolKey。
        publicToolKey: proposal.publicToolKey ?? null,
      }),
    },
    action,
    {
      status: "REJECTED",
      input: parsedInput,
      proposalId: proposal.id,
      target: { type: proposal.targetType, id: proposal.targetId },
    },
  );

  return { proposal: mapAgentProposalRecord(updated) };
}

/**
 * Refresh the caller identity from DB before a terminal proposal decision.
 * Uses live User.role and confirms the user still exists; never trusts the
 * session-snapshot role for the mutating decision.
 */
async function refreshActorForProposal(actor: BusinessActor): Promise<BusinessActor> {
  const current = await resolveCurrentBusinessActor({
    userId: actor.userId,
    channel: "web",
    sessionActor: { role: actor.role, name: actor.name ?? null, email: actor.email ?? null },
  });
  return {
    userId: current.userId,
    role: current.role,
    name: current.name ?? null,
    email: current.email ?? null,
  };
}

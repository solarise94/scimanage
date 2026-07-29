/**
 * P1-3 allowProposal 可信前端事件 canonical service
 * （docs/agent-public-surface-cleanup-plan-2026-07-26.md §六 P1-3）。
 *
 * 问题：模型驱动（channel="agent"）的 proposal 创建，过去靠 runtime 的
 * `autoHopCount === 0` 推断用户本轮明确要求，但「模型话术触发 propose」≠
 * 「用户在 UI 明确点击同意」。本服务提供一次性可信确认事件，让 proposal
 * 创建必须在同事务内消费一个由浏览器 UI 经 NextAuth 颁发的事件。
 *
 * 边界归属：本模块是 §1.4「专用 runtime service 访问 Agent 自身模型」例外，
 * 见 docs/canonical-application-service-migration-progress.md
 * 「仍允许直接访问 Prisma 的基础设施边界」清单。Agent 入口扫描根内零 Prisma。
 *
 * 一次性消费语义：
 *  - 颁发：`issueConfirmationEvent`（由 `POST /api/agent/confirmation-events`
 *    经 NextAuth session 调用，绑定 actor + AgentRun + targetIntent + 幂等键）；
 *  - 消费：`consumeConfirmationEventForProposal(tx, ...)` 在 proposal 创建的
 *    同一 `$transaction` 内原子 `updateMany({ where: { ...consumedAt:null } })`，
 *    count===0 即无效（已消费 / 跨 run / targetIntent 不匹配 / action 不符），
 *    consume 失败整个事务回滚，不产生半消费状态。
 */
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { BusinessActor } from "@/lib/application/actor";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/application/errors";

/** 仅 create_proposal 一种动作；预留枚举扩展。 */
export const CONFIRMATION_ACTION_CREATE_PROPOSAL = "create_proposal" as const;
export type ConfirmationAction = typeof CONFIRMATION_ACTION_CREATE_PROPOSAL;

/** idempotencyKey 长度边界（与路由手写校验一致）。 */
export const IDEMPOTENCY_KEY_MIN_LEN = 8;
export const IDEMPOTENCY_KEY_MAX_LEN = 128;
/** targetIntent 长度边界（confirm actionKey 一般 < 100）。 */
export const TARGET_INTENT_MAX_LEN = 200;

export type IssuedConfirmationEvent = {
  id: string;
  actorUserId: string;
  agentRunId: string;
  targetIntent: string;
  action: ConfirmationAction;
  idempotencyKey: string;
  consumedAt: Date | null;
  createdAt: Date;
  /** true = 本次 issue 新建；false = 幂等命中既有未消费事件。 */
  created: boolean;
};

/**
 * 颁发一个可信确认事件。仅由 `POST /api/agent/confirmation-events` 调用
 * （请求必须经 NextAuth session 鉴权 + requireAgentAccess + requireBusinessActorFromSession）。
 *
 * 校验：
 *  - agentRunId 对应的 AgentRun 必须属于 actor.userId 且存在；不存在/越权统一 NotFound
 *    （合并语义，防存在性泄露）；
 *  - idempotencyKey 已存在 → 返回既有事件：
 *      - 未消费 → 幂等重发安全（UI 误点 / 网络重试）；
 *      - 已消费 → 409 Conflict（事件已被某次 proposal 创建消费，不能再重复颁发同 key）。
 *
 * 返回值携带完整事件记录，但路由只回 `{ id, targetIntent, createdAt }` 给前端。
 */
export async function issueConfirmationEvent(input: {
  actor: BusinessActor;
  agentRunId: string;
  targetIntent: string;
  idempotencyKey: string;
  action?: ConfirmationAction;
}): Promise<IssuedConfirmationEvent> {
  const agentRunId = input.agentRunId.trim();
  const targetIntent = input.targetIntent.trim();
  const idempotencyKey = input.idempotencyKey.trim();
  const action = input.action ?? CONFIRMATION_ACTION_CREATE_PROPOSAL;

  if (!agentRunId) {
    throw new ValidationError("agentRunId is required");
  }
  if (!targetIntent || targetIntent.length > TARGET_INTENT_MAX_LEN) {
    throw new ValidationError(`targetIntent must be 1..${TARGET_INTENT_MAX_LEN} chars`);
  }
  if (
    idempotencyKey.length < IDEMPOTENCY_KEY_MIN_LEN ||
    idempotencyKey.length > IDEMPOTENCY_KEY_MAX_LEN
  ) {
    throw new ValidationError(
      `idempotencyKey must be ${IDEMPOTENCY_KEY_MIN_LEN}..${IDEMPOTENCY_KEY_MAX_LEN} chars`,
    );
  }

  // AgentRun 归属校验：不存在或越权合并成 NotFound（service 层现状语义，防存在性泄露）。
  const run = await prisma.agentRun.findUnique({
    where: { id: agentRunId },
    select: { id: true, userId: true },
  });
  if (!run || run.userId !== input.actor.userId) {
    throw new NotFoundError("Agent run not found");
  }

  // 幂等：同 idempotencyKey 已存在则返回既有事件。
  const existing = await prisma.agentUserConfirmationEvent.findUnique({
    where: { idempotencyKey },
  });
  if (existing) {
    // 防越权：同 key 必须同 actor（理论上 unique 已保证，但显式校验 fail-closed）。
    if (existing.actorUserId !== input.actor.userId) {
      // 不泄露存在性：当作 NotFound 处理。
      throw new NotFoundError("Agent run not found");
    }
    // 幂等键必须绑定完整语义 tuple：actorUserId + agentRunId + targetIntent + action 全匹配。
    // 任一不匹配 → 409（key 已被不同语义的事件占用，禁止复用）。
    assertTupleMatches(existing, { agentRunId, targetIntent, action });
    if (existing.consumedAt) {
      // 已被消费：禁止重复颁发同 key（避免 UI 拿同一 key 反复 mint 新 proposal）。
      throw new ConflictError("该确认事件已被消费，请重新触发界面确认");
    }
    return mapEvent(existing, /* created */ false);
  }

  try {
    const created = await prisma.agentUserConfirmationEvent.create({
      data: {
        actorUserId: input.actor.userId,
        agentRunId,
        targetIntent,
        action,
        idempotencyKey,
      },
    });
    return mapEvent(created, /* created */ true);
  } catch (err) {
    // 并发首次颁发：两请求同时通过 findUnique 检查后竞争 create，输家触发 P2002（unique idempotencyKey）。
    // 重读既有行并按完整 tuple 校验，匹配则返回既有（created:false），不匹配则 409。
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const raced = await prisma.agentUserConfirmationEvent.findUnique({
        where: { idempotencyKey },
      });
      if (raced) {
        if (raced.actorUserId !== input.actor.userId) {
          throw new NotFoundError("Agent run not found");
        }
        assertTupleMatches(raced, { agentRunId, targetIntent, action });
        return mapEvent(raced, /* created */ false);
      }
    }
    throw err;
  }
}

/**
 * 校验既有事件与本次 issue 请求的完整语义 tuple 一致。
 * tuple = (agentRunId, targetIntent, action)；actorUserId 由调用方先行校验。
 * 任一不匹配 → 409 ConflictError（幂等键已被不同语义的事件占用）。
 */
function assertTupleMatches(
  row: {
    agentRunId: string;
    targetIntent: string;
    action: string;
  },
  expected: { agentRunId: string; targetIntent: string; action: ConfirmationAction },
): void {
  if (
    row.agentRunId !== expected.agentRunId ||
    row.targetIntent !== expected.targetIntent ||
    row.action !== expected.action
  ) {
    throw new ConflictError("幂等键已被不同语义的事件占用");
  }
}

/**
 * 在 proposal 创建事务内原子消费**一条**未消费事件。
 *
 * 由 `createAgentProposal`（channel="agent"）在同一 `$transaction` 中调用。
 * 流程：
 *  1. findFirst 选最早一条匹配 (actorUserId, agentRunId, targetIntent, action, consumedAt=null) 的事件；
 *  2. updateMany 以 `id + consumedAt=null` 作 CAS 原子置 consumedAt=now；
 *  3. count===1 → 成功消费恰好一条；count===0 → 该事件已被并发消费或不存在。
 *
 * 关键：find + update 两步而非单条 updateMany（按宽条件）。这样同 intent 颁发多个事件时，
 * 一次 proposal 只消费一条（最早的），其余事件保持未消费，可被后续 proposal 各消费一条。
 * updateMany 的 `id` + `consumedAt:null` 条件保证并发竞争只有一个赢家。
 *
 * @returns true = 成功消费（事务可继续创建 proposal）；false = 无有效事件。
 *          false 不抛错，由调用方决定（createAgentProposal 抛 NEEDS_USER_CONFIRMATION）。
 */
export async function consumeConfirmationEventForProposal(
  tx: Prisma.TransactionClient,
  opts: {
    actorUserId: string;
    agentRunId: string;
    targetIntent: string;
    action?: ConfirmationAction;
  },
): Promise<boolean> {
  const action = opts.action ?? CONFIRMATION_ACTION_CREATE_PROPOSAL;
  const target = await tx.agentUserConfirmationEvent.findFirst({
    where: {
      actorUserId: opts.actorUserId,
      agentRunId: opts.agentRunId,
      targetIntent: opts.targetIntent,
      action,
      consumedAt: null,
    },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  if (!target) {
    return false;
  }
  const result = await tx.agentUserConfirmationEvent.updateMany({
    where: { id: target.id, consumedAt: null },
    data: { consumedAt: new Date() },
  });
  return result.count === 1;
}

function mapEvent(
  row: {
    id: string;
    actorUserId: string;
    agentRunId: string;
    targetIntent: string;
    action: string;
    idempotencyKey: string;
    consumedAt: Date | null;
    createdAt: Date;
  },
  created: boolean,
): IssuedConfirmationEvent {
  return {
    id: row.id,
    actorUserId: row.actorUserId,
    agentRunId: row.agentRunId,
    targetIntent: row.targetIntent,
    action: row.action as ConfirmationAction,
    idempotencyKey: row.idempotencyKey,
    consumedAt: row.consumedAt,
    createdAt: row.createdAt,
    created,
  };
}

/**
 * T2.2b — canonical create-order command.
 *
 * Single formal write entry for Web `POST /api/orders` and Agent `orders.create`.
 * Always re-runs T2.2a prepare (fresh actor + CRM facts), then writes Order/Line/
 * Project/Link/ActivityLog/initial cost inside one Prisma transaction with
 * orderNo/projectNo collision retry. CRM lifecycle + representative notification
 * run post-commit (outbox-style; failures are logged, not rolled back).
 */
import { prisma } from "@/lib/prisma";
import type { BusinessActor, InvocationContext } from "@/lib/application/actor";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "@/lib/application/errors";
import { transitionCrmStage } from "@/lib/crm/lifecycle";
import {
  createOrderWithProject,
  type CreateOrderResult,
  type RepAssignedSnapshot,
} from "@/lib/orders/create-order-with-project";
import { OrderProjectCustomerConflictError, OrderProjectMissingProfileError } from "@/lib/orders/link-project";
import {
  prepareCreateOrderForActor,
  type PrepareCreateOrderInput,
  type PreparedCreateOrder,
} from "@/lib/orders/application/prepare-create-order";

export type CreateOrderCommandResult = {
  order: CreateOrderResult["order"];
  project: CreateOrderResult["project"];
  repSnapshot: RepAssignedSnapshot | null;
  prepared: PreparedCreateOrder;
  /** Echo of invocation for adapters/audit (proposalId etc.). */
  invocation: InvocationContext;
};

function isPrismaUniqueConflict(err: unknown): { orderNo: boolean; projectNo: boolean } {
  const isP2002 =
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: string }).code === "P2002";
  if (!isP2002) return { orderNo: false, projectNo: false };
  const target = Array.isArray((err as { meta?: { target?: unknown } }).meta?.target)
    ? ((err as { meta?: { target?: string[] } }).meta?.target || [])
    : [];
  return {
    orderNo: target.includes("orderNo"),
    projectNo: target.includes("projectNo"),
  };
}

async function runPostCommitSideEffects(
  result: CreateOrderResult,
  orderStatus: string,
): Promise<void> {
  const { order, repSnapshot } = result;

  if (repSnapshot) {
    const { notifyRepresentativeById } = await import("@/lib/representative-link");
    const { buildRepAssignedNotifications } = await import("@/lib/notification-helpers");
    notifyRepresentativeById(
      repSnapshot.representativeId,
      repSnapshot.representativeEmail,
      `/projects/${repSnapshot.projectId}`,
      buildRepAssignedNotifications(repSnapshot.representativeName, repSnapshot.projectName),
    ).catch(() => {});
  }

  if (order?.profileId) {
    if (orderStatus === "CONFIRMED") {
      await transitionCrmStage(order.profileId, {
        type: "ORDER_CONFIRMED",
        orderId: order.id,
      }).catch((err) => {
        console.error(`[CRM][ORDER] ORDER_CONFIRMED transition failed for ${order.profileId}:`, err);
      });
    } else {
      await transitionCrmStage(order.profileId, { type: "DORMANT_SCAN" }).catch((err) => {
        console.error(`[CRM][ORDER] DORMANT_SCAN transition failed for ${order.profileId}:`, err);
      });
    }
  }
}

/**
 * In-transaction create using an already-prepared payload.
 * Used by `createOrderForActor` and import `writeOrderForRow` CREATE (T2.5)
 * so both share the same formal writer without nested `$transaction`.
 */
export async function createPreparedOrderInTx(
  tx: Parameters<typeof createOrderWithProject>[0],
  prepared: PreparedCreateOrder,
): Promise<CreateOrderResult> {
  return createOrderWithProject(tx, prepared.payload);
}

/**
 * Create an order for the current actor. Idempotency for Agent confirm is
 * owned by proposal claim (`agent-proposal:${proposalId}`); this command does
 * not yet persist a separate idempotency ledger (schema deferred).
 */
export async function createOrderForActor(
  actor: BusinessActor,
  invocation: InvocationContext,
  input: PrepareCreateOrderInput,
): Promise<CreateOrderCommandResult> {
  // Always refresh prepare on execute/confirm — proposal cards are not facts.
  const prepared = await prepareCreateOrderForActor(actor, input);
  // Phase E：Agent channel 创建订单时，同事务把当前合格 actor 绑定为 technicalOwner。
  // 仅 USER/ADMIN 可经 Agent 创建；RM/REP 即便调用也会被各自 action availability 拦在更早层，
  // 这里是 canonical 二次防御（fail-closed）。
  if (invocation.channel === "agent") {
    if (actor.role !== "ADMIN" && actor.role !== "USER") {
      throw new ForbiddenError("当前角色不可经 Agent 创建订单");
    }
    prepared.payload.technicalOwnerUserId = actor.userId;
  }
  const { meta } = prepared;

  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const result = await prisma.$transaction(async (tx) => {
        return createPreparedOrderInTx(tx, prepared);
      });

      await runPostCommitSideEffects(result, meta.orderStatus);

      return {
        order: result.order,
        project: result.project ?? null,
        repSnapshot: result.repSnapshot ?? null,
        prepared,
        invocation,
      };
    } catch (err) {
      lastError = err;
      if (err instanceof OrderProjectMissingProfileError) {
        throw new ValidationError(err.message);
      }
      if (err instanceof OrderProjectCustomerConflictError) {
        throw new ConflictError("订单客户与项目客户不一致");
      }
      const conflict = isPrismaUniqueConflict(err);
      const retryable =
        conflict.orderNo || (meta.autoProjectNoInDraft && conflict.projectNo);
      if (retryable && attempt < 2) {
        continue;
      }
      if (conflict.orderNo) {
        throw new ConflictError("订单号冲突，请重试");
      }
      if (conflict.projectNo) {
        throw new ConflictError("项目号已被使用");
      }
      throw err;
    }
  }

  throw lastError instanceof Error ? lastError : new ConflictError("订单创建失败，请重试");
}

export type CreateOrderFromDraftInput = {
  orderDraftId: string;
  expectedVersion: number;
};

/**
 * Phase C / P0 原子落单：在同一最终事务内重读 PROPOSED+version、写订单、标 CONSUMED。
 *
 * 消费 `updateMany` count 必须为 1，否则整笔回滚——避免「订单已存在 + 草稿可重新提案」的
 * 双事务窗口。Order 本身无 proposal 级业务幂等键，原子消费是防重复落单的权威手段。
 */
export async function createOrderFromDraftForActor(
  actor: BusinessActor,
  invocation: InvocationContext,
  input: CreateOrderFromDraftInput,
): Promise<CreateOrderCommandResult> {
  const draft = await prisma.orderDraft.findUnique({
    where: { id: input.orderDraftId },
    include: { lines: { orderBy: { sortOrder: "asc" } } },
  });
  if (!draft) throw new NotFoundError("订单草稿");
  if (draft.ownerUserId !== actor.userId) throw new ForbiddenError("无权消费他人草稿");
  if (draft.expiresAt.getTime() <= Date.now()) {
    if (draft.status === "DRAFT" || draft.status === "PROPOSED") {
      await prisma.orderDraft.updateMany({
        where: { id: draft.id, status: draft.status },
        data: { status: "EXPIRED" },
      });
    }
    throw new ValidationError("订单草稿已过期，请重新 prepare_order");
  }
  if (draft.status !== "PROPOSED") {
    throw new ConflictError(`草稿状态 ${draft.status}，不可落单`);
  }
  if (draft.version !== input.expectedVersion) {
    throw new ConflictError("草稿版本已变更，请刷新后重试");
  }
  if (!draft.customerProfileId) {
    throw new ValidationError("草稿缺少客户档案，无法创建订单");
  }
  if (!draft.titleSnapshot || draft.lines.length === 0) {
    throw new ValidationError("草稿尚无有效行，无法创建订单");
  }

  // 草稿存 unitPriceCents（分）；prepare 输入用 yuan（moneyUnit:"yuan"），service 内转分。
  // Phase 1：草稿行带 productSkuId 时透传，prepare 内校验 active+sellable 并生成编号快照，
  // 修复"草稿已选产品，正式订单只留下名称"的降级（设计文档 §5.3）。
  // 仅 productKey 的 legacy 草稿行兼容期保留（itemName=displayName），不创建目录绑定。
  const prepared = await prepareCreateOrderForActor(actor, {
    title: draft.titleSnapshot,
    profileId: draft.customerProfileId,
    moneyUnit: "yuan",
    lines: draft.lines.map((l) => ({
      itemName: l.productDisplayNameSnapshot ?? l.productKey,
      category: l.projectTypeKey,
      quantity: l.quantity,
      unitPrice: l.unitPriceCents / 100,
      amount: (l.unitPriceCents * l.quantity) / 100,
      productSkuId: l.productSkuId,
    })),
  });

  if (invocation.channel === "agent") {
    if (actor.role !== "ADMIN" && actor.role !== "USER") {
      throw new ForbiddenError("当前角色不可经 Agent 创建订单");
    }
    prepared.payload.technicalOwnerUserId = actor.userId;
  }

  const { meta } = prepared;
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const result = await prisma.$transaction(async (tx) => {
        // 最终写事务内重读：PROPOSED + expectedVersion + owner（防 TOCTOU / 并发消费）。
        const fresh = await tx.orderDraft.findUnique({
          where: { id: input.orderDraftId },
          select: { status: true, version: true, ownerUserId: true, expiresAt: true },
        });
        if (!fresh || fresh.ownerUserId !== actor.userId) {
          throw new NotFoundError("订单草稿");
        }
        if (fresh.expiresAt.getTime() <= Date.now()) {
          await tx.orderDraft.updateMany({
            where: { id: input.orderDraftId, status: { in: ["DRAFT", "PROPOSED"] } },
            data: { status: "EXPIRED" },
          });
          throw new ValidationError("订单草稿已过期，请重新 prepare_order");
        }
        if (fresh.status !== "PROPOSED" || fresh.version !== input.expectedVersion) {
          throw new ConflictError(
            `草稿已被消费或版本已变更（status=${fresh.status}, version=${fresh.version}）`,
          );
        }

        const created = await createPreparedOrderInTx(tx, prepared);

        const consumed = await tx.orderDraft.updateMany({
          where: {
            id: input.orderDraftId,
            status: "PROPOSED",
            version: input.expectedVersion,
          },
          data: { status: "CONSUMED" },
        });
        if (consumed.count !== 1) {
          throw new ConflictError("草稿消费失败（已被并发消费或状态已变）");
        }

        return created;
      });

      await runPostCommitSideEffects(result, meta.orderStatus);

      return {
        order: result.order,
        project: result.project ?? null,
        repSnapshot: result.repSnapshot ?? null,
        prepared,
        invocation,
      };
    } catch (err) {
      lastError = err;
      if (err instanceof OrderProjectMissingProfileError) {
        throw new ValidationError(err.message);
      }
      if (err instanceof OrderProjectCustomerConflictError) {
        throw new ConflictError("订单客户与项目客户不一致");
      }
      const conflict = isPrismaUniqueConflict(err);
      const retryable =
        conflict.orderNo || (meta.autoProjectNoInDraft && conflict.projectNo);
      if (retryable && attempt < 2) {
        continue;
      }
      if (conflict.orderNo) {
        throw new ConflictError("订单号冲突，请重试");
      }
      if (conflict.projectNo) {
        throw new ConflictError("项目号已被使用");
      }
      throw err;
    }
  }

  throw lastError instanceof Error ? lastError : new ConflictError("订单创建失败，请重试");
}

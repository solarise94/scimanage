/**
 * T2.3 — canonical link-order-to-project command.
 *
 * Single formal write entry for Web `POST /api/orders/[id]/project-links`
 * and Agent `orders.link_to_project`. Capability is ADMIN-only (matches page).
 * Domain helper `linkOrderToProject` stays the in-tx writer; this service owns
 * actor gate, existence/duplicate checks, txn + optional order update, and
 * post-commit representative notification.
 */
import { prisma } from "@/lib/prisma";
import type { BusinessActor, InvocationContext } from "@/lib/application/actor";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "@/lib/application/errors";
import { yuanToCents } from "@/lib/finance/money";
import {
  linkOrderToProject,
  OrderProjectCustomerConflictError,
  OrderProjectMissingProfileError,
  type LinkResult,
  type RepAssignedSnapshot,
} from "@/lib/orders/link-project";

export class OrderCustomerConflictError extends ConflictError {
  readonly orderProfileId: string;
  readonly projectProfileId: string;

  constructor(orderProfileId: string, projectProfileId: string) {
    super("订单客户与项目客户不一致");
    this.orderProfileId = orderProfileId;
    this.projectProfileId = projectProfileId;
  }
}

export type LinkOrderProjectInput = {
  orderId: string;
  projectId: string;
  treatment?: string | null;
  /** Interpreted per `moneyUnit` when set. */
  allocatedAmount?: number | null;
  moneyUnit?: "yuan" | "cents";
  isPrimary?: boolean | null;
  note?: string | null;
};

export type PreparedLinkOrderProject = {
  order: { id: string; orderNo: string; title: string };
  project: { id: string; name: string };
  options: {
    treatment?: string;
    allocatedAmount?: number | null;
    isPrimary?: boolean;
    note?: string | null;
  };
};

export type LinkOrderProjectCommandResult = {
  link: LinkResult["link"];
  repAssignedToProject: RepAssignedSnapshot | null;
  prepared: PreparedLinkOrderProject;
  invocation: InvocationContext;
};

function assertAdmin(actor: BusinessActor): void {
  if (actor.role !== "ADMIN") {
    throw new ForbiddenError();
  }
}

function normalizeAllocatedAmount(
  amount: number | null | undefined,
  moneyUnit: "yuan" | "cents",
): number | null | undefined {
  if (amount == null) return amount;
  const n = Number(amount);
  if (!Number.isFinite(n)) {
    throw new ValidationError("分摊金额无效");
  }
  return moneyUnit === "yuan" ? yuanToCents(n) : Math.round(n);
}

/**
 * Read-side prepare for proposal cards / preflight: ADMIN + existence + no duplicate.
 * Does not write.
 */
export async function prepareLinkOrderProjectForActor(
  actor: BusinessActor,
  input: LinkOrderProjectInput,
): Promise<PreparedLinkOrderProject> {
  assertAdmin(actor);

  const orderId = input.orderId?.trim() || "";
  const projectId = input.projectId?.trim() || "";
  if (!orderId) throw new ValidationError("orderId is required");
  if (!projectId) throw new ValidationError("projectId is required");

  const moneyUnit = input.moneyUnit ?? "cents";
  const allocatedAmount = normalizeAllocatedAmount(input.allocatedAmount, moneyUnit);

  const [order, project, existing] = await Promise.all([
    prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, orderNo: true, title: true },
    }),
    prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, name: true },
    }),
    prisma.orderProjectLink.findUnique({
      where: { orderId_projectId: { orderId, projectId } },
      select: { id: true },
    }),
  ]);

  if (!order) throw new NotFoundError("Order not found");
  if (!project) throw new NotFoundError("Project not found");
  if (existing) throw new ConflictError("Link already exists");

  return {
    order,
    project,
    options: {
      treatment: input.treatment?.trim() || undefined,
      allocatedAmount,
      isPrimary: input.isPrimary === true ? true : undefined,
      note: input.note?.trim() || undefined,
    },
  };
}

async function runPostCommitSideEffects(rep: RepAssignedSnapshot | null): Promise<void> {
  if (!rep) return;
  const { notifyRepresentativeById } = await import("@/lib/representative-link");
  const { buildRepAssignedNotifications } = await import("@/lib/notification-helpers");
  notifyRepresentativeById(
    rep.representativeId,
    rep.representativeEmail,
    `/projects/${rep.projectId}`,
    buildRepAssignedNotifications(rep.representativeName, rep.projectName),
  ).catch(() => {});
}

/**
 * Link order ↔ project for the current actor. Always re-runs prepare on execute
 * so proposal cards are not treated as facts.
 */
export async function linkOrderToProjectForActor(
  actor: BusinessActor,
  invocation: InvocationContext,
  input: LinkOrderProjectInput,
): Promise<LinkOrderProjectCommandResult> {
  const prepared = await prepareLinkOrderProjectForActor(actor, input);

  try {
    const result = await prisma.$transaction(async (tx) => {
      // Phase E：cross-resource Agent 写门——actor 必须同时是 Order 和 Project 的 technicalOwner。
      // 在最终写事务内复核（防 TOCTOU：proposal build 后 owner 可能被改）。
      const { assertAgentCanWriteOrder, assertAgentCanWriteProject } = await import(
        "./technical-owner-gate"
      );
      await assertAgentCanWriteOrder(actor, invocation, prepared.order.id, { tx });
      await assertAgentCanWriteProject(actor, invocation, prepared.project.id, { tx });

      const linkResult = await linkOrderToProject(
        tx,
        prepared.order.id,
        prepared.project.id,
        actor.userId,
        prepared.options,
      );
      if (linkResult.orderUpdateData) {
        await tx.order.update({
          where: { id: prepared.order.id },
          data: linkResult.orderUpdateData,
        });
      }
      return linkResult;
    });

    await runPostCommitSideEffects(result.repAssignedToProject);

    return {
      link: result.link,
      repAssignedToProject: result.repAssignedToProject,
      prepared,
      invocation,
    };
  } catch (err) {
    if (err instanceof OrderProjectMissingProfileError) {
      throw new ValidationError(err.message);
    }
    if (err instanceof OrderProjectCustomerConflictError) {
      throw new OrderCustomerConflictError(err.orderProfileId, err.projectProfileId);
    }
    // Concurrent duplicate create → unique conflict
    const isP2002 =
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code: string }).code === "P2002";
    if (isP2002) {
      throw new ConflictError("Link already exists");
    }
    throw err;
  }
}

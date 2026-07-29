/**
 * Canonical actor-aware invoice attachment adoption command (T6.6).
 *
 * Copies a verified general attachment (PDF/JPEG/PNG) into private invoice
 * staging with route CAS / idempotent reuse. Shared by Agent
 * `finance.adopt_agent_attachment_as_invoice` and any future Web adapter.
 */
import { randomUUID } from "crypto";
import type { BusinessActor, InvocationContext } from "@/lib/application/actor";
import { ForbiddenError, ValidationError } from "@/lib/application/errors";
import { INVOICE_ADOPTABLE_MIME } from "@/lib/agent-attachments/constants";
import {
  assertAttachmentInCurrentRun,
  getOwnedAgentAttachment,
  verifyAttachmentIntegrity,
} from "@/lib/agent-attachments/staging";
import {
  casMarkRouteStale,
  createActiveKeyRoute,
  findRouteByActiveKey,
  invoiceAdoptionRouteKey,
  markRouteTargetBound,
} from "@/lib/agent-attachments/routes";
import { readStagingBuffer } from "@/lib/agent-attachments/storage";
import { StagingError } from "@/lib/staging-common";
import {
  createInvoiceStagingFile,
  deleteStagingFileQuietly,
  toPublicStagingMeta,
} from "@/lib/finance/invoice-staging";
import { prisma } from "@/lib/prisma";

export type AdoptAgentAttachmentAsInvoiceInput = {
  stagingFileId: string;
  expectedSha256: string;
  expectedVersion: number;
};

export type AdoptAgentAttachmentAsInvoiceResult = {
  invoiceStaging: ReturnType<typeof toPublicStagingMeta>;
  reused: boolean;
};

const MAX_ADOPT_ATTEMPTS = 3;

function assertAdoptCapability(actor: BusinessActor): void {
  if (actor.role !== "ADMIN") {
    throw new ForbiddenError("仅管理员可采纳附件为发票");
  }
}

async function findValidExistingInvoiceStaging(targetId: string) {
  const existing = await prisma.agentInvoiceStagingFile.findUnique({
    where: { id: targetId },
  });
  if (existing && existing.status !== "EXPIRED" && existing.expiresAt.getTime() > Date.now()) {
    return existing;
  }
  return null;
}

async function casPromoteInvoiceRoute(opts: {
  routeId: string;
  activeRouteKey: string;
  targetId: string;
}): Promise<boolean> {
  const promotedCas = await prisma.agentAttachmentRoute.updateMany({
    where: {
      id: opts.routeId,
      activeRouteKey: opts.activeRouteKey,
      targetId: opts.targetId,
      state: "PROCESSING",
    },
    data: { state: "PROMOTED" },
  });
  return promotedCas.count === 1;
}

async function cleanupOrphanInvoiceStagingIfUnreferenced(opts: {
  invoiceStagingId: string;
  excludeRouteId: string;
}): Promise<void> {
  const otherRouteRef = await prisma.agentAttachmentRoute.findFirst({
    where: {
      targetId: opts.invoiceStagingId,
      targetType: "INVOICE_STAGING",
      id: { not: opts.excludeRouteId },
      state: { in: ["PENDING", "PROCESSING", "PROMOTED"] },
    },
    select: { id: true },
  });
  if (otherRouteRef) return;

  const orphan = await prisma.agentInvoiceStagingFile.findUnique({
    where: { id: opts.invoiceStagingId },
    select: { id: true, storageKey: true },
  });
  if (!orphan) return;

  await deleteStagingFileQuietly(orphan.storageKey).catch(() => undefined);
  await prisma.agentInvoiceStagingFile.delete({ where: { id: orphan.id } }).catch(() => undefined);
}

export async function adoptAgentAttachmentAsInvoiceForActor(
  actor: BusinessActor,
  input: AdoptAgentAttachmentAsInvoiceInput,
  opts: { invocation?: InvocationContext } = {},
): Promise<AdoptAgentAttachmentAsInvoiceResult> {
  assertAdoptCapability(actor);

  const agentRunId = opts.invocation?.agentRunId ?? null;

  const staging = await getOwnedAgentAttachment({
    stagingId: input.stagingFileId,
    userId: actor.userId,
    requireActive: true,
  });
  assertAttachmentInCurrentRun(staging, agentRunId);
  await verifyAttachmentIntegrity({
    staging,
    expectedSha256: input.expectedSha256,
    expectedVersion: input.expectedVersion,
  });

  if (!INVOICE_ADOPTABLE_MIME.has(staging.mimeType)) {
    throw new ValidationError(
      `该附件类型（${staging.mimeType}）不可采纳为发票，仅支持 PDF/JPEG/PNG`,
    );
  }

  const activeKey = invoiceAdoptionRouteKey(actor.userId, staging.id);

  for (let attempt = 0; attempt < MAX_ADOPT_ATTEMPTS; attempt++) {
    let route;
    try {
      route = await createActiveKeyRoute({
        stagingId: staging.id,
        activeRouteKey: activeKey,
        targetType: "INVOICE_STAGING",
        expectedSha256: input.expectedSha256,
        expectedVersion: input.expectedVersion,
      });
    } catch (err) {
      const isConflict = err instanceof StagingError && err.code === "ROUTE_CONFLICT";
      if (!isConflict) throw err;

      const winner = await findRouteByActiveKey(activeKey);
      if (winner && winner.targetId && winner.state !== "STALE" && winner.state !== "FAILED") {
        const existing = await findValidExistingInvoiceStaging(winner.targetId);
        if (existing) {
          return { invoiceStaging: toPublicStagingMeta(existing), reused: true };
        }
      }

      if (winner) {
        await casMarkRouteStale({
          routeId: winner.id,
          activeRouteKey: activeKey,
          expectedStates: ["PENDING", "PROCESSING", "PROMOTED", "FAILED"],
        });
      }
      continue;
    }

    const buffer = await readStagingBuffer(staging.storageKey);
    const invoiceStagingId = randomUUID();
    const claimed = await markRouteTargetBound({
      routeId: route.id,
      activeRouteKey: activeKey,
      targetId: invoiceStagingId,
    });
    if (!claimed) {
      continue;
    }

    const invoiceStaging = await createInvoiceStagingFile({
      id: invoiceStagingId,
      createdById: actor.userId,
      agentRunId,
      originalFileName: staging.originalName,
      declaredMime: staging.mimeType,
      buffer,
    });

    const promoted = await casPromoteInvoiceRoute({
      routeId: route.id,
      activeRouteKey: activeKey,
      targetId: invoiceStaging.id,
    });
    if (promoted) {
      return { invoiceStaging: toPublicStagingMeta(invoiceStaging), reused: false };
    }

    const currentRoute = await prisma.agentAttachmentRoute.findUnique({
      where: { id: route.id },
      select: { state: true, targetId: true, activeRouteKey: true },
    });
    if (
      currentRoute
      && currentRoute.state === "PROMOTED"
      && currentRoute.targetId === invoiceStaging.id
    ) {
      return { invoiceStaging: toPublicStagingMeta(invoiceStaging), reused: true };
    }

    await cleanupOrphanInvoiceStagingIfUnreferenced({
      invoiceStagingId: invoiceStaging.id,
      excludeRouteId: route.id,
    });
  }

  throw new ValidationError("发票采纳失败：存在冲突的历史路由，请稍后重试");
}

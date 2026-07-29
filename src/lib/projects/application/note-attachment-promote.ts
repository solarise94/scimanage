/**
 * T3.4 — canonical project-note attachment promote/recover command.
 *
 * Shared by `addProjectNoteForActor` phase-2 and `resumePendingAgentAttachmentRoutes`.
 * Copy staging → private attachment (atomic), mark READY, route PROMOTED.
 * Idempotent when attachment already READY / route already PROMOTED.
 * Recoverable failures leave attachment PENDING_FILE (never mark FAILED here).
 */
import { prisma } from "@/lib/prisma";
import { verifyAttachmentIntegrity } from "@/lib/agent-attachments/staging";
import {
  markAttachmentReady,
  writePrivateAttachmentFile,
} from "@/lib/projects/application/project-attachments";
import { markRoutePromoted } from "@/lib/agent-attachments/routes";
import { readProjectAttachmentBuffer, readStagingBuffer } from "@/lib/agent-attachments/storage";
import { computeSha256 } from "@/lib/staging-common";

export type PromoteProjectNoteAttachmentInput = {
  attachmentId: string;
  projectId: string;
  storageKey: string;
  stagingStorageKey: string;
  routeId?: string | null;
  /** Recovery / defense-in-depth: verify staging hash/version before copy. */
  integrity?: {
    expectedSha256: string;
    expectedVersion: number;
    stagingSha256: string;
    stagingVersion: number;
  };
};

export type PromotedProjectNoteAttachment = {
  id: string;
  filename: string;
  mimeType: string;
  url: string;
};

export type PromoteProjectNoteAttachmentResult = {
  outcome: "promoted" | "already_ready";
  attachment: PromotedProjectNoteAttachment;
};

export class NoteAttachmentPromoteError extends Error {
  readonly recoverable: boolean;

  constructor(message: string, recoverable: boolean) {
    super(message);
    this.name = "NoteAttachmentPromoteError";
    this.recoverable = recoverable;
  }
}

async function ensureRoutePromoted(routeId: string, targetId: string): Promise<void> {
  const route = await prisma.agentAttachmentRoute.findUnique({
    where: { id: routeId },
    select: { state: true },
  });
  if (route?.state === "PROMOTED") return;
  await markRoutePromoted(routeId, targetId);
}

export async function promoteProjectNoteAttachment(
  input: PromoteProjectNoteAttachmentInput,
): Promise<PromoteProjectNoteAttachmentResult> {
  const attachment = await prisma.attachment.findUnique({
    where: { id: input.attachmentId },
    select: {
      id: true,
      projectId: true,
      status: true,
      storageKey: true,
      filename: true,
      mimeType: true,
      url: true,
    },
  });

  if (!attachment || attachment.projectId !== input.projectId) {
    throw new NoteAttachmentPromoteError("目标附件缺失", false);
  }

  if (attachment.status === "READY") {
    if (input.routeId) {
      await ensureRoutePromoted(input.routeId, attachment.id);
    }
    return {
      outcome: "already_ready",
      attachment: {
        id: attachment.id,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        url: attachment.url,
      },
    };
  }

  if (attachment.status !== "PENDING_FILE" || !attachment.storageKey) {
    throw new NoteAttachmentPromoteError("目标附件处于不可提升态", false);
  }

  let buffer: Buffer;
  try {
    if (input.integrity) {
      buffer = await verifyAttachmentIntegrity({
        staging: {
          storageKey: input.stagingStorageKey,
          sha256: input.integrity.stagingSha256,
          version: input.integrity.stagingVersion,
        },
        expectedSha256: input.integrity.expectedSha256,
        expectedVersion: input.integrity.expectedVersion,
      });
    } else {
      buffer = await readStagingBuffer(input.stagingStorageKey);
    }
  } catch (err) {
    throw new NoteAttachmentPromoteError(
      err instanceof Error ? err.message : "源文件读取失败",
      true,
    );
  }

  let needsWrite = true;
  if (input.integrity) {
    try {
      const existing = await readProjectAttachmentBuffer(attachment.storageKey);
      if (computeSha256(existing) === input.integrity.stagingSha256) {
        needsWrite = false;
      }
    } catch {
      needsWrite = true;
    }
  }

  try {
    if (needsWrite) {
      await writePrivateAttachmentFile({ storageKey: attachment.storageKey, buffer });
    }
    const ready = await prisma.$transaction((tx) =>
      markAttachmentReady(tx, attachment.id, input.projectId),
    );
    if (input.routeId) {
      await markRoutePromoted(input.routeId, ready.id);
    }
    return {
      outcome: "promoted",
      attachment: {
        id: ready.id,
        filename: ready.filename,
        mimeType: ready.mimeType,
        url: ready.url,
      },
    };
  } catch (err) {
    throw new NoteAttachmentPromoteError(
      err instanceof Error ? err.message : "附件提升失败",
      true,
    );
  }
}

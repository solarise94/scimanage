/**
 * T3.3 — canonical project note query/command.
 *
 * Shared by Agent `projects.get_notes` / `projects.add_note` (and future Web routes).
 * Write path: idempotent proposal, phase-1 tx, phase-2 file promote, partialFailures.
 */
import { prisma } from "@/lib/prisma";
import type { BusinessActor, InvocationContext } from "@/lib/application/actor";
import {
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "@/lib/application/errors";
import {
  assertAttachmentInCurrentRun,
  assertAttachmentInCurrentSession,
  getOwnedAgentAttachment,
  verifyAttachmentIntegrity,
} from "@/lib/agent-attachments/staging";
import {
  createPendingPrivateAttachment,
  extFromFileName,
} from "@/lib/projects/application/project-attachments";
import { projectNoteItemRouteKey } from "@/lib/agent-attachments/routes";
import {
  NoteAttachmentPromoteError,
  promoteProjectNoteAttachment,
} from "@/lib/projects/application/note-attachment-promote";
import type { ProjectNoteCategory } from "@/lib/project-notes/constants";
import { canContributeProject, canReadProject } from "@/lib/permissions";

export type NoteAttachmentInput = {
  stagingFileId: string;
  expectedSha256: string;
  expectedVersion: number;
};

type VerifiedNoteAttachment = {
  input: NoteAttachmentInput;
  staging: {
    id: string;
    storageKey: string;
    originalName: string;
    mimeType: string;
    sizeBytes: number;
    sha256: string;
    version: number;
  };
};

export type ListProjectNotesInput = {
  projectId: string;
  category?: ProjectNoteCategory;
  limit?: number;
  cursor?: string;
};

export type ListProjectNotesResult = {
  items: Array<{
    id: string;
    category: string;
    content: string;
    authorName: string;
    createdAt: string;
  }>;
  nextCursor: string | null;
};

export type AddProjectNoteInput = {
  projectId: string;
  content: string;
  category: ProjectNoteCategory;
  attachments: NoteAttachmentInput[];
};

export type AddProjectNoteResult = {
  note: {
    id: string;
    category: string;
    content: string;
    createdAt: string;
  };
  attachments: Array<{
    attachmentId: string;
    fileName: string;
    mimeType: string;
    url: string;
  }>;
  partialFailures: Array<{ fileName: string; reason: string }>;
};

export type PreviewAddProjectNoteInput = Pick<
  AddProjectNoteInput,
  "projectId" | "content" | "category" | "attachments"
>;

export type PreviewAddProjectNoteResult = {
  project: { id: string; name: string };
  category: ProjectNoteCategory;
  content: string;
  verifiedAttachments: VerifiedNoteAttachment[];
};

export function formatProjectNote(note: {
  id: string;
  category: string;
  content: string;
  createdAt: Date;
}) {
  return {
    id: note.id,
    category: note.category,
    content: note.content,
    createdAt: note.createdAt.toISOString(),
  };
}

export function isPrismaUniqueConstraintViolation(error: unknown): boolean {
  return Boolean(
    error
      && typeof error === "object"
      && "code" in error
      && (error as { code?: unknown }).code === "P2002",
  );
}

/**
 * 逐项服务端复核备注附件：owner/run/session/TTL/hash/version（docs §6.3.3）。
 */
export async function verifyNoteAttachments(
  actor: {
    userId: string;
    agentRunId?: string | null;
    chatSessionId?: string | null;
  },
  attachments: NoteAttachmentInput[],
): Promise<VerifiedNoteAttachment[]> {
  const verified: VerifiedNoteAttachment[] = [];
  for (const att of attachments) {
    const staging = await getOwnedAgentAttachment({
      stagingId: att.stagingFileId,
      userId: actor.userId,
      requireActive: true,
    });
    assertAttachmentInCurrentRun(staging, actor.agentRunId);
    assertAttachmentInCurrentSession(staging, actor.chatSessionId);
    await verifyAttachmentIntegrity({
      staging,
      expectedSha256: att.expectedSha256,
      expectedVersion: att.expectedVersion,
    });
    verified.push({ input: att, staging });
  }
  return verified;
}

export async function listProjectNotesForActor(
  actor: BusinessActor,
  input: ListProjectNotesInput,
): Promise<ListProjectNotesResult> {
  const limit = input.limit ?? 10;

  const readable = await canReadProject(input.projectId, actor.userId, actor.role);
  if (!readable) throw new ForbiddenError();

  const project = await prisma.project.findFirst({
    where: { id: input.projectId, deleted: false },
    select: { id: true },
  });
  if (!project) throw new NotFoundError(input.projectId);

  if (input.cursor) {
    const cursorExists = await prisma.projectNote.findFirst({
      where: {
        id: input.cursor,
        projectId: project.id,
        visibility: "INTERNAL",
        ...(input.category ? { category: input.category } : {}),
      },
      select: { id: true },
    });
    if (!cursorExists) {
      throw new ValidationError("无效的项目备注分页游标");
    }
  }

  const notes = await prisma.projectNote.findMany({
    where: {
      projectId: project.id,
      visibility: "INTERNAL",
      ...(input.category ? { category: input.category } : {}),
    },
    take: limit + 1,
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  const hasMore = notes.length > limit;
  const page = notes.slice(0, limit);

  return {
    items: page.map((note) => ({
      ...formatProjectNote(note),
      authorName: note.authorNameSnapshot,
    })),
    nextCursor: hasMore ? page.at(-1)?.id ?? null : null,
  };
}

/** Light read + attachment verify for Agent proposal card — no formal writes. */
export async function previewAddProjectNoteForActor(
  actor: BusinessActor & {
    agentRunId?: string | null;
    chatSessionId?: string | null;
  },
  input: PreviewAddProjectNoteInput,
): Promise<PreviewAddProjectNoteResult> {
  const project = await prisma.project.findFirst({
    where: { id: input.projectId, deleted: false },
    select: { id: true, name: true },
  });
  if (!project) throw new NotFoundError(input.projectId);

  // Canonical command must own its write gate — adapter checks are defense-in-depth only.
  const canContribute = await canContributeProject(project.id, actor.userId, actor.role);
  if (!canContribute) throw new ForbiddenError();

  const verifiedAttachments = await verifyNoteAttachments(actor, input.attachments);

  return {
    project: { id: project.id, name: project.name },
    category: input.category,
    content: input.content,
    verifiedAttachments,
  };
}

export async function addProjectNoteForActor(
  actor: BusinessActor,
  invocation: InvocationContext,
  input: AddProjectNoteInput,
): Promise<AddProjectNoteResult> {
  const attachmentActor = {
    userId: actor.userId,
    agentRunId: invocation.agentRunId,
    chatSessionId: invocation.chatSessionId,
  };

  const project = await prisma.project.findFirst({
    where: { id: input.projectId, deleted: false },
    select: { id: true },
  });
  if (!project) throw new NotFoundError(input.projectId);

  // Canonical command must own its write gate — adapter checks are defense-in-depth only.
  // Deliberately precedes attachment verification and proposal idempotent replay:
  // an actor who lost access must not probe attachments or replay notes.
  // Re-verified inside the phase-1 write transaction below (TOCTOU guard).
  const canContribute = await canContributeProject(project.id, actor.userId, actor.role);
  if (!canContribute) throw new ForbiddenError();

  const verified = await verifyNoteAttachments(attachmentActor, input.attachments);
  const proposalId = invocation.proposalId ?? null;

  if (proposalId) {
    const existing = await prisma.projectNote.findUnique({
      where: { sourceAgentProposalId: proposalId },
      include: {
        noteAttachments: { include: { attachment: true }, orderBy: { sortOrder: "asc" } },
      },
    });
    if (existing) {
      return formatExistingNoteResult(existing);
    }
  }

  let phase1: {
    note: { id: string };
    prepared: Array<{
      attachmentId: string;
      fileName: string;
      storageKey: string;
      stagingStorageKey: string;
      routeId: string | null;
    }>;
  };
  try {
    phase1 = await prisma.$transaction(async (tx) => {
      // TOCTOU guard: membership/linkage may have been revoked between the
      // pre-tx gate and this write. Re-verify live scope on the tx client
      // before any formal write (ProjectNote / attachments / ActivityLog).
      const canContributeInTx = await canContributeProject(
        project.id,
        actor.userId,
        actor.role,
        tx,
      );
      if (!canContributeInTx) throw new ForbiddenError();

      // Phase E（P0-3）：Agent 加备注需在最终写事务内核验技术负责人（TOCTOU）。
      if (invocation.channel === "agent") {
        const { assertAgentCanWriteProject } = await import("@/lib/orders/application/technical-owner-gate");
        await assertAgentCanWriteProject(actor, invocation, project.id, { tx });
      }

      const created = await tx.projectNote.create({
        data: {
          projectId: project.id,
          authorId: actor.userId,
          authorNameSnapshot: actor.name ?? "未知用户",
          category: input.category,
          content: input.content,
          visibility: "INTERNAL",
          source: "AGENT",
          sourceAgentProposalId: proposalId,
        },
      });

      const prepared: Array<{
        attachmentId: string;
        fileName: string;
        storageKey: string;
        stagingStorageKey: string;
        routeId: string | null;
      }> = [];

      for (let index = 0; index < verified.length; index++) {
        const v = verified[index];
        const attachment = await createPendingPrivateAttachment(tx, {
          projectId: project.id,
          filename: v.staging.originalName,
          mimeType: v.staging.mimeType,
          size: v.staging.sizeBytes,
          ext: extFromFileName(v.staging.originalName),
          source: "AGENT",
        });
        await tx.projectNoteAttachment.create({
          data: { noteId: created.id, attachmentId: attachment.id, sortOrder: index },
        });

        let routeId: string | null = null;
        if (proposalId) {
          const route = await tx.agentAttachmentRoute.findUnique({
            where: { proposalItemKey: projectNoteItemRouteKey(proposalId, v.staging.id) },
            select: { id: true },
          });
          routeId = route?.id ?? null;
        }
        if (!routeId) {
          const route = await tx.agentAttachmentRoute.create({
            data: {
              stagingId: v.staging.id,
              sourceProposalId: proposalId,
              proposalItemKey: proposalId
                ? projectNoteItemRouteKey(proposalId, v.staging.id)
                : null,
              targetType: "PROJECT_NOTE",
              state: "PENDING",
              expectedSha256: v.input.expectedSha256,
              expectedVersion: v.input.expectedVersion,
            },
            select: { id: true },
          });
          routeId = route.id;
        }
        await tx.agentAttachmentRoute.update({
          where: { id: routeId },
          data: {
            state: "PROCESSING",
            processingProposalId: proposalId,
            destinationAttachmentId: attachment.id,
          },
        });
        await tx.attachment.update({
          where: { id: attachment.id },
          data: { agentAttachmentRouteId: routeId },
        });

        prepared.push({
          attachmentId: attachment.id,
          fileName: v.staging.originalName,
          storageKey: attachment.storageKey!,
          stagingStorageKey: v.staging.storageKey,
          routeId,
        });
      }

      await tx.activityLog.create({
        data: {
          type: "PROJECT_NOTE_ADDED",
          content:
            verified.length > 0
              ? `添加了项目备注（含 ${verified.length} 个附件，由 Agent 从附件创建）`
              : "添加了项目备注",
          metadata: JSON.stringify({
            projectId: project.id,
            noteId: created.id,
            attachmentCount: verified.length,
            sourceAgentProposalId: proposalId,
          }),
          projectId: project.id,
          userId: actor.userId,
        },
      });

      return { note: created, prepared };
    });
  } catch (error) {
    if (proposalId && isPrismaUniqueConstraintViolation(error)) {
      const existing = await prisma.projectNote.findUnique({
        where: { sourceAgentProposalId: proposalId },
        include: {
          noteAttachments: { include: { attachment: true }, orderBy: { sortOrder: "asc" } },
        },
      });
      if (existing) {
        return formatExistingNoteResult(existing);
      }
    }
    throw error;
  }

  const readyAttachments: Array<{
    attachmentId: string;
    fileName: string;
    mimeType: string;
    url: string;
  }> = [];
  const partialFailures: Array<{ fileName: string; reason: string }> = [];
  for (let index = 0; index < phase1.prepared.length; index++) {
    const item = phase1.prepared[index]!;
    const verifiedItem = verified[index]!;
    try {
      const result = await promoteProjectNoteAttachment({
        attachmentId: item.attachmentId,
        projectId: project.id,
        storageKey: item.storageKey,
        stagingStorageKey: item.stagingStorageKey,
        routeId: item.routeId,
        integrity: {
          expectedSha256: verifiedItem.input.expectedSha256,
          expectedVersion: verifiedItem.input.expectedVersion,
          stagingSha256: verifiedItem.staging.sha256,
          stagingVersion: verifiedItem.staging.version,
        },
      });
      readyAttachments.push({
        attachmentId: result.attachment.id,
        fileName: result.attachment.filename,
        mimeType: result.attachment.mimeType,
        url: result.attachment.url,
      });
    } catch (err) {
      console.error("[addProjectNoteForActor] attachment promotion failed:", err);
      const reason =
        err instanceof NoteAttachmentPromoteError
          ? err.message
          : err instanceof Error
            ? err.message
            : "源文件复制失败";
      partialFailures.push({ fileName: item.fileName, reason: reason.slice(0, 200) });
    }
  }

  const note = await prisma.projectNote.findUniqueOrThrow({ where: { id: phase1.note.id } });
  return { note: formatProjectNote(note), attachments: readyAttachments, partialFailures };
}

function formatExistingNoteResult(existing: {
  id: string;
  category: string;
  content: string;
  createdAt: Date;
  noteAttachments: Array<{
    attachment: { id: string; filename: string; mimeType: string; url: string; status: string; archived: boolean };
  }>;
}): AddProjectNoteResult {
  return {
    note: formatProjectNote(existing),
    attachments: existing.noteAttachments
      // 只返回 READY 且未归档附件；归档附件的 url 已失效，不应再暴露给备注。
      .filter((l) => l.attachment.status === "READY" && !l.attachment.archived)
      .map((l) => ({
        attachmentId: l.attachment.id,
        fileName: l.attachment.filename,
        mimeType: l.attachment.mimeType,
        url: l.attachment.url,
      })),
    partialFailures: [],
  };
}

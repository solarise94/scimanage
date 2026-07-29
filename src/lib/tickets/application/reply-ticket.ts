/**
 * T4.4 — canonical reply-ticket command.
 *
 * Single formal write entry for Web `POST /api/tickets/[id]/replies` and Agent
 * `tickets.reply` confirm path.
 *
 * Reply + ActivityLog share one transaction; creator Notification and optional
 * background email run after commit (page side effects preserved). Notification
 * failures are logged, never propagated — an already-committed reply must not
 * be reported as failed (outbox-style; mirrors create-order.ts).
 */
import { prisma } from "@/lib/prisma";
import type { BusinessActor, InvocationContext } from "@/lib/application/actor";
import {
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "@/lib/application/errors";
import { canContributeProject } from "@/lib/permissions";
import type { TicketReplyRecord } from "./get-ticket-detail";

export type ReplyTicketInput = {
  ticketId: string;
  content: string;
};

export type ReplyTicketResult = {
  reply: TicketReplyRecord;
  invocation: InvocationContext;
};

const CREATOR_USER_SELECT = {
  id: true,
  email: true,
  name: true,
  emailOnTicketReply: true,
  role: true,
} as const;

type CreatorUser = {
  id: string;
  email: string | null;
  name: string | null;
  emailOnTicketReply: boolean;
  role: string;
};

const REPLY_INCLUDE = {
  author: { select: { id: true, name: true, avatar: true } },
} as const;

/**
 * Resolve ticket creator via structured `createdBy`, with ActivityLog fallback
 * for legacy rows missing the field.
 */
export async function resolveTicketCreatorUser(params: {
  ticketId: string;
  projectId: string;
  createdBy: string | null;
}): Promise<CreatorUser | null> {
  if (params.createdBy) {
    const user = await prisma.user.findUnique({
      where: { id: params.createdBy },
      select: CREATOR_USER_SELECT,
    });
    if (user) return user;
  }

  const creatorActivity = await prisma.activityLog.findFirst({
    where: {
      type: "TICKET_CREATED",
      projectId: params.projectId,
      metadata: { contains: params.ticketId },
    },
    include: { user: { select: CREATOR_USER_SELECT } },
    orderBy: { createdAt: "asc" },
  });
  return creatorActivity?.user ?? null;
}

async function notifyTicketCreatorOfReply(params: {
  ticketId: string;
  ticketTitle: string;
  projectId: string;
  createdBy: string | null;
  replierUserId: string;
}): Promise<void> {
  const creator = await resolveTicketCreatorUser({
    ticketId: params.ticketId,
    projectId: params.projectId,
    createdBy: params.createdBy,
  });
  if (!creator || creator.id === params.replierUserId || creator.role === "REPRESENTATIVE") {
    return;
  }

  const shouldEmail = !!(creator.email && creator.emailOnTicketReply);
  const notification = await prisma.notification.create({
    data: {
      userId: creator.id,
      title: `工单回复: ${params.ticketTitle}`,
      content: `有人回复了工单 "${params.ticketTitle}"`,
      type: "TICKET_REPLY",
      link: `/projects/${params.projectId}`,
      emailStatus: shouldEmail ? "pending" : null,
    },
  });

  if (shouldEmail) {
    const { sendMailInBackground } = await import("@/lib/mail");
    sendMailInBackground(
      {
        to: creator.email!,
        subject: `【SciManage】工单回复: ${params.ticketTitle}`,
        text: `您好 ${creator.name || ""}，\n\n有人回复了工单 "${params.ticketTitle}"。\n\n---\nSciManage`,
        html: `<p>您好 <strong>${creator.name || ""}</strong>，</p>
<p>有人回复了工单 <strong>"${params.ticketTitle}"</strong>。</p>
<hr />
<p style="color:#999;font-size:12px;">SciManage</p>`,
      },
      notification.id,
    );
  }
}

/**
 * Add a ticket reply with page-parity side effects.
 */
export async function replyToTicketForActor(
  actor: BusinessActor,
  invocation: InvocationContext,
  input: ReplyTicketInput,
): Promise<ReplyTicketResult> {
  const ticketId = input.ticketId?.toString().trim();
  if (!ticketId) {
    throw new ValidationError("ticketId 不能为空");
  }

  const content = input.content?.toString().trim();
  if (!content) {
    throw new ValidationError("Content is required");
  }

  const existing = await prisma.ticket.findUnique({
    where: { id: ticketId },
    include: { project: { select: { id: true, deleted: true } } },
  });
  if (!existing) {
    throw new NotFoundError("Ticket not found");
  }
  if (existing.project.deleted) {
    throw new ValidationError("项目已删除，无法回复工单");
  }

  const canContribute = await canContributeProject(
    existing.projectId,
    actor.userId,
    actor.role,
  );
  if (!canContribute) {
    throw new ForbiddenError();
  }

  const reply = await prisma.$transaction(async (tx) => {
    const created = await tx.ticketReply.create({
      data: {
        content,
        ticketId,
        authorId: actor.userId,
      },
      include: REPLY_INCLUDE,
    });

    await tx.activityLog.create({
      data: {
        type: "TICKET_UPDATED",
        content: `回复了工单 "${existing.title}"`,
        metadata: JSON.stringify({ ticketId }),
        projectId: existing.projectId,
        userId: actor.userId,
      },
    });

    return created;
  });

  await notifyTicketCreatorOfReply({
    ticketId,
    ticketTitle: existing.title,
    projectId: existing.projectId,
    createdBy: existing.createdBy,
    replierUserId: actor.userId,
  }).catch((err) => {
    console.error(
      `[tickets.reply] creator notification failed for ticket ${ticketId}:`,
      err,
    );
  });

  return { reply, invocation };
}

/**
 * Canonical actor-aware ticket detail query (T4.1).
 *
 * Consumed by `GET /api/tickets/[id]`. Object scope uses `canReadProject`;
 * missing tickets and out-of-scope both raise NotFoundError (§2.3 disclosure).
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { BusinessActor } from "@/lib/application/actor";
import { NotFoundError } from "@/lib/application/errors";
import { canContributeProject, canManageTicket, canReadProject } from "@/lib/permissions";

export const TICKET_DETAIL_INCLUDE = {
  project: { select: { id: true, name: true } },
  assignee: { select: { id: true, name: true, avatar: true } },
} satisfies Prisma.TicketInclude;

export type TicketDetailRecord = Prisma.TicketGetPayload<{ include: typeof TICKET_DETAIL_INCLUDE }>;

export type TicketReplyRecord = Prisma.TicketReplyGetPayload<{
  include: { author: { select: { id: true; name: true; avatar: true } } };
}>;

export type TicketDetailResult = {
  ticket: TicketDetailRecord;
  replies: TicketReplyRecord[];
  permissions: {
    canContribute: boolean;
    canManage: boolean;
  };
};

/** Lightweight ticket resource fields for Agent resolver / buildProposal. */
export async function getTicketResourceForActor(
  actor: BusinessActor,
  ticketId: string,
): Promise<{ id: string; title: string; projectId: string }> {
  const ticket = await prisma.ticket.findUnique({
    where: { id: ticketId },
    select: { id: true, title: true, projectId: true },
  });
  if (!ticket) {
    throw new NotFoundError("Not found");
  }

  const readable = await canReadProject(
    ticket.projectId,
    actor.userId,
    actor.role,
    prisma,
    actor.department,
  );
  if (!readable) {
    throw new NotFoundError("Not found");
  }

  return { id: ticket.id, title: ticket.title, projectId: ticket.projectId };
}

export async function getTicketDetailForActor(
  actor: BusinessActor,
  ticketId: string,
): Promise<TicketDetailResult> {
  const ticket = await prisma.ticket.findUnique({
    where: { id: ticketId },
    include: TICKET_DETAIL_INCLUDE,
  });
  if (!ticket) {
    throw new NotFoundError("Not found");
  }

  const readable = await canReadProject(
    ticket.projectId,
    actor.userId,
    actor.role,
    prisma,
    actor.department,
  );
  if (!readable) {
    throw new NotFoundError("Not found");
  }

  const [replies, canContribute, canManage] = await Promise.all([
    prisma.ticketReply.findMany({
      where: { ticketId },
      include: { author: { select: { id: true, name: true, avatar: true } } },
      orderBy: { createdAt: "asc" },
    }),
    canContributeProject(ticket.projectId, actor.userId, actor.role, prisma, actor.department),
    canManageTicket(ticket.projectId, actor.userId, actor.role, actor.department),
  ]);

  return {
    ticket,
    replies,
    permissions: { canContribute, canManage },
  };
}

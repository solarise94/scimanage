/**
 * T4.2 — canonical create-ticket command.
 *
 * Single formal write entry for Web `POST /api/tickets` and Agent
 * `tickets.create_from_text` confirm path.
 *
 * Unifies canContributeProject, deleted project, priority enum, assignee and
 * reminder validation. Ticket create + ActivityLog share one transaction.
 */
import { prisma } from "@/lib/prisma";
import type { BusinessActor, InvocationContext } from "@/lib/application/actor";
import {
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "@/lib/application/errors";
import { canContributeProject } from "@/lib/permissions";
import { TICKET_LIST_INCLUDE, type TicketListRecord } from "./query-tickets";

export const TICKET_PRIORITIES = ["LOW", "MEDIUM", "HIGH", "URGENT"] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

export type CreateTicketInput = {
  projectId: string;
  title: string;
  description?: string | null;
  priority?: string | null;
  assigneeId?: string | null;
  reminderDate?: string | Date | null;
};

export type CreateTicketResult = {
  ticket: TicketListRecord;
  invocation: InvocationContext;
};

export function normalizePriority(value: string | null | undefined): TicketPriority {
  const raw = value?.toString().trim().toUpperCase();
  if (!raw) return "MEDIUM";
  if (!TICKET_PRIORITIES.includes(raw as TicketPriority)) {
    throw new ValidationError(
      `priority 必须是 ${TICKET_PRIORITIES.join("、")} 之一`,
    );
  }
  return raw as TicketPriority;
}

export function parseReminderDate(value: string | Date | null | undefined): Date | null {
  if (value == null || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new ValidationError("reminderDate 必须是有效日期");
  }
  return date;
}

export async function assertAssigneeValid(
  assigneeId: string | null | undefined,
  projectId: string,
): Promise<string | null> {
  if (assigneeId == null || assigneeId === "") return null;
  const id = String(assigneeId).trim();
  if (!id) return null;

  const user = await prisma.user.findUnique({
    where: { id },
    select: { id: true },
  });
  if (!user) {
    throw new ValidationError("指定的负责人不存在");
  }

  const member = await prisma.projectMember.findFirst({
    where: { projectId, userId: id },
    select: { id: true },
  });
  if (!member) {
    throw new ValidationError("负责人必须是项目成员");
  }

  return id;
}

/**
 * Create a ticket with page-parity side effects (ActivityLog in same transaction).
 */
export async function createTicketForActor(
  actor: BusinessActor,
  invocation: InvocationContext,
  input: CreateTicketInput,
): Promise<CreateTicketResult> {
  const projectId = input.projectId?.toString().trim();
  if (!projectId) {
    throw new ValidationError("projectId 不能为空");
  }

  const title = input.title?.toString().trim();
  if (!title) {
    throw new ValidationError("标题不能为空");
  }

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, deleted: true },
  });
  if (!project) {
    throw new NotFoundError("Project not found");
  }
  if (project.deleted) {
    throw new ValidationError("项目已删除，无法创建工单");
  }

  const canContribute = await canContributeProject(
    projectId,
    actor.userId,
    actor.role,
  );
  if (!canContribute) {
    throw new ForbiddenError();
  }

  const priority = normalizePriority(input.priority);
  const assigneeId = await assertAssigneeValid(input.assigneeId, projectId);
  const reminderDate = parseReminderDate(input.reminderDate);
  const description =
    input.description != null ? String(input.description) : null;

  const ticket = await prisma.$transaction(async (tx) => {
    const created = await tx.ticket.create({
      data: {
        title,
        description,
        priority,
        projectId,
        assigneeId,
        createdBy: actor.userId,
        reminderDate,
        reminderSent: false,
      },
      include: TICKET_LIST_INCLUDE,
    });

    await tx.activityLog.create({
      data: {
        type: "TICKET_CREATED",
        content: `创建了工单 "${title}"`,
        metadata: JSON.stringify({ ticketId: created.id }),
        projectId,
        userId: actor.userId,
      },
    });

    return created;
  });

  return { ticket, invocation };
}

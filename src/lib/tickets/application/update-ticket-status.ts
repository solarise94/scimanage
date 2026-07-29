/**
 * T4.3 — canonical ticket update command (status + PATCH metadata fields).
 *
 * Single formal write entry for Web `PATCH /api/tickets/[id]` and Agent
 * `tickets.update_status` confirm path (Agent passes status only).
 *
 * Unifies canManageTicket, deleted project, status enum, assignee and reminder
 * validation. Ticket update + ActivityLog share one transaction; representative
 * notification runs after commit (page side effect preserved).
 */
import { prisma } from "@/lib/prisma";
import type { BusinessActor, InvocationContext } from "@/lib/application/actor";
import {
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "@/lib/application/errors";
import { canManageTicket } from "@/lib/permissions";
import {
  assertAssigneeValid,
  normalizePriority,
  parseReminderDate,
  type TicketPriority,
} from "./create-ticket";

export const TICKET_STATUSES = ["OPEN", "IN_PROGRESS", "CLOSED"] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export type UpdateTicketInput = {
  ticketId: string;
  status?: string | null;
  priority?: string | null;
  assigneeId?: string | null;
  reminderDate?: string | Date | null;
};

const TICKET_PATCH_INCLUDE = {
  project: { select: { id: true, name: true } },
  assignee: { select: { id: true, name: true, avatar: true } },
} as const;

export type TicketPatchRecord = {
  id: string;
  title: string;
  status: string;
  priority: string;
  assigneeId: string | null;
  projectId: string;
  project: { id: string; name: string };
  assignee: { id: string; name: string | null; avatar: string | null } | null;
};

export type UpdateTicketResult = {
  ticket: TicketPatchRecord;
  previousStatus: string;
  statusChanged: boolean;
  invocation: InvocationContext;
};

function normalizeStatus(value: string | null | undefined): TicketStatus | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") {
    throw new ValidationError(
      `status 必须是 ${TICKET_STATUSES.join("、")} 之一`,
    );
  }
  const raw = value.toString().trim().toUpperCase();
  if (!TICKET_STATUSES.includes(raw as TicketStatus)) {
    throw new ValidationError(
      `status 必须是 ${TICKET_STATUSES.join("、")} 之一`,
    );
  }
  return raw as TicketStatus;
}

function buildReminderUpdateData(
  reminderDate: string | Date | null | undefined,
): Record<string, unknown> {
  if (reminderDate === undefined) return {};

  if (reminderDate) {
    const parsed = parseReminderDate(reminderDate);
    if (!parsed) {
      throw new ValidationError("reminderDate 必须是有效日期");
    }
    return {
      reminderDate: parsed,
      reminderSent: false,
      reminderStatus: "PENDING",
      reminderLockedAt: null,
      reminderSentAt: null,
      reminderError: null,
    };
  }

  return {
    reminderDate: null,
    reminderSent: false,
    reminderStatus: null,
    reminderLockedAt: null,
    reminderSentAt: null,
    reminderError: null,
  };
}

async function notifyRepresentativeOfStatusChange(params: {
  projectId: string;
  ticketTitle: string;
  status: string;
}): Promise<void> {
  const project = await prisma.project.findUnique({
    where: { id: params.projectId },
    select: { representativeId: true, name: true },
  });
  if (!project?.representativeId) return;

  const rep = await prisma.representative.findUnique({
    where: { id: project.representativeId, archived: false },
    select: { name: true, email: true },
  });
  if (!rep?.email) return;

  const { notifyRepresentative } = await import("@/lib/representative-link");
  const result = await notifyRepresentative(rep.email, `/projects/${params.projectId}`, [
    {
      subject: `【SciManage】工单状态变更: ${params.ticketTitle}`,
      text: `您好 ${rep.name || ""}，\n\n工单 "${params.ticketTitle}"（项目: ${project.name}）状态已更新为 "${params.status}"。\n\n---\nSciManage`,
      html: `<p>您好 <strong>${rep.name || ""}</strong>，</p>
<p>工单 <strong>"${params.ticketTitle}"</strong>（项目: ${project.name}）状态已更新为 <strong>"${params.status}"</strong>。</p>
<hr />
<p style="color:#999;font-size:12px;">SciManage</p>`,
    },
  ]);
  if (!result.ok) {
    console.error("Failed to notify representative of ticket status change");
  }
}

/**
 * Update ticket fields with page-parity side effects.
 * Agent uses status-only subset; Web PATCH may also pass priority/assignee/reminder.
 */
export async function updateTicketForActor(
  actor: BusinessActor,
  invocation: InvocationContext,
  input: UpdateTicketInput,
): Promise<UpdateTicketResult> {
  const ticketId = input.ticketId?.toString().trim();
  if (!ticketId) {
    throw new ValidationError("ticketId 不能为空");
  }

  const existing = await prisma.ticket.findUnique({
    where: { id: ticketId },
    include: { project: { select: { id: true, deleted: true } } },
  });
  if (!existing) {
    throw new NotFoundError("Ticket not found");
  }
  if (existing.project.deleted) {
    throw new ValidationError("项目已删除，无法更新工单");
  }

  const canManage = await canManageTicket(
    existing.projectId,
    actor.userId,
    actor.role,
    actor.department,
  );
  if (!canManage) {
    throw new ForbiddenError();
  }

  const updateData: Record<string, unknown> = {};
  let nextStatus: TicketStatus | undefined;

  if (input.status !== undefined) {
    nextStatus = normalizeStatus(input.status);
    updateData.status = nextStatus;
  }
  if (input.priority !== undefined) {
    updateData.priority = normalizePriority(input.priority) as TicketPriority;
  }
  if (input.assigneeId !== undefined) {
    updateData.assigneeId = await assertAssigneeValid(
      input.assigneeId,
      existing.projectId,
    );
  }
  Object.assign(updateData, buildReminderUpdateData(input.reminderDate));

  const previousStatus = existing.status;
  const statusChanged =
    nextStatus !== undefined && nextStatus !== existing.status;

  const ticket = await prisma.$transaction(async (tx) => {
    const updated = await tx.ticket.update({
      where: { id: ticketId },
      data: updateData,
      include: TICKET_PATCH_INCLUDE,
    });

    if (statusChanged && nextStatus) {
      await tx.activityLog.create({
        data: {
          type: "TICKET_UPDATED",
          content: `工单 "${existing.title}" 状态更新为 "${nextStatus}"`,
          metadata: JSON.stringify({
            oldStatus: previousStatus,
            newStatus: nextStatus,
            ticketId,
          }),
          projectId: existing.projectId,
          userId: actor.userId,
        },
      });
    }

    return updated;
  });

  if (statusChanged && nextStatus) {
    await notifyRepresentativeOfStatusChange({
      projectId: existing.projectId,
      ticketTitle: existing.title,
      status: nextStatus,
    });
  }

  return {
    ticket,
    previousStatus,
    statusChanged,
    invocation,
  };
}

/** Status-only alias for Agent `tickets.update_status`. */
export async function updateTicketStatusForActor(
  actor: BusinessActor,
  invocation: InvocationContext,
  input: { ticketId: string; status: string },
): Promise<UpdateTicketResult> {
  return updateTicketForActor(actor, invocation, {
    ticketId: input.ticketId,
    status: input.status,
  });
}

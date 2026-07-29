import { NextRequest, NextResponse } from "next/server";
import { requirePortalSession } from "@/lib/application/http-error-mapping";
import { prisma } from "@/lib/prisma";
import { canManageTicket } from "@/lib/permissions";
import {
  businessActorFromSessionUser,
  buildInvocationContext,
} from "@/lib/application/actor";
import { ApplicationError } from "@/lib/application/errors";
import { getTicketDetailForActor } from "@/lib/tickets/application/get-ticket-detail";
import { updateTicketForActor } from "@/lib/tickets/application/update-ticket-status";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gated = await requirePortalSession();
  if (!gated.ok) return gated.response;
  const session = gated.session;

  const { id } = await params;
  const actor = businessActorFromSessionUser(session.user);

  try {
    const detail = await getTicketDetailForActor(actor, id);
    return NextResponse.json(detail);
  } catch (err) {
    if (err instanceof ApplicationError) {
      return NextResponse.json({ error: err.message }, { status: err.httpStatus });
    }
    throw err;
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gated = await requirePortalSession();
  if (!gated.ok) return gated.response;
  const session = gated.session;

  const { id } = await params;

  try {
    const body = await req.json();
    const actor = businessActorFromSessionUser(session.user);
    const invocation = buildInvocationContext({ channel: "web" });
    const { ticket } = await updateTicketForActor(actor, invocation, {
      ticketId: id,
      status: body.status,
      priority: body.priority,
      assigneeId: body.assigneeId,
      reminderDate: body.reminderDate,
    });

    return NextResponse.json({ ticket });
  } catch (err) {
    if (err instanceof ApplicationError) {
      return NextResponse.json({ error: err.message }, { status: err.httpStatus });
    }
    console.error(err);
    return NextResponse.json({ error: "Failed to update ticket" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gated = await requirePortalSession();
  if (!gated.ok) return gated.response;
  const session = gated.session;

  const { id } = await params;

  try {
    const existing = await prisma.ticket.findUnique({
      where: { id },
      include: { project: { select: { deleted: true } } },
    });
    if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const canManage = await canManageTicket(
      existing.projectId,
      session.user.id,
      session.user.role,
      session.user.department,
    );
    if (!canManage) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    await prisma.$transaction([
      prisma.ticket.delete({ where: { id } }),
      prisma.activityLog.create({
        data: {
          type: "TICKET_UPDATED",
          content: `删除了工单 "${existing.title}"`,
          metadata: JSON.stringify({ ticketId: id, title: existing.title }),
          projectId: existing.projectId,
          userId: session.user.id,
        },
      }),
    ]);

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: "Failed to delete ticket" }, { status: 500 });
  }
}

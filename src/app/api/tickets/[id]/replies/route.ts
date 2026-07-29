import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { canReadProject } from "@/lib/permissions";
import {
  businessActorFromSessionUser,
  buildInvocationContext,
} from "@/lib/application/actor";
import { ApplicationError } from "@/lib/application/errors";
import { replyToTicketForActor } from "@/lib/tickets/application/reply-ticket";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const existing = await prisma.ticket.findUnique({
    where: { id },
    include: { project: { select: { deleted: true } } },
  });

  if (!existing) {
    return NextResponse.json({ error: "Ticket not found" }, { status: 404 });
  }

  const canRead = await canReadProject(existing.projectId, session.user.id, session.user.role);
  if (!canRead) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const replies = await prisma.ticketReply.findMany({
    where: { ticketId: id },
    include: {
      author: {
        select: { id: true, name: true, avatar: true },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  return NextResponse.json({ replies });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  try {
    const body = await request.json();
    const actor = businessActorFromSessionUser(session.user);
    const invocation = buildInvocationContext({ channel: "web" });
    const { reply } = await replyToTicketForActor(actor, invocation, {
      ticketId: id,
      content: body.content,
    });

    return NextResponse.json({ reply }, { status: 201 });
  } catch (err) {
    if (err instanceof ApplicationError) {
      return NextResponse.json({ error: err.message }, { status: err.httpStatus });
    }
    console.error(err);
    return NextResponse.json({ error: "Failed to create reply" }, { status: 500 });
  }
}

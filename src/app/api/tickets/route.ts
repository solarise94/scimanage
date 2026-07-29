import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { businessActorFromSessionUser, buildInvocationContext } from "@/lib/application/actor";
import { ApplicationError } from "@/lib/application/errors";
import { createTicketForActor } from "@/lib/tickets/application/create-ticket";
import { queryTickets } from "@/lib/tickets/application/query-tickets";

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const actor = businessActorFromSessionUser(session.user);

  try {
    const result = await queryTickets(actor, {
      filters: {
        projectId: searchParams.get("projectId"),
        status: searchParams.get("status"),
        search: searchParams.get("search")?.trim(),
      },
      sort: { key: "createdAt", dir: "desc" },
      page: Math.max(1, parseInt(searchParams.get("page") || "1", 10)),
      pageSize: Math.min(
        100,
        Math.max(1, parseInt(searchParams.get("pageSize") || "20", 10)),
      ),
    });

    return NextResponse.json({
      tickets: result.tickets,
      total: result.total,
      totalPages: result.totalPages,
      page: result.page,
      pageSize: result.pageSize,
    });
  } catch (err) {
    if (err instanceof ApplicationError) {
      return NextResponse.json({ error: err.message }, { status: err.httpStatus });
    }
    throw err;
  }
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const body = await req.json();
    const actor = businessActorFromSessionUser(session.user);
    const invocation = buildInvocationContext({ channel: "web" });
    const { ticket } = await createTicketForActor(actor, invocation, {
      projectId: body.projectId,
      title: body.title,
      description: body.description,
      priority: body.priority,
      assigneeId: body.assigneeId,
      reminderDate: body.reminderDate,
    });

    return NextResponse.json({ ticket }, { status: 201 });
  } catch (err) {
    if (err instanceof ApplicationError) {
      return NextResponse.json({ error: err.message }, { status: err.httpStatus });
    }
    console.error(err);
    return NextResponse.json({ error: "Failed to create ticket" }, { status: 500 });
  }
}

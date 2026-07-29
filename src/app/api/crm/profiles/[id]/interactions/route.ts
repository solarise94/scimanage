import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { businessActorFromSessionUser, buildInvocationContext } from "@/lib/application/actor";
import { ApplicationError } from "@/lib/application/errors";
import { assertCrmProfileAccess } from "@/lib/crm/permissions";
import { interactionOperatorInclude } from "@/lib/crm/includes";
import { createInteractionForActor } from "@/lib/crm/application/create-interaction";
import { prisma } from "@/lib/prisma";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  try {
    await assertCrmProfileAccess(id, session.user.id, session.user.role);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "";
    if (msg === "NOT_FOUND") return NextResponse.json({ error: "Profile not found" }, { status: 404 });
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { searchParams } = req.nextUrl;
  const type = searchParams.get("type") || "";

  const where: Record<string, unknown> = { profileId: id };
  if (type) where.type = type;

  const interactions = await prisma.crmInteraction.findMany({
    where,
    include: interactionOperatorInclude,
    orderBy: { happenedAt: "desc" },
  });

  return NextResponse.json({ interactions });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;

  try {
    const body = await req.json();
    const actor = businessActorFromSessionUser(session.user);
    const invocation = buildInvocationContext({ channel: "web" });
    const { interaction } = await createInteractionForActor(actor, invocation, {
      profileId: id,
      type: body.type,
      summary: body.summary,
      detail: body.detail,
      happenedAt: body.happenedAt ?? new Date().toISOString(),
      nextActionAt: body.nextActionAt,
      relatedProjectId: body.relatedProjectId,
    });

    return NextResponse.json({ interaction }, { status: 201 });
  } catch (err) {
    if (err instanceof ApplicationError) {
      return NextResponse.json({ error: err.message }, { status: err.httpStatus });
    }
    throw err;
  }
}

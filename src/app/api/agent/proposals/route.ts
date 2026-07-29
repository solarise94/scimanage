import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requireBusinessActorFromSession } from "@/lib/agent-actions/actor";
import { buildAgentExecutionContext, buildInvocationContext } from "@/lib/application/actor";
import { AgentActionError, AgentActionInputError } from "@/lib/agent-actions/errors";
import { createAgentProposal, listAgentProposals } from "@/lib/agent-actions/proposals";
import { requireAgentAccess } from "@/lib/agent-actions/require-agent-access";

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const denied = requireAgentAccess(session);
  if (denied) return denied;

  try {
    const actor = requireBusinessActorFromSession(session);
    const status = req.nextUrl.searchParams.get("status")?.trim() || undefined;
    const proposals = await listAgentProposals(actor, status);
    return NextResponse.json({ proposals });
  } catch (error) {
    if (error instanceof AgentActionError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    console.error("agent proposals list failed:", error);
    return NextResponse.json({ error: "Failed to load proposals" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const denied = requireAgentAccess(session);
  if (denied) return denied;

  try {
    const body = await req.json();
    if (!body || typeof body !== "object") {
      throw new AgentActionInputError("Request body must be an object");
    }

    const actionKey = typeof body.actionKey === "string" ? body.actionKey.trim() : "";
    if (!actionKey) {
      throw new AgentActionInputError("actionKey is required");
    }

    const actor = requireBusinessActorFromSession(session);
    const ctx = buildAgentExecutionContext(actor, buildInvocationContext({ channel: "web" }));
    const proposal = await createAgentProposal(ctx, actionKey, body.input);
    return NextResponse.json({ ok: true, proposal }, { status: 201 });
  } catch (error) {
    if (error instanceof AgentActionError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    console.error("agent proposal create failed:", error);
    return NextResponse.json({ error: "Failed to create proposal" }, { status: 500 });
  }
}

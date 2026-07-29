import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requireBusinessActorFromSession } from "@/lib/agent-actions/actor";
import { buildAgentExecutionContext, buildInvocationContext } from "@/lib/application/actor";
import { AgentActionError, AgentActionInputError } from "@/lib/agent-actions/errors";
import { rejectAgentProposal } from "@/lib/agent-actions/proposals";
import { requireAgentAccess } from "@/lib/agent-actions/require-agent-access";

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const denied = requireAgentAccess(session);
  if (denied) return denied;

  try {
    const { id } = await params;
    if (!id) {
      throw new AgentActionInputError("proposal id is required");
    }

    const actor = requireBusinessActorFromSession(session);
    const ctx = buildAgentExecutionContext(actor, buildInvocationContext({ channel: "web" }));
    const { proposal } = await rejectAgentProposal(ctx, id);

    return NextResponse.json({ ok: true, proposal });
  } catch (error) {
    if (error instanceof AgentActionError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    console.error("agent proposal reject failed:", error);
    return NextResponse.json({ error: "Failed to reject proposal" }, { status: 500 });
  }
}

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requireBusinessActorFromSession } from "@/lib/agent-actions/actor";
import { buildAgentExecutionContext, buildInvocationContext } from "@/lib/application/actor";
import { AgentActionError, AgentActionInputError } from "@/lib/agent-actions/errors";
import { updateAgentProposal } from "@/lib/agent-actions/proposals";
import { requireAgentAccess } from "@/lib/agent-actions/require-agent-access";

/**
 * PATCH /api/agent/proposals/[id]
 *
 * Updates a PENDING proposal's input.  Re-runs parseInput() and buildProposal()
 * to re-validate CRM scope, target visibility, and field constraints.
 *
 * Body: { input: Record<string, unknown> }
 * Returns: { ok: true, proposal: AgentActionProposalRecord }
 *
 * @see docs/agent-mobile-crm-genui-functional-design-2026-07-14.md §6.6
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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

    const body = await req.json();
    if (!body || typeof body !== "object" || !body.input || typeof body.input !== "object") {
      throw new AgentActionInputError("input is required and must be an object");
    }

    const actor = requireBusinessActorFromSession(session);
    const ctx = buildAgentExecutionContext(actor, buildInvocationContext({ channel: "web" }));
    const proposal = await updateAgentProposal(ctx, id, body.input);

    return NextResponse.json({ ok: true, proposal });
  } catch (error) {
    if (error instanceof AgentActionError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    console.error("agent proposal update failed:", error);
    return NextResponse.json({ error: "Failed to update proposal" }, { status: 500 });
  }
}

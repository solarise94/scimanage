import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requireBusinessActorFromSession } from "@/lib/agent-actions/actor";
import { AgentActionError } from "@/lib/agent-actions/errors";
import { listAgentRunsForUser } from "@/lib/agent-actions/run-context";
import { requireAgentAccess } from "@/lib/agent-actions/require-agent-access";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const denied = requireAgentAccess(session);
  if (denied) return denied;

  try {
    const actor = requireBusinessActorFromSession(session);
    const runs = await listAgentRunsForUser(actor.userId);
    return NextResponse.json({ runs });
  } catch (error) {
    if (error instanceof AgentActionError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }

    console.error("agent runs list failed:", error);
    return NextResponse.json({ error: "Failed to load agent runs" }, { status: 500 });
  }
}

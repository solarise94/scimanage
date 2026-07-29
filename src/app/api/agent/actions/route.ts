import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requireBusinessActorFromSession } from "@/lib/agent-actions/actor";
import { listAvailableAgentActions } from "@/lib/agent-actions/registry";
import { actionToTool } from "@/lib/agent-actions/tool-adapter";
import { requireAgentAccess } from "@/lib/agent-actions/require-agent-access";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const denied = requireAgentAccess(session);
  if (denied) return denied;

  const actor = requireBusinessActorFromSession(session);
  const actions = await listAvailableAgentActions(actor);

  return NextResponse.json({
    actions: actions.map((action) => ({
      key: action.key,
      title: action.title,
      description: action.description,
      domain: action.domain,
      riskLevel: action.riskLevel,
      readOnly: action.readOnly,
      inputSchema: action.inputSchema,
      outputSchema: action.outputSchema,
    })),
    tools: actions.map(actionToTool),
  });
}

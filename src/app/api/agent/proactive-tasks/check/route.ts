import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { runDueAgentProactiveTasks } from "@/lib/agent-runtime/proactive-tasks";

export async function POST() {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const result = await runDueAgentProactiveTasks();
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    console.error("agent proactive tasks check failed:", error);
    return NextResponse.json({ error: "Failed to check proactive tasks" }, { status: 500 });
  }
}

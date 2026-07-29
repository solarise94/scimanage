import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requireAgentAccess } from "@/lib/agent-actions/require-agent-access";
import {
  adoptJobToAgentRun,
  resumeJobAfterConfirmation,
  getOwnedJob,
} from "@/lib/agent-background-jobs";
import { ensureAgentRunBelongsToSession } from "@/lib/agent-actions/run-context";

/**
 * POST /api/agent/background-jobs/[id]/resume
 *
 * 将一个 Job 接续到指定 AgentRun（owner-gated），并在 WAITING_CONFIRMATION 时
 * 唤醒 Job 继续 safe 分析。body: { agentRunId }。
 *
 * 见 docs/finance-invoice-ocr-orchestration-phase-c-implementation-2026-07-21.md §12.1。
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getServerSession(authOptions);
  const denied = requireAgentAccess(session);
  if (denied) return denied;
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { id } = await params;
    if (!id) {
      return NextResponse.json({ error: "缺少 id" }, { status: 400 });
    }

    const body = await req.json().catch(() => ({}));
    const agentRunId =
      typeof body?.agentRunId === "string" ? body.agentRunId.trim() : "";
    if (!agentRunId) {
      return NextResponse.json(
        { error: "agentRunId is required", code: "AGENT_RUN_REQUIRED" },
        { status: 400 },
      );
    }

    // 校验 AgentRun 属于当前 session。
    try {
      await ensureAgentRunBelongsToSession(agentRunId, session);
    } catch {
      return NextResponse.json(
        { error: "Agent run 不可用或不属于当前用户", code: "AGENT_RUN_FORBIDDEN" },
        { status: 403 },
      );
    }

    const adopted = await adoptJobToAgentRun({
      jobId: id,
      userId: session.user.id,
      agentRunId,
    });
    if (!adopted) {
      return NextResponse.json(
        { error: "Job 不存在或不可见", code: "JOB_NOT_FOUND" },
        { status: 404 },
      );
    }

    // 若处于 WAITING_CONFIRMATION，唤醒继续 safe 分析（worker 不登记）。
    const job = await getOwnedJob({ jobId: id, userId: session.user.id });
    if (job && job.status === "WAITING_CONFIRMATION") {
      await resumeJobAfterConfirmation({ jobId: id });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[background-jobs] resume failed:", err);
    return NextResponse.json({ error: "接续失败" }, { status: 500 });
  }
}

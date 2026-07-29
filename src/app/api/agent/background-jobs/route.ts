import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requireAgentAccess } from "@/lib/agent-actions/require-agent-access";
import { listActiveJobs } from "@/lib/agent-background-jobs";

/**
 * GET /api/agent/background-jobs
 *
 * 列出当前用户未完成的后台 Job（owner-gated）。
 * 可选 query: kind（如 INVOICE_INGEST）、limit。
 *
 * 见 docs/finance-invoice-ocr-orchestration-phase-c-implementation-2026-07-21.md §13.1。
 */
export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  const denied = requireAgentAccess(session);
  if (denied) return denied;
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const url = new URL(req.url);
    const kindParam = url.searchParams.get("kind")?.trim() || undefined;
    const limitParam = url.searchParams.get("limit")?.trim();
    const limit = limitParam ? Math.min(Math.max(Number(limitParam) || 20, 1), 50) : 20;

    const jobs = await listActiveJobs({
      userId: session.user.id,
      ...(kindParam
        ? { kind: kindParam as "INVOICE_INGEST" | "ORDER_IMPORT" | "BANK_FLOW_MATCH" }
        : {}),
      limit,
    });

    return NextResponse.json({
      items: jobs.map((job) => ({
        id: job.id,
        kind: job.kind,
        status: job.status,
        workspaceId: job.workspaceId,
        subjectType: job.subjectType,
        subjectId: job.subjectId,
        initialAgentRunId: job.initialAgentRunId,
        currentAgentRunId: job.currentAgentRunId,
        cancelRequestedAt: job.cancelRequestedAt?.toISOString() ?? null,
        heartbeatAt: job.heartbeatAt?.toISOString() ?? null,
        createdAt: job.createdAt.toISOString(),
        updatedAt: job.updatedAt.toISOString(),
      })),
    });
  } catch (err) {
    console.error("[background-jobs] list failed:", err);
    return NextResponse.json({ error: "查询失败" }, { status: 500 });
  }
}

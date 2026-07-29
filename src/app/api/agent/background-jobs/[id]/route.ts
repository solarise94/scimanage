import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requireAgentAccess } from "@/lib/agent-actions/require-agent-access";
import { getOwnedJob } from "@/lib/agent-background-jobs";

/**
 * GET /api/agent/background-jobs/[id]
 *
 * 返回单个 Job 及其 items（owner-gated）。只暴露调度状态与安全 resultSummary，
 * 不返回 OCR 原文 / 税号 / storageKey。
 *
 * 见 docs/finance-invoice-ocr-orchestration-phase-c-implementation-2026-07-21.md §13.1。
 */
export async function GET(
  _req: Request,
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

    const job = await getOwnedJob({ jobId: id, userId: session.user.id });
    if (!job) {
      return NextResponse.json({ error: "Job 不存在或不可见" }, { status: 404 });
    }

    return NextResponse.json({
      job: {
        id: job.id,
        ownerUserId: job.ownerUserId,
        workspaceId: job.workspaceId,
        kind: job.kind,
        subjectType: job.subjectType,
        subjectId: job.subjectId,
        status: job.status,
        version: job.version,
        leaseOwner: job.leaseOwner,
        leaseExpiresAt: job.leaseExpiresAt?.toISOString() ?? null,
        heartbeatAt: job.heartbeatAt?.toISOString() ?? null,
        initialAgentRunId: job.initialAgentRunId,
        currentAgentRunId: job.currentAgentRunId,
        cancelRequestedAt: job.cancelRequestedAt?.toISOString() ?? null,
        createdAt: job.createdAt.toISOString(),
        updatedAt: job.updatedAt.toISOString(),
      },
      items: job.items.map((item) => {
        let resultSummary: unknown = null;
        if (item.resultSummaryJson) {
          try {
            resultSummary = JSON.parse(item.resultSummaryJson);
          } catch {
            resultSummary = null;
          }
        }
        return {
          id: item.id,
          sequenceNo: item.sequenceNo,
          stagingType: item.stagingType,
          stagingId: item.stagingId,
          status: item.status,
          attemptCount: item.attemptCount,
          nextAttemptAt: item.nextAttemptAt?.toISOString() ?? null,
          proposalId: item.proposalId,
          errorCode: item.errorCode,
          resultSummary,
        };
      }),
    });
  } catch (err) {
    console.error("[background-jobs] get failed:", err);
    return NextResponse.json({ error: "查询失败" }, { status: 500 });
  }
}

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requireAgentAccess } from "@/lib/agent-actions/require-agent-access";
import { ensureAgentRunBelongsToSession } from "@/lib/agent-actions/run-context";
import {
  assertAndBindStagingToAgentRun,
  assertOwnedInvoiceStagingFiles,
  InvoiceStagingError,
} from "@/lib/finance/invoice-staging";
import { createInvoiceIngestJob } from "@/lib/finance/invoice-ingest-job";

/**
 * POST /api/agent/background-jobs/create-invoice-ingest
 *
 * 为一批发票 staging 创建 INVOICE_INGEST 后台 Job（owner-gated，幂等）。
 *
 * 主要接续路径已由 chat / chat-stream 在绑定 staging 后自动调用本服务的
 * createInvoiceIngestJob。此独立路由作为客户端显式触发的兜底入口
 * （例如 UI "我的未完成任务" 中重新挂起分析），UI 接续为后续迭代。
 *
 * body: { stagingFileIds: string[], agentRunId?: string }
 *
 * 见 docs/finance-invoice-ocr-orchestration-phase-c-implementation-2026-07-21.md §13.1。
 */
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const denied = requireAgentAccess(session);
  if (denied) return denied;
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const rawIds: unknown[] = Array.isArray(body?.stagingFileIds) ? body.stagingFileIds : [];
    const stagingFileIds = rawIds
      .map((x: unknown) => (typeof x === "string" ? x.trim() : ""))
      .filter(Boolean)
      .slice(0, 10);

    if (stagingFileIds.length === 0) {
      return NextResponse.json(
        { error: "stagingFileIds is required", code: "STAGING_REQUIRED" },
        { status: 400 },
      );
    }

    const agentRunId =
      typeof body?.agentRunId === "string" ? body.agentRunId.trim() : null;
    if (agentRunId) {
      try {
        await ensureAgentRunBelongsToSession(agentRunId, session);
      } catch {
        return NextResponse.json(
          { error: "Agent run 不可用或不属于当前用户", code: "AGENT_RUN_FORBIDDEN" },
          { status: 403 },
        );
      }
    }

    // 服务端重校验所有权并（若提供 agentRunId）绑定到 AgentRun。
    if (agentRunId) {
      try {
        await assertAndBindStagingToAgentRun({
          stagingFileIds,
          userId: session.user.id,
          agentRunId,
        });
      } catch (err) {
        if (err instanceof InvoiceStagingError) {
          return NextResponse.json(
            { error: err.message, code: err.code },
            { status: err.httpStatus },
          );
        }
        throw err;
      }
    } else {
      // 无 agentRunId 时同样必须校验所有权：否则可为他人 staging 建 Job，
      // 虽然 worker 的 owner 检查会跳过处理，但会污染队列与"我的任务"列表。
      try {
        await assertOwnedInvoiceStagingFiles({
          stagingFileIds,
          userId: session.user.id,
        });
      } catch (err) {
        if (err instanceof InvoiceStagingError) {
          return NextResponse.json(
            { error: err.message, code: err.code },
            { status: err.httpStatus },
          );
        }
        throw err;
      }
    }

    const result = await createInvoiceIngestJob({
      ownerUserId: session.user.id,
      stagingFileIds,
      agentRunId,
    });
    if (!result) {
      return NextResponse.json(
        { error: "无可创建的 staging 文件", code: "STAGING_EMPTY" },
        { status: 400 },
      );
    }

    return NextResponse.json(
      { ok: true, jobId: result.jobId, workspaceId: result.workspaceId, created: result.created },
      { status: result.created ? 201 : 200 },
    );
  } catch (err) {
    console.error("[background-jobs] create-invoice-ingest failed:", err);
    return NextResponse.json({ error: "创建失败" }, { status: 500 });
  }
}

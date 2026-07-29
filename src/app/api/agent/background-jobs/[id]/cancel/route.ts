import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requireAgentAccess } from "@/lib/agent-actions/require-agent-access";
import { requestCancelJob } from "@/lib/agent-background-jobs";

/**
 * POST /api/agent/background-jobs/[id]/cancel
 *
 * 请求取消一个 Job（owner-gated）。只阻止领取新 item；
 * 已登记的发票不回滚，正在运行的 safe handler 在安全点结束。
 *
 * 见 docs/finance-invoice-ocr-orchestration-phase-c-implementation-2026-07-21.md §12.1。
 */
export async function POST(
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

    const ok = await requestCancelJob({
      jobId: id,
      userId: session.user.id,
    });
    if (!ok) {
      return NextResponse.json(
        { error: "Job 不存在、不可见或已结束", code: "JOB_NOT_CANCELLABLE" },
        { status: 409 },
      );
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[background-jobs] cancel failed:", err);
    return NextResponse.json({ error: "取消失败" }, { status: 500 });
  }
}

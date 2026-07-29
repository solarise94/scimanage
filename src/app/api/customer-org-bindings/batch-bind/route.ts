import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { executeCustomerOrgBinding } from "@/lib/crm/customer-org-binding";

async function assertAdmin(session: { user: { id: string; role: string } } | null) {
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = await prisma.user.findUnique({ where: { id: session.user.id }, select: { role: true } });
  if (!user || user.role !== "ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  return null;
}

// POST /api/customer-org-bindings/batch-bind
// Body: { mode: "UNIFY", taskIds: string[], organizationId: string, siteId?: string }
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  const forbidden = await assertAdmin(session);
  if (forbidden) return forbidden;

  const userId = session!.user.id;
  const body = await req.json().catch(() => ({}));

  const mode = body?.mode;
  const taskIds: string[] = Array.isArray(body?.taskIds) ? body.taskIds : [];
  const organizationId: string | undefined = body?.organizationId;
  const siteId: string | null = body?.siteId || null;

  if (mode !== "UNIFY") {
    return NextResponse.json({ error: "不支持的批量模式" }, { status: 400 });
  }

  if (taskIds.length === 0) {
    return NextResponse.json({ error: "请至少选择一条任务" }, { status: 400 });
  }

  if (!organizationId) {
    return NextResponse.json({ error: "绑定机构为必填" }, { status: 400 });
  }

  if (taskIds.length > 200) {
    return NextResponse.json({ error: "单次最多处理 200 条" }, { status: 400 });
  }

  // 预拉取任务与 Profile ID，避免每条单独查询
  const tasks = await prisma.customerOrgBindingTask.findMany({
    where: { id: { in: taskIds }, status: "PENDING" },
    select: {
      id: true,
      profileId: true,
      customerName: true,
    },
  });

  const taskMap = new Map(tasks.map((t) => [t.id, t]));
  const missingIds = taskIds.filter((id) => !taskMap.has(id));

  const results: Array<{
    taskId: string;
    label: string;
    ok: boolean;
    skipped?: boolean;
    error?: string;
  }> = [];

  for (const taskId of taskIds) {
    const task = taskMap.get(taskId);
    if (!task) {
      results.push({ taskId, label: taskId, ok: false, error: "任务不存在" });
      continue;
    }

    if (!task.profileId) {
      results.push({
        taskId,
        label: task.customerName || taskId,
        ok: false,
        error: "任务缺少 profileId",
      });
      continue;
    }

    const outcome = await executeCustomerOrgBinding(
      taskId,
      task.profileId,
      organizationId,
      siteId,
      userId,
      `批量绑定（统一机构）`,
    );

    results.push({
      taskId,
      label: task.customerName || taskId,
      ok: outcome.success,
      error: outcome.success ? undefined : outcome.message,
    });
  }

  const succeeded = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;

  return NextResponse.json({
    succeeded,
    failed,
    missingIds,
    results,
  });
}

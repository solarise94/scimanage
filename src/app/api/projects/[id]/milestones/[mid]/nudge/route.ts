import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { canReadProject } from "@/lib/permissions";
import { MANUAL_NUDGE_RATELIMIT_MS, BUSINESS_EMAIL_TYPE } from "@/lib/business-email/constants";

// 手动催办（邮件 C，§6.4）。权限：canReadProject（项目成员均可催办，不必 owner）。
// 1h 软限速复用 nudgeLastSentAt；手动催办忽略 suppressUntil。

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; mid: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id: projectId, mid } = await params;
  const canRead = await canReadProject(projectId, session.user.id, session.user.role);
  if (!canRead) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const milestone = await prisma.milestone.findUnique({
    where: { id: mid },
    select: {
      id: true, projectId: true, name: true, dueDate: true, doneAt: true, nudgeLastSentAt: true,
      project: { select: { id: true, name: true } },
    },
  });
  if (!milestone || milestone.projectId !== projectId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (milestone.doneAt) {
    return NextResponse.json({ ok: false, reason: "ALREADY_DONE", error: "该节点已完成，无需催办" }, { status: 400 });
  }

  // §4.5 1h 软限速 — 不报错，返回友好提示
  const now = Date.now();
  const lastSent = milestone.nudgeLastSentAt?.getTime() ?? 0;
  const elapsed = now - lastSent;
  if (lastSent > 0 && elapsed < MANUAL_NUDGE_RATELIMIT_MS) {
    const retryAfterMinutes = Math.ceil((MANUAL_NUDGE_RATELIMIT_MS - elapsed) / 60000);
    return NextResponse.json({ ok: false, reason: "RATE_LIMITED", retryAfterMinutes });
  }

  // 同步发邮件 C（忽略 suppressUntil）
  const { sendMilestoneNudge } = await import("@/lib/business-email/notify");
  let result: { recipients: number; sent: number; failed: number };
  try {
    result = await sendMilestoneNudge({
      milestoneId: milestone.id,
      projectId: milestone.project.id,
      projectName: milestone.project.name,
      milestoneName: milestone.name,
      dueDate: milestone.dueDate,
      manual: true,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "发送失败";
    console.error(`[BIZ_EMAIL][MILESTONE_MANUAL_NUDGE] failed for ${mid}:`, msg);
    return NextResponse.json({ ok: false, reason: "SEND_FAILED", error: "催办邮件发送失败" }, { status: 500 });
  }

  if (result.recipients === 0) {
    return NextResponse.json({ ok: false, reason: "NO_RECIPIENT", error: "该节点未绑定任何有效收件人" }, { status: 400 });
  }

  // 更新 nudgeLastSentAt（同时影响后续 24h 自动催办去重，预期行为）
  await prisma.milestone.update({
    where: { id: mid },
    data: { nudgeLastSentAt: new Date(), nudgeError: null },
  });

  // 写 Notification（操作人）+ ActivityLog
  await prisma.notification.create({
    data: {
      userId: session.user.id,
      title: `已催办节点: ${milestone.name}`,
      content: `已向 ${result.recipients} 个收件人发送「${milestone.name}」催办邮件（成功 ${result.sent}，失败 ${result.failed}）。`,
      type: BUSINESS_EMAIL_TYPE.MILESTONE_MANUAL_NUDGE,
      link: `/projects/${projectId}`,
    },
  }).catch(() => {});

  await prisma.activityLog.create({
    data: {
      type: "MILESTONE_NUDGED",
      content: `手动催办了节点「${milestone.name}」（${result.sent}/${result.recipients} 成功）`,
      projectId,
      userId: session.user.id,
    },
  }).catch(() => {});

  return NextResponse.json({
    ok: true,
    recipients: result.recipients,
    sent: result.sent,
    failed: result.failed,
  });
}

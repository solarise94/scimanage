import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolveApplicationSupervisors, SUPERVISOR_REASON_LABELS } from "@/lib/crm/supervisor";
import { sendMail } from "@/lib/mail";
import { getAppBaseUrl } from "@/lib/app-url";
import crypto from "crypto";

function hashIds(ids: string[]): string {
  return crypto.createHash("sha256").update([...ids].sort().join(",")).digest("hex").slice(0, 16);
}

export async function POST(req: NextRequest) {
  const token = process.env.CRM_REVIEW_CRON_TOKEN || process.env.REMINDER_CRON_TOKEN;

  if (!token) {
    console.error("[CRON][CRM-REVIEW] No token configured (CRM_REVIEW_CRON_TOKEN or REMINDER_CRON_TOKEN)");
    return NextResponse.json({ ok: false, error: "CRM_REVIEW_CRON_TOKEN not configured" }, { status: 500 });
  }

  const auth = req.headers.get("authorization");
  const expected = `Bearer ${token}`;
  if (!auth || auth !== expected) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await scanAndNotifySupervisorReviews();
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "未知错误";
    console.error("[CRON][CRM-REVIEW] Failed:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

async function scanAndNotifySupervisorReviews() {
  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

  // Find all pending supervisor review applications (including legacy)
  const applications = await prisma.crmCustomerApplication.findMany({
    where: {
      status: "APPROVED",
      autoApproved: true,
      OR: [
        { supervisorReviewStatus: "PENDING" },
        { adminReviewStatus: "PENDING", supervisorReviewStatus: "NONE" },
      ],
    },
    select: {
      id: true,
      name: true,
      organization: true,
      supervisorReviewReason: true,
      submittedByUserId: true,
    },
  });

  if (applications.length === 0) return { scanned: 0, notified: 0 };

  // Group by supervisor userId → application list
  const supervisorApps = new Map<string, Array<typeof applications[number]>>();

  for (const app of applications) {
    const supervisors = await resolveApplicationSupervisors(app.submittedByUserId);
    for (const s of supervisors) {
      const list = supervisorApps.get(s.id) || [];
      list.push(app);
      supervisorApps.set(s.id, list);
    }
  }

  let notified = 0;
  const baseUrl = getAppBaseUrl();

  for (const [userId, apps] of supervisorApps.entries()) {
    // Determine new apps for this supervisor
    const currentIds = apps.map((a) => a.id);
    const notifiedRecords = await prisma.crmApplicationSupervisorNotification.findMany({
      where: { userId, applicationId: { in: currentIds } },
      select: { applicationId: true },
    });
    const notifiedSet = new Set(notifiedRecords.map((r) => r.applicationId));
    const newAppIds = currentIds.filter((id) => !notifiedSet.has(id));

    // Look up digest
    const digest = await prisma.crmApplicationSupervisorDigest.findUnique({
      where: { userId },
    });
    const currentFingerprint = hashIds(currentIds);

    const isFirstEmail = !digest || !digest.lastEmailedAt;
    const isOverdue = digest?.lastEmailedAt && digest.lastEmailedAt <= oneHourAgo;
    const hasNewApps = newAppIds.length > 0;

    if (!isFirstEmail && !isOverdue && !hasNewApps) continue;

    const supervisor = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, name: true },
    });
    if (!supervisor?.email) continue;

    const pendingCount = apps.length;
    const top5 = apps.slice(0, 5).map((a) => {
      const reason = SUPERVISOR_REASON_LABELS[a.supervisorReviewReason ?? ""] || "常规复核";
      const isNew = newAppIds.includes(a.id) ? " 【新】" : "";
      return `<li>${a.name}（${a.organization || "-"}）-- ${reason}${isNew}</li>`;
    }).join("");

    const newSection = hasNewApps
      ? `<p style="color: #dc2626;">其中 <strong>${newAppIds.length}</strong> 条为新申请。</p>`
      : "";

    const htmlBody = `<div style="font-family: sans-serif; max-width: 500px; margin: 0 auto;">
<h2 style="color: #2563eb;">SciManage 客户申请待复核</h2>
<p>${supervisor.name} 您好，</p>
<p>您有 <strong>${pendingCount}</strong> 条客户申请待复核。</p>
${newSection}
${top5 ? `<ul>${top5}</ul>` : ""}
${pendingCount > 5 ? `<p>... 以及其他 ${pendingCount - 5} 条申请</p>` : ""}
<p><a href="${baseUrl}/crm/customer-applications?view=review" style="display: inline-block; background: #0284c7; color: white; padding: 10px 20px; text-decoration: none; border-radius: 6px;">查看待复核申请</a></p>
<hr style="border: none; border-top: 1px solid #e2e8f0; margin: 24px 0;" />
<p style="color: #64748b; font-size: 12px;">SciManage 科研项目管理平台 -- 此邮件每小时发送一次</p>
</div>`;

    try {
      await sendMail({
        to: supervisor.email,
        subject: "【SciManage】客户申请待复核",
        html: htmlBody,
        text: `您好 ${supervisor.name}，您有 ${pendingCount} 条客户申请待复核，其中 ${newAppIds.length} 条为新申请。请登录系统查看。`,
      });

      // Upsert digest
      await prisma.crmApplicationSupervisorDigest.upsert({
        where: { userId },
        create: { userId, lastFingerprint: currentFingerprint, lastEmailedAt: now },
        update: { lastFingerprint: currentFingerprint, lastEmailedAt: now },
      });

      // Upsert per-pair notification records (audit trail)
      for (const app of apps) {
        await prisma.crmApplicationSupervisorNotification.upsert({
          where: { applicationId_userId: { applicationId: app.id, userId } },
          create: { applicationId: app.id, userId, lastEmailedAt: now },
          update: { lastEmailedAt: now },
        });
      }

      // Coarse index on applications
      for (const app of apps) {
        await prisma.crmCustomerApplication.updateMany({
          where: { id: app.id },
          data: { notifiedSupervisorAt: now },
        });
      }

      notified++;
    } catch (e) {
      console.error(`[CRON][CRM-REVIEW] Failed to email supervisor ${supervisor.email}:`, e);
    }
  }

  return {
    scanned: applications.length,
    notified,
    distinctSupervisors: supervisorApps.size,
  };
}

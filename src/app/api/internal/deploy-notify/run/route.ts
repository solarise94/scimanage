import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { sendMail } from "@/lib/mail";

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export async function POST(req: NextRequest) {
  const token = process.env.DEPLOY_NOTIFY_TOKEN || process.env.REMINDER_CRON_TOKEN;

  if (!token) {
    console.error(
      "[DEPLOY_NOTIFY][API] DEPLOY_NOTIFY_TOKEN / REMINDER_CRON_TOKEN not configured",
    );
    return NextResponse.json(
      {
        ok: false,
        error: "DEPLOY_NOTIFY_TOKEN / REMINDER_CRON_TOKEN not configured on server",
      },
      { status: 500 },
    );
  }

  const auth = req.headers.get("authorization");
  const expected = `Bearer ${token}`;

  if (!auth || auth !== expected) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const target = String(body.target || "");
  const service = String(body.service || "");
  const publicUrl = String(body.publicUrl || "");
  const oldSha = body.oldSha ? String(body.oldSha) : null;
  const newSha = String(body.newSha || "");
  const newShortSha = String(body.newShortSha || "");
  const deployedAt = String(body.deployedAt || "");
  const deployedBy = body.deployedBy ? String(body.deployedBy) : undefined;
  const commitMessage = String(body.commitMessage || "");
  const changeLog = String(body.changeLog || "");

  try {
    const admins = await prisma.user.findMany({
      where: { role: "ADMIN" },
      select: { email: true, name: true },
    });

    let sent = 0;
    let failed = 0;

    const subject = `【SciManage 部署更新】${target.toUpperCase()} 已更新到 ${newShortSha}`;

    const textLines = [
      `环境：${target}`,
      `服务：${service}`,
      `地址：${publicUrl}`,
      oldSha ? `上次版本：${oldSha}` : "上次版本：（首次记录）",
      `当前版本：${newShortSha}`,
      `当前提交：${commitMessage}`,
      `部署时间：${deployedAt}`,
      deployedBy ? `部署者：${deployedBy}` : "",
      "",
      "本次更新：",
      changeLog || "（无详细变更记录）",
    ].filter((line) => line !== "");

    const text = textLines.join("\n");

    const html = `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>${escapeHtml(subject)}</title>
</head>
<body style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; color: #1e293b;">
  <h2 style="color: #0f172a; border-bottom: 2px solid #e2e8f0; padding-bottom: 12px;">SciManage 部署更新</h2>
  <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
    <tr><td style="padding: 6px 0; color: #64748b; width: 100px;">环境</td><td style="padding: 6px 0;"><strong>${escapeHtml(target)}</strong></td></tr>
    <tr><td style="padding: 6px 0; color: #64748b;">服务</td><td style="padding: 6px 0;">${escapeHtml(service)}</td></tr>
    <tr><td style="padding: 6px 0; color: #64748b;">地址</td><td style="padding: 6px 0;"><a href="${escapeHtml(publicUrl)}" style="color: #2563eb;">${escapeHtml(publicUrl)}</a></td></tr>
    <tr><td style="padding: 6px 0; color: #64748b;">上次版本</td><td style="padding: 6px 0;">${oldSha ? escapeHtml(oldSha) : '<span style="color: #94a3b8;">首次记录</span>'}</td></tr>
    <tr><td style="padding: 6px 0; color: #64748b;">当前版本</td><td style="padding: 6px 0;"><code style="background: #f1f5f9; padding: 2px 6px; border-radius: 4px;">${escapeHtml(newShortSha)}</code></td></tr>
    <tr><td style="padding: 6px 0; color: #64748b;">当前提交</td><td style="padding: 6px 0;">${escapeHtml(commitMessage)}</td></tr>
    <tr><td style="padding: 6px 0; color: #64748b;">部署时间</td><td style="padding: 6px 0;">${escapeHtml(deployedAt)}</td></tr>
    ${deployedBy ? `<tr><td style="padding: 6px 0; color: #64748b;">部署者</td><td style="padding: 6px 0;">${escapeHtml(deployedBy)}</td></tr>` : ""}
  </table>
  <h3 style="color: #0f172a; margin-top: 24px;">本次更新</h3>
  <pre style="background: #f8fafc; padding: 16px; border-radius: 8px; overflow-x: auto; line-height: 1.6; font-size: 14px;">${escapeHtml(changeLog || "（无详细变更记录）")}</pre>
  <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 32px 0;" />
  <p style="color: #94a3b8; font-size: 12px;">本邮件由 SciManage 部署脚本自动生成。</p>
</body>
</html>
`.trim();

    for (const admin of admins) {
      if (!admin.email) continue;
      try {
        await sendMail({
          to: admin.email,
          subject,
          text,
          html,
        });
        sent++;
      } catch (error) {
        const msg = error instanceof Error ? error.message : "未知错误";
        console.error(`[DEPLOY_NOTIFY][API] Failed to send to ${admin.email}:`, msg);
        failed++;
      }
    }

    return NextResponse.json({ ok: true, admins: admins.length, sent, failed });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "未知错误";
    console.error("[DEPLOY_NOTIFY][API] Unexpected error:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

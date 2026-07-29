import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { sendMail } from "@/lib/mail";
import { issueOrReuseRepresentativeMagicLink } from "@/lib/representative-link";
import { getSafeRedirect } from "@/lib/safe-redirect";

const MAGIC_LINK_COOLDOWN_MS = 60 * 1000;

async function isMagicLinkCoolingDown(identifier: string): Promise<boolean> {
  const record = await prisma.failedLoginAttempt.findUnique({
    where: { identifier },
    select: { lockedUntil: true },
  });
  if (!record?.lockedUntil) return false;

  const now = new Date();
  if (record.lockedUntil > now) {
    return true;
  }

  await prisma.failedLoginAttempt.delete({
    where: { identifier },
  }).catch(() => {});
  return false;
}

async function markMagicLinkCooldown(identifier: string): Promise<void> {
  const now = new Date();
  const lockedUntil = new Date(now.getTime() + MAGIC_LINK_COOLDOWN_MS);

  await prisma.failedLoginAttempt.upsert({
    where: { identifier },
    create: {
      identifier,
      attempts: 0,
      lastAttempt: now,
      lockedUntil,
    },
    update: {
      attempts: 0,
      lastAttempt: now,
      lockedUntil,
    },
  });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const email = typeof body.email === "string" ? body.email : "";

    if (!email?.trim()) {
      return NextResponse.json({ error: "邮箱不能为空" }, { status: 400 });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const cooldownIdentifier = `magic-link:${normalizedEmail}`;

    const rep = await prisma.representative.findUnique({
      where: { email: normalizedEmail },
    });

    if (!rep) {
      // Don't reveal whether the email exists
      return NextResponse.json({ success: true });
    }

    if (rep.archived) {
      return NextResponse.json({ error: "该代表账号已归档，无法登录" }, { status: 403 });
    }

    if (await isMagicLinkCoolingDown(cooldownIdentifier)) {
      return NextResponse.json({ success: true });
    }

    // Only accept same-origin safe paths. Empty fallback means invalid redirects are omitted.
    const rawRedirect = typeof body.redirect === "string" ? body.redirect : undefined;
    const redirect = getSafeRedirect(rawRedirect, "", req.nextUrl.origin) || undefined;
    const { magicLink } = await issueOrReuseRepresentativeMagicLink(rep.id, redirect);
    await markMagicLinkCooldown(cooldownIdentifier);

    // Send email in background — token is already saved, delivery failure is non-fatal
    sendMail({
      to: rep.email,
      subject: "【SciManage】代表账号登录链接",
      text: `您好 ${rep.name}，\n\n请使用以下链接登录 SciManage（有效期 24 小时）：\n\n${magicLink}\n\n---\nSciManage 科研项目管理平台`,
      html: `<div style="font-family: sans-serif; max-width: 500px; margin: 0 auto;">
  <h2 style="color: #2563eb;">SciManage 代表登录</h2>
  <p>您好 <strong>${rep.name}</strong>，</p>
  <p>请使用以下链接登录系统（有效期 24 小时）：</p>
  <a href="${magicLink}" style="display: inline-block; background: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; margin: 16px 0;">立即登录</a>
  <p style="color: #64748b; font-size: 12px;">如果按钮无法点击，请复制以下链接到浏览器打开：<br/>${magicLink}</p>
  <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 24px 0;" />
  <p style="color: #64748b; font-size: 12px;">SciManage 科研项目管理平台</p>
</div>`,
    }).catch((err) => {
      console.error("[MAGIC_LINK] SMTP failed for", rep.email, err);
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: "Failed to send magic link" }, { status: 500 });
  }
}

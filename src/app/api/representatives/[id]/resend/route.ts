import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sendMail } from "@/lib/mail";
import { issueOrReuseRepresentativeMagicLink } from "@/lib/representative-link";

async function assertAdmin(session: { user?: { id?: string } } | null) {
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const currentUser = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { role: true },
  });
  if (currentUser?.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return null;
}

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  const forbidden = await assertAdmin(session);
  if (forbidden) return forbidden;

  const { id } = await params;

  try {
    const rep = await prisma.representative.findUnique({ where: { id } });
    if (!rep) return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (rep.kind === "SYSTEM") {
      return NextResponse.json({ error: "本部系统代表不支持登录链接" }, { status: 403 });
    }
    if (rep.archived) {
      return NextResponse.json({ error: "该代表账号已归档，无法重发登录链接" }, { status: 403 });
    }

    const { magicLink } = await issueOrReuseRepresentativeMagicLink(rep.id);

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
      console.error("[MAGIC_LINK] SMTP resend failed for", rep.email, err);
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: "Failed to resend magic link" }, { status: 500 });
  }
}

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sendMailInBackground } from "@/lib/mail";

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { notificationId } = await req.json();
    if (!notificationId || typeof notificationId !== "string") {
      return NextResponse.json({ error: "缺少 notificationId" }, { status: 400 });
    }

    const notification = await prisma.notification.findUnique({
      where: { id: notificationId },
    });

    if (!notification || notification.userId !== session.user.id) {
      return NextResponse.json({ error: "通知不存在" }, { status: 404 });
    }

    if (notification.emailStatus !== "failed") {
      return NextResponse.json({ error: "该通知邮件无需重发" }, { status: 400 });
    }

    // Get user's email
    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { email: true, name: true },
    });

    if (!user?.email) {
      return NextResponse.json({ error: "未设置邮箱" }, { status: 400 });
    }

    // Mark as pending and retry
    await prisma.notification.update({
      where: { id: notificationId },
      data: { emailStatus: "pending", emailError: null },
    });

    sendMailInBackground({
      to: user.email,
      subject: `【SciManage】${notification.title}`,
      text: notification.content,
      html: `<p>${notification.content.replace(/\n/g, "<br/>")}</p>
<hr style="border: none; border-top: 1px solid #e2e8f0;" />
<p style="color: #64748b; font-size: 12px;">SciManage 科研项目管理平台</p>`,
    }, notificationId);

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: "重发失败" }, { status: 500 });
  }
}

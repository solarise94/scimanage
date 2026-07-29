import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sendMail, smtpEnabled } from "@/lib/mail";

export async function POST() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!smtpEnabled()) {
    return NextResponse.json({ error: "SMTP not configured" }, { status: 503 });
  }

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { email: true, name: true },
  });
  if (!user?.email) {
    return NextResponse.json({ error: "No email address" }, { status: 400 });
  }

  try {
    const result = await sendMail({
      to: user.email,
      subject: "【SciManage】邮件服务测试",
      text: `您好 ${user.name || ""}，\n\n这是 SciManage 项目管理系统的邮件服务测试。如果您收到此邮件，说明 SMTP 配置正确。\n\n---\nSciManage 自动发送`,
      html: `<p>您好 <strong>${user.name || ""}</strong>，</p>
<p>这是 SciManage 项目管理系统的邮件服务测试。如果您收到此邮件，说明 SMTP 配置正确。</p>
<hr />
<p style="color:#999;font-size:12px;">SciManage 自动发送</p>`,
    });
    return NextResponse.json({ success: true, messageId: result.messageId, to: user.email });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

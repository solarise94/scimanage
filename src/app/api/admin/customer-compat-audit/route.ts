import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";

/** W5.1：兼容层审计 API 已退役，停止聚合并引导切到 Profile 主路径。 */
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return NextResponse.json(
    {
      error: "Gone",
      message: "兼容层审计已下线（W5.1）；CustomerApiAuditLog 历史保留但不再写入/展示",
    },
    { status: 410 },
  );
}

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isInternalStaff } from "@/lib/role-guards";

// 只读的外部通讯录选择列表（供项目节点收件人绑定使用）。
// 仅返回启用且未归档的最小字段；内部员工（ADMIN/USER）可读，避免暴露 ADMIN-only 管理端点。

export async function GET(_req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isInternalStaff(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const contacts = await prisma.externalContact.findMany({
    where: { archived: false, enabled: true },
    orderBy: [{ department: "asc" }, { name: "asc" }],
    select: { id: true, name: true, email: true, department: true },
  });

  return NextResponse.json({ contacts });
}

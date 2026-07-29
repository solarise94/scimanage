import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { scanOrgTextBindingMismatch } from "@/lib/governance/org-text-mismatch-scan";

/**
 * M1 语义层扫描接口（设计文档 §八 Phase G6）。只读：返回“机构文本与绑定机构不一致”的客户。
 * 需引擎扫描（归一化比对），不进 counts 轻量接口（§7.1），由 M1 tab 首次加载时异步拉取。
 */
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { role: true },
  });
  if (!user || user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const records = await scanOrgTextBindingMismatch();
  return NextResponse.json({ records, total: records.length });
}

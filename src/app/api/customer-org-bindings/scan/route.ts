import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { scanUnboundCustomers } from "@/lib/customers/customer-org-binding-scan";

async function assertAdmin(session: { user: { id: string; role: string } } | null) {
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = await prisma.user.findUnique({ where: { id: session.user.id }, select: { role: true } });
  if (!user || user.role !== "ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  return null;
}

// 需求 1 · 触发无机构客户扫描。body 可带 force?: boolean（默认 false）。
// force=true 时会把已 IGNORED 的任务重建为 PENDING（不触碰 PROCESSING）。
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  const forbidden = await assertAdmin(session);
  if (forbidden) return forbidden;

  let force = false;
  try {
    const body = await req.json().catch(() => ({}));
    force = body?.force === true;
  } catch {
    // 空 body 容错
  }

  const result = await scanUnboundCustomers(session!.user.id, force);
  return NextResponse.json(result);
}

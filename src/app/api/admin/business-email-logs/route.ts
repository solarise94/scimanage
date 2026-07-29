import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// 商务邮件发送历史（仅 ADMIN）。见 docs/business-email-notification-design-2026-06-26.md §9 item 4
//   及 docs/order-rep-notify-email-design-2026-07-26.md §7.3（H 下单代表通知：补 orderId/representativeId）
// 记录的是发往外部收件人（外部联系人/财务部）与下单代表的商务邮件（B/C/D/E/F/F2 + H）；
// 成员通知（A/G）在站内通知中心。findMany 默认返回全部列（含 orderId/representativeId）。

const PAGE_SIZE = 50;

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { searchParams } = new URL(req.url);
  const type = searchParams.get("type")?.trim() || null;
  const status = searchParams.get("status")?.trim() || null;
  const search = searchParams.get("search")?.trim() || null;
  const page = Math.max(1, Number(searchParams.get("page")) || 1);

  const filters: Record<string, unknown>[] = [];
  if (type) filters.push({ type });
  if (status) filters.push({ status });
  if (search) {
    filters.push({
      OR: [
        { toEmail: { contains: search } },
        { toName: { contains: search } },
        { subject: { contains: search } },
      ],
    });
  }
  const where = filters.length > 0 ? { AND: filters } : {};

  const [total, logs] = await Promise.all([
    prisma.businessEmailLog.count({ where }),
    prisma.businessEmailLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
  ]);

  return NextResponse.json({
    logs,
    total,
    page,
    pageSize: PAGE_SIZE,
    totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
  });
}

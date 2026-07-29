import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { GOVERNANCE_ORDER_STATUSES } from "@/lib/governance/common";

const PAGE_SIZE = 20;

// GET /api/admin/data-governance/no-customer-orders?page=1
// 列出 profileId 为 null 的已落库订单（G1 真黑洞：未挂 Profile）。
// 不含正常 Profile-only 订单（profileId!=null 且 customerId=null）。
// 口径与 counts 统一：含 DELIVERED（新导入订单落库即 DELIVERED）。
export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { searchParams } = new URL(req.url);
  const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(searchParams.get("pageSize") || String(PAGE_SIZE), 10) || PAGE_SIZE));

  const where = {
    deleted: false,
    archived: false,
    profileId: null,
    status: { in: [...GOVERNANCE_ORDER_STATUSES] },
  };

  const [orders, total] = await Promise.all([
    prisma.order.findMany({
      where,
      select: {
        id: true,
        orderNo: true,
        status: true,
        category: true,
        totalAmount: true,
        createdAt: true,
        updatedAt: true,
        profileId: true,
        buyerNameSnapshot: true,
        buyerOrgNameSnapshot: true,
        buyerPhoneSnapshot: true,
        buyerWechatSnapshot: true,
        sourceRecords: { select: { source: true, externalOrderNo: true } },
      },
      orderBy: [
        { buyerNameSnapshot: { sort: "asc", nulls: "last" } },
        { buyerOrgNameSnapshot: { sort: "asc", nulls: "last" } },
        { createdAt: "desc" },
      ],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.order.count({ where }),
  ]);

  return NextResponse.json({ orders, total, page, pageSize, totalPages: Math.ceil(total / pageSize) });
}

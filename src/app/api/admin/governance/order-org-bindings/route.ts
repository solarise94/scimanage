import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { scanOrdersMissingBuyerOrg } from "@/lib/orders/governance-scan";

/**
 * GET /api/admin/governance/order-org-bindings
 * 扫描缺少结构化购买方机构（Order.buyerOrganizationId = null）的订单。
 * 返回轻量列表 + 建议机构（EXACT/CANONICAL_HIT/PATTERN_TEXT）。
 */
export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const url = req.nextUrl;
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
  const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get("pageSize") || "20", 10)));

  const { rows, total } = await scanOrdersMissingBuyerOrg(page, pageSize);

  return NextResponse.json({
    orders: rows,
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  });
}

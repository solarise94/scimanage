import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { scanMissingSnapshots } from "@/lib/orders/governance-scan";

/**
 * GET /api/admin/data-governance/missing-snapshots
 *
 * G4（§11.5）：缺失全部强身份快照（姓名/电话/微信/小程序ID 皆空）的订单。
 * 无法用匹配引擎回放，只读展示，保留原样；如业务重要走人工补绑（不在此视图自动处理）。
 */
const PAGE_SIZE = 20;

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { searchParams } = new URL(req.url);
  const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(searchParams.get("pageSize") || String(PAGE_SIZE), 10) || PAGE_SIZE));

  const records = await scanMissingSnapshots();
  const total = records.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const start = (page - 1) * pageSize;
  const orders = records.slice(start, start + pageSize);

  return NextResponse.json({ orders, total, page, pageSize, totalPages });
}

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { scanSuspectedMisbinding } from "@/lib/orders/governance-scan";

/**
 * GET /api/admin/data-governance/suspected-misbinding
 *
 * G2（§11.3）：已绑客户但重新匹配出更高分「不同」客户的订单——疑似错绑。
 * 只给建议，绝不自动改绑（牵涉发票/回款/项目/代表）。换绑由 ADMIN 在治理页人工确认，
 * 走 batch-bind-customer（需先解绑/改绑，本视图只负责暴露疑点）。
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

  const records = await scanSuspectedMisbinding();
  // 分差大的排前面，先看最可疑的。
  records.sort((a, b) => b.scoreDelta - a.scoreDelta);

  const total = records.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const start = (page - 1) * pageSize;
  const orders = records.slice(start, start + pageSize);

  return NextResponse.json({ orders, total, page, pageSize, totalPages });
}

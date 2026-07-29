import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { scanRepresentativeMismatch } from "@/lib/orders/governance-scan";

/**
 * GET /api/admin/data-governance/representative-mismatch
 *
 * G3（§11.4）：有客户但 representativeId 与 CRM effective resolver 不一致的订单。
 * 只读扫描；分页返回。autoFixable=true 的可经 batch-sync-representative 一键回填，
 * autoFixable=false（effective=NONE）需先给客户补机构/站点绑定。
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
  const onlyAutoFixable = searchParams.get("autoFixable") === "1";

  let records = await scanRepresentativeMismatch();
  if (onlyAutoFixable) records = records.filter((r) => r.autoFixable);

  const total = records.length;
  const autoFixableTotal = records.filter((r) => r.autoFixable).length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const start = (page - 1) * pageSize;
  const orders = records.slice(start, start + pageSize);

  return NextResponse.json({ orders, total, autoFixableTotal, page, pageSize, totalPages });
}

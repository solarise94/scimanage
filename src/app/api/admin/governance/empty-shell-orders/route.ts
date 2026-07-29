import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  loadEmptyShellBoundOrders,
  classifyEmptyShellBoundOrders,
  type EmptyShellOrderPath,
} from "@/lib/orders/governance-scan";

const PAGE_SIZE = 20;
const PATHS: EmptyShellOrderPath[] = ["CUSTOMER_TEXT", "ADDRESS", "REBINDABLE", "INFO_INCOMPLETE", "CONTACT_MISSING"];

// GET /api/admin/governance/empty-shell-orders?page=1&path=CUSTOMER_TEXT
// O2：绑空壳客户的订单（设计文档 §4.2 / Phase G3）。展示 + 导航到 C2 为主，换绑为辅。
// 路径分类是 cheap 全集 → 按 path 过滤 → 分页切片 → 仅富化当前页（地址/重匹配重活有界）。
export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { searchParams } = new URL(req.url);
  const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(searchParams.get("pageSize") || String(PAGE_SIZE), 10) || PAGE_SIZE));
  const pathParam = searchParams.get("path");
  const pathFilter = PATHS.includes(pathParam as EmptyShellOrderPath) ? (pathParam as EmptyShellOrderPath) : null;

  const raw = await loadEmptyShellBoundOrders();

  // path 过滤需要分类，但分类是重活——分两步：
  //  - 无 path 过滤：直接按全集分页，仅富化当前页。
  //  - 有 path 过滤：富化全集再过滤（path 是富化产物）。为控成本，仅在显式筛选时才走全量富化。
  if (!pathFilter) {
    const total = raw.length;
    const totalPages = Math.ceil(total / pageSize);
    const slice = raw.slice((page - 1) * pageSize, page * pageSize);
    const rows = await classifyEmptyShellBoundOrders(slice);
    return NextResponse.json({ rows, total, page, pageSize, totalPages });
  }

  const enrichedAll = await classifyEmptyShellBoundOrders(raw);
  const filtered = enrichedAll.filter((r) => r.path === pathFilter);
  const total = filtered.length;
  const totalPages = Math.ceil(total / pageSize);
  const rows = filtered.slice((page - 1) * pageSize, page * pageSize);
  return NextResponse.json({ rows, total, page, pageSize, totalPages });
}

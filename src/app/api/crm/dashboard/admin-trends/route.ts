import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getAdminTrends } from "@/lib/crm/admin-trends";

/**
 * GET /api/crm/dashboard/admin-trends?days=7|30|90
 *
 * ADMIN 视角的趋势数据（新增客户、沟通互动、阶段分布 + 环比）。
 * 非法 days 值由 lib 层 clamp 到 30。
 */
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "无权访问" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const daysRaw = Number(searchParams.get("days"));

  try {
    const result = await getAdminTrends(daysRaw);
    return NextResponse.json(result);
  } catch (err) {
    console.error("[admin-trends] failed:", err);
    return NextResponse.json(
      { error: "趋势数据加载失败" },
      { status: 500 },
    );
  }
}

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";

/**
 * GET /api/crm/dashboard
 *
 * W3：遗留整页 Dashboard 已退役。前端工作台改用：
 * - GET /api/crm/dashboard/my-today（代表/经理今日待办）
 * - GET /api/crm/dashboard/admin-overview（ADMIN 运营总览）
 * 二者均以 profileId 为主键，通过 `src/lib/crm/dashboard-data.ts` 共享口径。
 */
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  return NextResponse.json(
    {
      error: "Gone",
      message:
        "GET /api/crm/dashboard 已退役：请改用 /api/crm/dashboard/my-today 或 /api/crm/dashboard/admin-overview。",
    },
    { status: 410 },
  );
}

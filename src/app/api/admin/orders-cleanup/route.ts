import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";

/**
 * 订单台账补绑接口已废弃。
 *
 * 治理顺序已调整为：先在机构补绑工作台把客户绑定到标准机构，
 * 再由机构推导代表，最后处理必要的订单纠偏。
 * 旧页面 /admin/orders-cleanup 也已重定向到 /admin/governance?tab=org-bindings。
 *
 * 返回 410 Gone，与已废弃的 PATCH/POST/DELETE 子路由保持一致。
 */
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  return NextResponse.json(
    {
      error: "Gone",
      message: "/api/admin/orders-cleanup 已废弃，请先使用机构补绑工作台处理客户机构",
      redirectTo: "/admin/governance?tab=org-bindings",
    },
    { status: 410 },
  );
}

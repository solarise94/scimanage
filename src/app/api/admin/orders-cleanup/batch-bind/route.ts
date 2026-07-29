import { NextResponse } from "next/server";

/**
 * 410 Gone — 订单数据补绑批量代表回填已废弃。
 * 现在先在机构补绑工作台为客户绑定标准机构，再由机构推导代表。
 */
export async function POST() {
  return NextResponse.json(
    { error: "Gone", message: "订单批量补绑已废弃，请先使用机构补绑工作台处理客户机构", redirectTo: "/admin/governance?tab=org-bindings" },
    { status: 410 },
  );
}

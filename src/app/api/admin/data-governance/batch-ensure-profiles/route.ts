import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";

/**
 * POST /api/admin/data-governance/batch-ensure-profiles
 *
 * Phase D（docs/customer-legacy-field-remediation-plan-2026-07-15.md）：
 * 正式创建链路已切到 `createCrmCustomerProfile`，不再通过 Customer 锚点补建 Profile。
 * 本路由已下线；存量补洞请用一次性脚本，不要再走 ensure 主路径。
 */
export async function POST(_req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  return NextResponse.json(
    {
      error: "Gone",
      message:
        "batch-ensure-profiles 已下线：新客户请走 createCrmCustomerProfile；存量补洞请用一次性脚本。",
    },
    { status: 410 },
  );
}

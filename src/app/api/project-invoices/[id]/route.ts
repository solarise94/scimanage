import { NextRequest, NextResponse } from "next/server";

// Project invoice editing is deprecated — use order invoices instead.
// Legacy code preserved in git history.

export async function PATCH(_req: NextRequest, _params: { params: Promise<{ id: string }> }) {
  return NextResponse.json({ error: "项目发票已停用编辑，请使用订单发票" }, { status: 410 });
}

import { NextRequest, NextResponse } from "next/server";

// Project invoice tax-id confirmation is deprecated — use order invoices instead.

export async function POST(_req: NextRequest, _params: { params: Promise<{ id: string }> }) {
  return NextResponse.json({ error: "项目发票操作已停用，请使用订单发票" }, { status: 410 });
}

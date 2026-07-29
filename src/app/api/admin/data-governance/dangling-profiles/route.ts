import { NextResponse } from "next/server";

/**
 * Customer 已成为纯锚点且切换前已补齐 Profile。旧的双表漂移治理入口不再适用。
 */
export async function GET() {
  return NextResponse.json({
    error: "Customer/Profile 双写治理已退役；请使用 CRM Profile 治理入口。",
    code: "CUSTOMER_PROFILE_GOVERNANCE_RETIRED",
  }, { status: 410 });
}

export async function POST() {
  return GET();
}

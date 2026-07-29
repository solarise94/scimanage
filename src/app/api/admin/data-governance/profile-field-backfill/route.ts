import { NextResponse } from "next/server";

/**
 * Customer 业务列已在 anchor cutover 中物理删除，历史回填入口随之退役。
 * 保留路由以便旧版治理页获得明确错误，而不是误以为仍可修复数据。
 */
export async function GET() {
  return NextResponse.json({
    error: "Customer 业务字段回填已退役；业务字段仅存于 CRM Profile。",
    code: "CUSTOMER_PROFILE_BACKFILL_RETIRED",
  }, { status: 410 });
}

export async function POST() {
  return GET();
}

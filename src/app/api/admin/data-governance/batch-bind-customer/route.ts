import { NextResponse } from "next/server";

/**
 * 410 Gone — 已迁移至统一绑定写路径 `POST /api/admin/governance/bind-order-customer`
 * （设计文档 §八 Phase G4）。BIND 模式仅作用 customerId 为 null 的订单。
 */
export async function POST() {
  return NextResponse.json(
    {
      error: "Gone",
      message: "订单绑定客户已迁移至 /api/admin/governance/bind-order-customer（统一绑定写路径）",
    },
    { status: 410 },
  );
}

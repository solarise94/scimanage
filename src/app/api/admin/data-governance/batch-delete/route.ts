import { NextResponse } from "next/server";

/**
 * 410 Gone — 已迁移至统一删除写路径 `POST /api/admin/governance/delete-customers`
 * （设计文档 §八 Phase G4）。守卫已收口为三套旧守卫的并集。
 */
export async function POST() {
  return NextResponse.json(
    {
      error: "Gone",
      message: "三无客户删除已迁移至 /api/admin/governance/delete-customers（统一删除写路径）",
    },
    { status: 410 },
  );
}

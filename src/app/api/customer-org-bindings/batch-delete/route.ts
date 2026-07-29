import { NextResponse } from "next/server";

/**
 * 410 Gone — 已迁移至统一删除写路径 `POST /api/admin/governance/delete-customers`
 * （设计文档 §八 Phase G4）。前端改为按 customerId 调用统一端点，该端点会同步将
 * 关联的 PENDING/IGNORED CustomerOrgBindingTask 标记为 IGNORED。
 */
export async function POST() {
  return NextResponse.json(
    {
      error: "Gone",
      message: "脏数据删除已迁移至 /api/admin/governance/delete-customers（统一删除写路径）",
    },
    { status: 410 },
  );
}

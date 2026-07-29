import { NextResponse } from "next/server";

/**
 * 410 Gone — 手动合并写路径已废弃（设计文档 §八 Phase G4）。
 * 客户合并统一走 C1 去重审核台（`/admin/customer-merges` → `POST /api/customer-merges`，需关联 task）。
 * `/customers` 合并弹窗现跳转至 C1，不再内联调用本端点。
 */
export async function POST() {
  return NextResponse.json(
    {
      error: "Gone",
      message: "手动合并已废弃，请前往客户去重审核台（C1）合并：/admin/customer-merges",
    },
    { status: 410 },
  );
}

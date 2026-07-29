import { NextResponse } from "next/server";

export async function POST() {
  return NextResponse.json(
    { error: "快速创建代表功能已禁用，请联系管理员在代表管理中添加" },
    { status: 403 },
  );
}

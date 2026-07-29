import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";

/**
 * GET /api/admin/data-governance/counts
 *
 * W6.7d：已退役。原「治理中心」徽章消费者（data-governance-center）已删除；
 * G2/G3/C2/O2 计数下沉到各自 console 异步加载。不再维护 Customer-centric 聚合。
 */
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return NextResponse.json(
    {
      error: "Gone",
      message: "data-governance counts 已退役；请使用各治理 console 内异步计数或对应列表 total",
    },
    { status: 410 },
  );
}

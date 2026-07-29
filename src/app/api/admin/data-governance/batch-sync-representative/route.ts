import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { syncOrderRepresentativesFromEffective } from "@/lib/orders/governance-scan";

/**
 * POST /api/admin/data-governance/batch-sync-representative
 * Body: { orderIds: string[] }
 *
 * G3（§11.4）批量回填：把所选订单的 representativeId 按 Profile effective resolver 同步。
 * 与 scanRepresentativeMismatch 对齐：只认 profileId，且写端独立要求活动 ASSIGNED Profile。
 *
 * 规则：
 *  - 只处理 profileId!=null、非删除/归档、状态在 CONFIRMED/DELIVERED/CLOSED、
 *    且关联 Profile 为 deleted=false / archived=false / mergedIntoProfileId=null / ASSIGNED 的订单。
 *  - RECALLED / 合并 / 归档档案订单 → skipped（不写代表）。
 *  - effective source=NONE → 跳过并计入 needsBinding，不写 null。
 *  - effective 与现值一致 → 跳过（unchanged）。
 */
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const orderIds: string[] = Array.isArray(body?.orderIds) ? body.orderIds : [];
  if (orderIds.length === 0) {
    return NextResponse.json({ error: "请至少选择一条订单" }, { status: 400 });
  }

  const result = await prisma.$transaction(
    async (tx) => syncOrderRepresentativesFromEffective(orderIds, tx),
    { timeout: 60000 },
  );

  return NextResponse.json(result);
}

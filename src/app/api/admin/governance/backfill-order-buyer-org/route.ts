import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { executeBackfill } from "@/lib/orders/buyer-org-backfill";

/**
 * POST /api/admin/governance/backfill-order-buyer-org
 * 批量回填 Order.buyerOrganizationId（profile 主权）。
 *
 * body: { dryRun?: boolean, allowPartial?: boolean }
 *  - dryRun（默认 true）：只扫描不写入，返回分级清单。
 *  - dryRun=false：实际写入。默认遇异常（invalidProfileOrg/hasFinance）禁写全部；
 *    allowPartial=true 才允许只写安全 plans。
 *
 * 机构来源 = order.profile.organizationId（profile 主权，不 fallback Customer 旧列）。
 * 有发票/回款等财务关联的订单单独列出（hasFinance），不自动写入。
 *
 * 让管理员能从治理页或一次性调用触发，不用手搓命令行跑脚本。
 * 逻辑与 scripts/backfill-order-buyer-organization.ts 共享 src/lib/orders/buyer-org-backfill.ts。
 */
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const dryRun: boolean = body?.dryRun !== false; // 默认 dryRun
  const allowPartial: boolean = body?.allowPartial === true;

  const result = await executeBackfill(prisma, { dryRun, allowPartial });

  return NextResponse.json({
    dryRun: result.dryRun,
    allowPartial,
    scanned: result.scanned,
    plans: result.plans.length,
    updated: result.updated,
    skippedNoProfileOrg: result.skippedNoProfileOrg.length,
    invalidProfileOrg: result.invalidProfileOrg,
    hasFinance: result.hasFinance,
    // 完整 plans 列表（dryRun 时用于审查）
    planDetails: dryRun ? result.plans : undefined,
  });
}

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * POST /api/orders/import/contract-ledger/commit
 *
 * 历史治理入口已关闭（Phase 0）。合同台账导入不再提供 preview/commit。
 * 存量 CONTRACT_LEDGER 来源订单不受影响；新订单请通过 Agent 顺序导入。
 * 见 docs/agent-sequential-order-import-upgrade-design-2026-07-21.md §10.1。
 */
export async function POST() {
  return NextResponse.json(
    {
      error: "该历史治理导入入口已关闭",
      detail: "存量数据不受影响；新的订单请通过 Agent 顺序导入。",
    },
    { status: 410 }
  );
}

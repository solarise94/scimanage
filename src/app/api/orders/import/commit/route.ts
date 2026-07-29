import { NextResponse } from "next/server";

/**
 * @deprecated 410 Gone — 已被「先确认、后落库」会话式导入取代。
 *
 * 旧路径在解析后立即自动提交订单（auto-commit then remediate），无法在导入前确认 CRM 归属。
 * 新流程见 docs/order-import-crm-confirmation-design-2026-06-29.md：
 *   1) POST /api/orders/import/sessions               创建确认会话（解析 + 逐行匹配，不落库）
 *   2) 在 /orders/import/[sessionId] 逐行确认归属
 *   3) POST /api/orders/import/sessions/[id]/commit    回放确认结果，一次性正确落库
 */
export async function POST() {
  return NextResponse.json(
    {
      error: "该接口已停用",
      detail: "订单导入已改为「先确认、后落库」会话式流程，请使用 POST /api/orders/import/sessions 创建确认会话。",
    },
    { status: 410 },
  );
}

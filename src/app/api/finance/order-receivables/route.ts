import { NextRequest, NextResponse } from "next/server";
import { requirePortalSession } from "@/lib/application/http-error-mapping";
import { requireBusinessActorFromSession } from "@/lib/agent-actions/actor";
import {
  queryOrderReceivables,
  type ReceivablesView,
  type InvoiceSub,
  type ReceiptSub,
} from "@/lib/orders/application/order-receivables-query";

const validViews = ["all", "uninvoiced", "invoiceable", "invoiced_unpaid", "paid", "no_customer"] as const;

export async function GET(req: NextRequest) {
  const gated = await requirePortalSession();
  if (!gated.ok) return gated.response;
  const session = gated.session;
  if (
    session.user.role !== "ADMIN" &&
    session.user.role !== "USER" &&
    session.user.role !== "REPRESENTATIVE" &&
    session.user.role !== "REGIONAL_MANAGER"
  ) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const url = req.nextUrl;
  const search = url.searchParams.get("search")?.trim() || "";
  const profileId = url.searchParams.get("profileId")?.trim() || "";
  const representativeId = url.searchParams.get("representativeId")?.trim() || "";
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
  const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get("pageSize") || "50", 10)));
  const rawView = url.searchParams.get("view") || "all";
  const view: ReceivablesView = (validViews as readonly string[]).includes(rawView)
    ? (rawView as ReceivablesView)
    : "all";

  const rawInvoiceSub = url.searchParams.get("invoiceSub");
  const invoiceSub: InvoiceSub =
    rawInvoiceSub === "none" || rawInvoiceSub === "partial" ? rawInvoiceSub : null;

  const rawReceiptSub = url.searchParams.get("receiptSub");
  const receiptSub: ReceiptSub =
    rawReceiptSub === "zero" || rawReceiptSub === "partial" ? rawReceiptSub : null;

  // 旧 *CustomerId 系查询参数一律 400（键名枚举，避免在源码里引用已废弃契约）。
  const legacyKey = [...url.searchParams.keys()].find((k) => /customerids?$/i.test(k));
  if (legacyKey) {
    return NextResponse.json({ error: `请使用 profileId（不再接受 ${legacyKey}）` }, { status: 400 });
  }

  const actor = requireBusinessActorFromSession(session);
  const result = await queryOrderReceivables(actor, {
    search,
    profileId,
    representativeId,
    view,
    invoiceSub,
    receiptSub,
    page,
    pageSize,
  });

  return NextResponse.json(result);
}

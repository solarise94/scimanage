"use client";

import { ChevronRight, Wallet } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { CardShell } from "./card-shell";
import type { AgentCardProps } from "../agent-ui-types";
import {
  ENTITY_BLOCK_BUTTON_CLASS,
  ENTITY_ROW_BUTTON_CLASS,
  openEntityResource,
} from "./open-resource";

interface PendingItem {
  id?: string;
  orderNo?: string;
  title?: string;
  status?: string;
  financeAmount?: number;
  receivedAmount?: number;
  outstandingAmount?: number;
  customerName?: string;
}

function formatYuan(cents: number | undefined | null): string {
  if (cents == null || Number.isNaN(Number(cents))) return "¥0.00";
  return `¥${(Number(cents) / 100).toFixed(2)}`;
}

function displayValue(value: unknown, fallback = "—"): string {
  const text = typeof value === "string" ? value.trim() : "";
  return text || fallback;
}

const PENDING_ROW_CLASS =
  "flex w-full items-start justify-between gap-3 rounded-xl bg-muted/30 px-3 py-2 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-default disabled:hover:bg-muted/30";

/** Read-only list card for `orders.list_pending_receipts`. */
export function OrderPendingReceiptsCard({
  descriptor,
  onApplyViewIntent,
  onOpenResource,
}: AgentCardProps) {
  const items = Array.isArray(descriptor.props.items)
    ? (descriptor.props.items as PendingItem[])
    : [];
  const truncated = descriptor.props.truncated === true;

  return (
    <CardShell title="待回款订单" state={descriptor.state}>
      <div className="mb-2 text-[11px] text-muted-foreground">
        {truncated
          ? `已列出 ${items.length} 笔（扫描达上限，可能还有更早欠款）`
          : `共 ${items.length} 笔`}
      </div>
      {items.length === 0 ? (
        <div className="px-1 py-3 text-center text-sm text-muted-foreground">暂无待回款订单</div>
      ) : (
        <div className="space-y-2">
          {items.map((item, index) => {
            const orderId = typeof item.id === "string" ? item.id : undefined;
            const openable = Boolean(orderId);
            return (
              <button
                key={item.id || `${item.orderNo}-${index}`}
                type="button"
                disabled={!openable}
                onClick={() => {
                  if (!orderId) return;
                  openEntityResource("order", orderId, "打开订单详情", {
                    onOpenResource,
                    onApplyViewIntent,
                  });
                }}
                className={PENDING_ROW_CLASS}
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">
                    {displayValue(item.orderNo)} · {displayValue(item.title, "未命名订单")}
                  </div>
                  <div className="truncate text-[11px] text-muted-foreground">
                    {displayValue(item.customerName, "未关联客户")}
                    {" · 财务 "}
                    {formatYuan(item.financeAmount)}
                    {" · 已回 "}
                    {formatYuan(item.receivedAmount)}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <div className="text-right">
                    <div className="text-sm font-semibold tabular-nums text-amber-700">
                      {formatYuan(item.outstandingAmount)}
                    </div>
                    <div className="text-[10px] text-muted-foreground">待回款</div>
                  </div>
                  {openable ? (
                    <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/60" />
                  ) : null}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </CardShell>
  );
}

/** Read-only finance snapshot for `orders.get_finance_snapshot`. */
export function OrderFinanceSnapshotCard({
  descriptor,
  onApplyViewIntent,
  onOpenResource,
}: AgentCardProps) {
  const order = (descriptor.props.order ?? {}) as Record<string, unknown>;
  const finance = (descriptor.props.finance ?? {}) as Record<string, unknown>;
  const orderNo = displayValue(order.orderNo, "-");
  const title = displayValue(order.title, "订单财务摘要");
  const orderId =
    (typeof order.id === "string" ? order.id : undefined)
    ?? (typeof descriptor.props.orderId === "string" ? descriptor.props.orderId : undefined);

  const rows: Array<{ label: string; cents: number | undefined; tone?: string }> = [
    { label: "财务口径", cents: typeof finance.financeAmount === "number" ? finance.financeAmount : undefined },
    { label: "已开票", cents: typeof finance.invoicedAmount === "number" ? finance.invoicedAmount : undefined },
    { label: "已回款", cents: typeof finance.receiptAmount === "number" ? finance.receiptAmount : undefined },
    { label: "成本", cents: typeof finance.costAmount === "number" ? finance.costAmount : undefined },
    {
      label: "未结清",
      cents: typeof finance.outstandingAmount === "number" ? finance.outstandingAmount : undefined,
      tone: "text-amber-700",
    },
  ];

  const body = (
    <>
      <div className="mb-2 flex items-center gap-2 text-[11px] text-muted-foreground">
        <Wallet className="h-3.5 w-3.5" />
        订单总额 {formatYuan(typeof order.totalAmount === "number" ? order.totalAmount : undefined)}
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {rows.map((row) => (
          <div key={row.label} className="rounded-xl bg-muted/30 px-3 py-2">
            <div className="text-[10px] text-muted-foreground">{row.label}</div>
            <div className={`text-sm font-semibold tabular-nums ${row.tone || ""}`}>
              {formatYuan(row.cents)}
            </div>
          </div>
        ))}
      </div>
    </>
  );

  return (
    <CardShell title={`${orderNo} · ${title}`} state={descriptor.state}>
      {orderId ? (
        <button
          type="button"
          onClick={() => openEntityResource("order", orderId, "打开订单详情", {
            onOpenResource,
            onApplyViewIntent,
          })}
          className="group w-full rounded-xl text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          {body}
          <div className="mt-3 flex items-center justify-end gap-1 text-[11px] text-muted-foreground group-hover:text-foreground">
            打开订单详情
            <ChevronRight className="h-3 w-3" />
          </div>
        </button>
      ) : (
        body
      )}
    </CardShell>
  );
}

interface InvoiceItem {
  itemName?: string;
  amount?: number;
}

interface CoveredOrder {
  orderId?: string;
  orderNo?: string | null;
  title?: string | null;
  amount?: number;
}

/** Read-only invoice detail for `finance.get_invoice_detail`. */
export function FinanceInvoiceDetailCard({
  descriptor,
  onApplyViewIntent,
  onOpenResource,
}: AgentCardProps) {
  const invoice = (descriptor.props.invoice ?? {}) as Record<string, unknown>;
  const items = Array.isArray(descriptor.props.lineItems)
    ? (descriptor.props.lineItems as InvoiceItem[])
    : Array.isArray(descriptor.props.items)
      ? (descriptor.props.items as InvoiceItem[])
      : [];
  const coveredOrders = Array.isArray(descriptor.props.coveredOrders)
    ? (descriptor.props.coveredOrders as CoveredOrder[])
    : [];
  const allocatedAmount =
    typeof descriptor.props.allocatedAmount === "number" ? descriptor.props.allocatedAmount : undefined;
  const outstandingAmount =
    typeof descriptor.props.outstandingAmount === "number" ? descriptor.props.outstandingAmount : undefined;
  const invoiceId =
    (typeof invoice.id === "string" ? invoice.id : undefined)
    ?? (typeof descriptor.props.invoiceId === "string" ? descriptor.props.invoiceId : undefined);

  return (
    <CardShell
      title={`发票 · ${displayValue(invoice.buyerOrganizationName, "未知购方")}`}
      state={descriptor.state}
    >
      {invoiceId ? (
        <button
          type="button"
          onClick={() => openEntityResource("invoice", invoiceId, "打开发票详情", {
            onOpenResource,
            onApplyViewIntent,
          })}
          className={`${ENTITY_BLOCK_BUTTON_CLASS} mb-3`}
        >
          <div className="min-w-0">
            <div className="text-[10px] text-muted-foreground">票面金额</div>
            <div className="text-sm font-semibold tabular-nums">
              {formatYuan(typeof invoice.totalAmount === "number" ? invoice.totalAmount : undefined)}
            </div>
            <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
              {displayValue(invoice.actualInvoiceNo, displayValue(invoice.status))}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Badge variant="outline" className="text-[10px]">
              {displayValue(invoice.invoiceType, "票种未知")}
            </Badge>
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/60" />
          </div>
        </button>
      ) : (
        <>
          <div className="mb-2 text-[11px] text-muted-foreground">
            {displayValue(invoice.actualInvoiceNo, displayValue(invoice.status))}
          </div>
          <div className="mb-3 flex items-center justify-between gap-2 rounded-xl bg-muted/30 px-3 py-2">
            <div>
              <div className="text-[10px] text-muted-foreground">票面金额</div>
              <div className="text-sm font-semibold tabular-nums">
                {formatYuan(typeof invoice.totalAmount === "number" ? invoice.totalAmount : undefined)}
              </div>
            </div>
            <Badge variant="outline" className="text-[10px]">
              {displayValue(invoice.invoiceType, "票种未知")}
            </Badge>
          </div>
        </>
      )}

      <div className="mb-3 grid grid-cols-2 gap-2">
        <div className="rounded-xl bg-muted/30 px-3 py-2">
          <div className="text-[10px] text-muted-foreground">已核销</div>
          <div className="text-sm font-medium tabular-nums">{formatYuan(allocatedAmount)}</div>
        </div>
        <div className="rounded-xl bg-muted/30 px-3 py-2">
          <div className="text-[10px] text-muted-foreground">剩余可核销</div>
          <div className="text-sm font-semibold tabular-nums text-amber-700">
            {formatYuan(outstandingAmount)}
          </div>
        </div>
      </div>

      {items.length > 0 ? (
        <div className="mb-2 space-y-1">
          <div className="text-[11px] font-medium text-muted-foreground">行项目</div>
          {items.slice(0, 6).map((item, index) => (
            <div key={`${item.itemName}-${index}`} className="flex justify-between gap-2 text-xs">
              <span className="min-w-0 truncate">{displayValue(item.itemName)}</span>
              <span className="shrink-0 tabular-nums">{formatYuan(item.amount)}</span>
            </div>
          ))}
        </div>
      ) : null}

      {coveredOrders.length > 0 ? (
        <div className="space-y-1">
          <div className="text-[11px] font-medium text-muted-foreground">覆盖订单</div>
          {coveredOrders.slice(0, 6).map((row, index) => {
            const orderId = typeof row.orderId === "string" ? row.orderId : undefined;
            const orderLabel = [
              displayValue(row.orderNo, ""),
              displayValue(row.title, ""),
            ].filter(Boolean).join(" · ") || (
              orderId
                ? (orderId.length > 10 ? `…${orderId.slice(-8)}` : orderId)
                : "—"
            );
            if (!orderId) {
              return (
                <div key={`cov-${index}`} className="flex justify-between gap-2 rounded-lg px-2 py-1.5 text-xs">
                  <span className="min-w-0 truncate">{orderLabel}</span>
                  <span className="shrink-0 tabular-nums">{formatYuan(row.amount)}</span>
                </div>
              );
            }
            return (
              <button
                key={orderId}
                type="button"
                className={ENTITY_ROW_BUTTON_CLASS}
                onClick={() => openEntityResource("order", orderId, "打开订单详情", {
                  onOpenResource,
                  onApplyViewIntent,
                })}
              >
                <span className="min-w-0 truncate font-medium">{orderLabel}</span>
                <span className="flex shrink-0 items-center gap-1 tabular-nums text-muted-foreground">
                  {formatYuan(row.amount)}
                  <ChevronRight className="h-3 w-3 text-muted-foreground/60" />
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
    </CardShell>
  );
}

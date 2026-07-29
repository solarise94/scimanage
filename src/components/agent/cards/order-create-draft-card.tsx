"use client";

import { useState } from "react";
import { Check, X, Loader2, ShoppingBag, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CardShell } from "./card-shell";
import type { AgentCardProps } from "../agent-ui-types";
import { openEntityResource } from "./open-resource";

interface LineItem {
  itemName?: string;
  amount?: number;
}

/**
 * Format a cents value as yuan (÷100).
 */
function formatCents(cents: number | undefined | null): string {
  if (cents == null || Number.isNaN(Number(cents))) return "¥0.00";
  return `¥${(Number(cents) / 100).toFixed(2)}`;
}

/**
 * Format a yuan value as-is (no conversion).
 */
function formatYuanRaw(yuan: number | undefined | null): string {
  if (yuan == null || Number.isNaN(Number(yuan))) return "¥0.00";
  return `¥${Number(yuan).toFixed(2)}`;
}

function pickCustomerName(props: Record<string, unknown>, summary?: string, displayProps?: Record<string, string | null>): string {
  const direct = typeof props.customerName === "string" ? props.customerName.trim() : "";
  if (direct) return direct;
  if (displayProps?.customerName) return displayProps.customerName.trim();
  if (typeof summary === "string") {
    // orders.create summary: 将为客户「<name>」创建订单「<title>」…
    const m = summary.match(/客户「(.+?)」/);
    if (m && m[1]) return m[1].trim();
  }
  return "客户";
}

/**
 * Order create-draft confirm card.
 *
 * Previews an order (title, customer, line items, total) and asks the user to
 * confirm or reject the `orders.create` proposal.
 *
 * Unit contract (see orders.create parseInput / buildProposal):
 * - PENDING (proposal.input via proposalInput): `totalAmount` and `lines[].amount`
 *   are in YUAN (buildProposal converts cents back to yuan for re-parse safety).
 * - CONFIRMED (execute output): nested `order.totalAmount` and saved lines are in CENTS.
 */
export function OrderCreateDraftCard({
  descriptor,
  proposal,
  proposalBusyId,
  onConfirmProposal,
  onRejectProposal,
  onApplyViewIntent,
  onOpenResource,
}: AgentCardProps) {
  const isSaved = descriptor.state === "saved";
  // CONFIRMED: data comes from execute output. `order` is nested (extractProps
  // keeps nested objects), so `props.order.totalAmount` is in CENTS.
  // PENDING:  data comes from proposal.input (flattened). Amounts are in YUAN.
  const order = (descriptor.props.order ?? {}) as Record<string, unknown>;
  const title =
    (typeof order.title === "string" && order.title.trim()) ||
    (typeof descriptor.props.title === "string" && descriptor.props.title.trim()) ||
    "新建订单";
  const customerName = pickCustomerName(descriptor.props, proposal?.summary, proposal?.displayProps as Record<string, string | null> | undefined);
  const items = Array.isArray(descriptor.props.lines)
    ? (descriptor.props.lines as LineItem[])
    : [];
  const totalCents = typeof order.totalAmount === "number" ? order.totalAmount : undefined;
  const totalYuan = typeof descriptor.props.totalAmount === "number" ? descriptor.props.totalAmount : undefined;
  // When confirmed, prefer the authoritative output (cents). Otherwise the
  // proposal.input totalAmount is in yuan. If only lines exist, sum yuan amounts.
  const pendingLinesYuan = !isSaved && items.length > 0
    ? items.reduce((s, item) => s + (typeof item.amount === "number" ? item.amount : 0), 0)
    : undefined;
  const totalLabel = isSaved
    ? formatCents(totalCents)
    : formatYuanRaw(totalYuan ?? pendingLinesYuan);
  const [saving, setSaving] = useState(false);

  async function handleConfirm() {
    if (!proposal) return;
    setSaving(true);
    try {
      await onConfirmProposal(proposal.id);
    } finally {
      setSaving(false);
    }
  }

  if (isSaved) {
    const orderNo = typeof order.orderNo === "string" ? order.orderNo : undefined;
    const orderId = typeof order.id === "string" ? order.id : undefined;
    const summary = (
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-emerald-100">
          <Check className="h-5 w-5 text-emerald-600" />
        </div>
        <div className="min-w-0">
          <div className="text-sm font-medium">{title}</div>
          <div className="text-[11px] text-muted-foreground">
            客户：{customerName}
            {orderNo ? ` · 单号 ${orderNo}` : ""}
          </div>
          <div className="text-[11px] text-muted-foreground">合计 {totalLabel}</div>
        </div>
      </div>
    );
    return (
      <CardShell title="订单已创建" state="saved">
        {orderId ? (
          <button
            type="button"
            className="flex w-full items-center justify-between gap-2 rounded-xl text-left transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            onClick={() => openEntityResource("order", orderId, "打开订单详情", {
              onOpenResource,
              onApplyViewIntent,
            })}
          >
            {summary}
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/60" />
          </button>
        ) : (
          summary
        )}
      </CardShell>
    );
  }

  return (
    <CardShell
      title={`新建订单：${customerName}`}
      state={descriptor.state}
      footer={
        <div className="flex gap-2">
          <Button
            size="sm"
            className="flex-1"
            disabled={saving || proposalBusyId === proposal?.id}
            onClick={handleConfirm}
          >
            {saving || proposalBusyId === proposal?.id ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Check className="h-4 w-4" />
            )}
            确认创建
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={saving || proposalBusyId === proposal?.id}
            onClick={() => proposal && onRejectProposal(proposal.id)}
          >
            <X className="h-4 w-4" />
            拒绝
          </Button>
        </div>
      }
    >
      <div className="rounded-xl bg-muted/30 px-3 py-2">
        <div className="text-sm font-medium">{title}</div>
        <div className="mt-0.5 text-[11px] text-muted-foreground">客户：{customerName}</div>
      </div>

      {items.length > 0 ? (
        <div className="mt-3">
          <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
            <ShoppingBag className="h-3.5 w-3.5" />
            订单项（{items.length}）
          </div>
          <div className="divide-y divide-border/40 overflow-hidden rounded-lg border border-border/40">
            {items.map((item, idx) => (
              <div
                key={idx}
                className="flex items-center justify-between gap-2 px-3 py-2 text-sm"
              >
                <span className="min-w-0 truncate text-foreground">
                  {item.itemName || `订单项 ${idx + 1}`}
                </span>
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {isSaved ? formatCents(item.amount) : formatYuanRaw(item.amount)}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="mt-3 flex items-center justify-between rounded-xl bg-emerald-50/70 px-3 py-2 text-sm">
        <span className="text-[11px] font-medium text-emerald-900">合计金额</span>
        <span className="font-semibold tabular-nums text-emerald-700">
          {totalLabel}
        </span>
      </div>
    </CardShell>
  );
}

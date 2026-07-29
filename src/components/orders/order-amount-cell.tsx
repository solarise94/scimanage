"use client";

import Link from "next/link";
import { ChevronDown, ExternalLink } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export interface OrderFinanceTotals {
  invoiced: number;
  received: number;
  cost: number;
}

function fmtYuan(n: number): string {
  return `¥${(n || 0).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * 金额单元格：显示合同额 + caret，点击弹出 合同额/已开票/已回款/已成本 概览 + 跳转链接。
 * 轻量方案——只给汇总数字与跳转，不在列表内重做明细列表。
 * totals 由列表页批量懒加载（/api/orders/finance-totals），未到达时显示骨架。
 */
export function OrderAmountCell({
  orderId,
  amount,
  hasOverride,
  totals,
}: {
  orderId: string;
  amount: number;
  hasOverride: boolean;
  totals?: OrderFinanceTotals;
}) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            className="inline-flex items-center gap-0.5 tabular-nums hover:text-primary cursor-pointer"
            onClick={(e: React.MouseEvent) => e.stopPropagation()}
            title={hasOverride ? "含财务覆盖金额" : undefined}
          />
        }
      >
        <span>{fmtYuan(amount)}</span>
        <ChevronDown className="h-3 w-3 opacity-60" />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-56" onClick={(e) => e.stopPropagation()}>
        <div className="flex flex-col gap-1 text-xs">
          <div className="mb-0.5 text-sm font-medium">金额概览{hasOverride ? "（含覆盖）" : ""}</div>
          <div className="flex justify-between gap-2 py-0.5">
            <span className="text-muted-foreground">合同额</span>
            <span className="font-medium tabular-nums">{fmtYuan(amount)}</span>
          </div>
          {totals ? (
            <>
              <AmountLinkRow label="已开票" value={fmtYuan(totals.invoiced)} href={`/finance/invoices?orderId=${orderId}`} />
              <AmountLinkRow label="已回款（总览）" value={fmtYuan(totals.received)} href="/finance/order-receivables" />
              <AmountLinkRow label="已成本" value={fmtYuan(totals.cost)} href={`/finance/costs?orderId=${orderId}`} />
            </>
          ) : (
            <div className="flex flex-col gap-1.5 py-1">
              <div className="h-3 w-full animate-pulse rounded bg-muted" />
              <div className="h-3 w-full animate-pulse rounded bg-muted" />
              <div className="h-3 w-full animate-pulse rounded bg-muted" />
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function AmountLinkRow({ label, value, href }: { label: string; value: string; href: string }) {
  return (
    <Link
      href={href}
      className="flex items-center justify-between gap-2 rounded px-1 py-0.5 -mx-1 hover:bg-muted"
      onClick={(e) => e.stopPropagation()}
    >
      <span className="inline-flex items-center gap-1 text-muted-foreground">
        {label}
        <ExternalLink className="h-3 w-3 opacity-50" />
      </span>
      <span className="tabular-nums">{value}</span>
    </Link>
  );
}

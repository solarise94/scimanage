"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ShoppingCart, FileText, X, ChevronDown, ChevronUp, Building2, AlertTriangle } from "lucide-react";
import type { CartOrgGroup } from "@/hooks/use-invoice-cart";

function fmtYuanFromCents(cents: number): string {
  const yuan = cents / 100;
  return `¥${new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(yuan)}`;
}

/**
 * 开票篮浮动栏（finance-invoice-architecture-review-2026-07-01.md §5.4 / §5.5）。
 *
 * 只承载开票相关动作：
 * - 篮子摘要：已选 N 条 · M 个购买方机构 · 合计 ¥X
 * - 展开明细：按购买方机构分组，逐条移除 / 整组移除 / 整组开票
 * - 动作 A「按购买方机构分组开票」（默认，安全）
 * - 动作 B「合并成一张 ⚠」（仅 crossOrgCount > 1 时出现）
 *
 * 非开票批量操作（改类型/匹配/排除/合并/删除）不在本组件内，由调用方在篮子栏上方
 * 独立渲染，避免与开票动作语义混淆。
 *
 * 本组件只组织用户意图，不做任何财务判断；金额、机构、跨机构合单校验全部在后端重复执行。
 */
export function InvoiceCartBar({
  variant,
  count,
  totalAmount,
  crossOrgCount,
  groups,
  onInvoiceGrouped,
  onMergeInvoice,
  onInvoiceOrg,
  onRemoveItem,
  onRemoveOrg,
  onClear,
}: {
  variant: "desktop" | "mobile";
  count: number;
  totalAmount: number;
  crossOrgCount: number;
  groups: CartOrgGroup[];
  onInvoiceGrouped: () => void;
  onMergeInvoice: () => void;
  onInvoiceOrg: (orgId: string) => void;
  onRemoveItem: (orderId: string) => void;
  onRemoveOrg: (orgId: string) => void;
  onClear: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const isMobile = variant === "mobile";
  const btn = isMobile ? "h-7 text-xs" : "h-8 text-xs";

  const summary = (
    <span className={isMobile ? "text-xs font-medium" : "text-sm font-medium"}>
      <span className="inline-flex items-center gap-1">
        <ShoppingCart className="h-3.5 w-3.5" />开票篮
      </span>
      <span className="ml-2 text-muted-foreground">
        已选 {count} 条 · {crossOrgCount} 个购买方机构 · 合计 {fmtYuanFromCents(totalAmount)}
      </span>
    </span>
  );

  const detailPanel = expanded && (
    <div
      className={
        isMobile
          ? "md:hidden fixed bottom-[calc(7.5rem+env(safe-area-inset-bottom))] left-0 right-0 z-40 max-h-[45vh] overflow-y-auto bg-background border-t shadow-lg px-3 py-2 space-y-3"
          : "hidden md:block fixed bottom-[5.5rem] right-4 z-40 w-[420px] max-h-[55vh] overflow-y-auto bg-background border shadow-lg rounded-lg px-4 py-3 space-y-3"
      }
    >
      {groups.map((g) => (
        <div key={g.orgId} className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium inline-flex items-center gap-1 truncate">
              <Building2 className="h-3 w-3 text-muted-foreground shrink-0" />
              <span className="truncate" title={g.orgName}>{g.orgName || "（未命名机构）"}</span>
              <span className="text-muted-foreground shrink-0">· {g.items.length} 条 · {fmtYuanFromCents(g.subtotal)}</span>
            </span>
            <div className="flex items-center gap-1 shrink-0">
              <Button size="sm" variant="outline" className="h-6 text-[11px] px-2" onClick={() => onInvoiceOrg(g.orgId)}>
                <FileText className="h-3 w-3 mr-1" />开此组
              </Button>
              <Button size="sm" variant="ghost" className="h-6 text-[11px] px-2" onClick={() => onRemoveOrg(g.orgId)}>
                <X className="h-3 w-3" />
              </Button>
            </div>
          </div>
          <div className="space-y-1 pl-4">
            {g.items.map((it) => (
              <div key={it.orderId} className="flex items-center justify-between gap-2 text-xs">
                <span className="truncate">
                  <span className="font-mono">{it.orderNo}</span>
                  <span className="text-muted-foreground ml-2 truncate">{it.customerName}</span>
                </span>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="tabular-nums">{fmtYuanFromCents(it.amount)}</span>
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-destructive"
                    onClick={() => onRemoveItem(it.orderId)}
                    title="从篮子移除"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );

  return (
    <>
      {detailPanel}
      <div
        className={
          isMobile
            ? "md:hidden fixed bottom-[calc(4.5rem+env(safe-area-inset-bottom))] left-0 right-0 z-40 flex flex-col gap-2 bg-background border-t shadow-lg px-3 py-2"
            : "hidden md:flex fixed bottom-4 right-4 z-40 flex-col gap-2 bg-background border shadow-lg rounded-lg px-4 py-3 max-w-[calc(100vw-2rem)]"
        }
      >
        {/* 第一行：摘要 + 展开/清空 */}
        <div className="flex items-center gap-2 flex-wrap">
          {summary}
          <div className="flex items-center gap-1 ml-auto">
            <Button size="sm" variant="ghost" className={btn} onClick={() => setExpanded((v) => !v)}>
              {expanded ? <ChevronDown className="h-3 w-3 mr-1" /> : <ChevronUp className="h-3 w-3 mr-1" />}
              明细
            </Button>
            <Button size="sm" variant="ghost" className={btn} onClick={onClear}>
              <X className="h-3 w-3 mr-1" />清空
            </Button>
          </div>
        </div>

        {/* 第二行：开票动作 A / B */}
        <div className="flex items-center gap-2 flex-wrap">
          <Button size="sm" variant="default" className={btn} onClick={onInvoiceGrouped}>
            <FileText className="h-3 w-3 mr-1" />按购买方机构分组开票
          </Button>
          {crossOrgCount > 1 && (
            <Button size="sm" variant="outline" className={`${btn} border-amber-500 text-amber-700 hover:bg-amber-50`} onClick={onMergeInvoice}>
              <AlertTriangle className="h-3 w-3 mr-1" />合并成一张
            </Button>
          )}
        </div>
      </div>
    </>
  );
}

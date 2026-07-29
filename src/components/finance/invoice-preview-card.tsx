"use client";

import { amountToChineseWords } from "@/lib/contracts/amount-in-words";
import type { InvoiceSheetData } from "@/lib/invoice-sheet";
import { cn } from "@/lib/utils";

function formatYuan(n: number): string {
  return n.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * 开票申请实时预览（电子发票风格示意，非税务局版式）。
 * 本系统明细无税率字段，不伪造税率/税额。
 */
export function InvoicePreviewCard({
  data,
  className,
}: {
  data: InvoiceSheetData;
  className?: string;
}) {
  const typeLabel = data.invoiceType === "SPECIAL" ? "专用发票" : "普通发票";
  const hasItems = data.items.length > 0;
  const total = data.totalAmount;
  const words = total > 0 ? amountToChineseWords(total) : "—";

  return (
    <div
      className={cn(
        "rounded-lg border border-red-200/80 bg-[#fffdfb] text-black shadow-sm overflow-hidden",
        className,
      )}
    >
      <div className="px-3 pt-3 pb-2 text-center space-y-1 border-b border-red-100">
        <p className="text-[10px] text-muted-foreground">预览仅供核对，非税务局版式</p>
        <h3 className="text-sm font-semibold tracking-wide text-red-700">
          电子发票（{typeLabel}）
        </h3>
      </div>

      <div className="grid grid-cols-2 gap-0 border-b border-red-100 text-[11px]">
        <div className="p-2.5 space-y-1 border-r border-red-100">
          <div className="text-[10px] font-medium text-red-600/80 mb-1">购买方</div>
          <p className="font-medium break-words">
            {data.buyerOrganizationName || "—"}
          </p>
          <p className="text-muted-foreground break-all">
            税号：{data.buyerTaxId || "—"}
          </p>
        </div>
        <div className="p-2.5 space-y-1">
          <div className="text-[10px] font-medium text-red-600/80 mb-1">销售方</div>
          <p className="font-medium break-words">{data.sellerName || "—"}</p>
          <p className="text-muted-foreground break-all">
            税号：{data.sellerTaxId || "—"}
          </p>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-[11px] border-collapse">
          <thead>
            <tr className="bg-red-50/60 text-red-800/80">
              <th className="text-left font-medium px-2 py-1.5">项目名称</th>
              <th className="text-left font-medium px-1 py-1.5 w-14">规格</th>
              <th className="text-center font-medium px-1 py-1.5 w-10">单位</th>
              <th className="text-right font-medium px-1 py-1.5 w-12">数量</th>
              <th className="text-right font-medium px-2 py-1.5 w-16">金额</th>
            </tr>
          </thead>
          <tbody>
            {hasItems ? (
              data.items.map((it, i) => (
                <tr key={i} className="border-t border-red-50">
                  <td className="px-2 py-1.5 break-words align-top">
                    {it.itemName || "—"}
                  </td>
                  <td className="px-1 py-1.5 text-muted-foreground align-top">
                    {it.spec || "—"}
                  </td>
                  <td className="px-1 py-1.5 text-center align-top">
                    {it.unit || "—"}
                  </td>
                  <td className="px-1 py-1.5 text-right tabular-nums align-top">
                    {it.quantity != null ? it.quantity : "—"}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums align-top">
                    {formatYuan(it.amount)}
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={5} className="px-2 py-6 text-center text-muted-foreground">
                  填写明细后将在此预览
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="border-t border-red-100 px-2.5 py-2 space-y-1 text-[11px]">
        <div className="flex justify-between gap-2">
          <span className="text-muted-foreground shrink-0">价税合计（大写）</span>
          <span className="text-right break-words">{words}</span>
        </div>
        <div className="flex justify-between gap-2 font-medium">
          <span className="text-muted-foreground">（小写）</span>
          <span className="tabular-nums">¥{formatYuan(total)}</span>
        </div>
        {data.contentSummary && (
          <p className="text-muted-foreground pt-1 border-t border-red-50">
            开票内容：{data.contentSummary}
          </p>
        )}
        {data.remark && (
          <p className="text-muted-foreground">备注：{data.remark}</p>
        )}
      </div>
    </div>
  );
}

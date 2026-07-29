"use client";

import { useState } from "react";
import {
  Copy, Loader2, FileDown, Pencil,
  Send, XCircle, MessageSquare,
  Upload,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import { zhCN } from "date-fns/locale";
import type { InvoiceRecord } from "@/components/invoice-form-dialog";
import { sheetDataFromRecord, type InvoiceSheetData } from "@/lib/invoice-sheet";
import { exportInvoiceSheetToPdf } from "@/lib/export-invoice-pdf";

const STATUS_LABELS: Record<string, string> = {
  DRAFT: "草稿", REQUESTED: "已申请", ISSUED: "已开票", CANCELLED: "已取消",
};
const STATUS_VARIANTS: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  DRAFT: "secondary", REQUESTED: "default", ISSUED: "outline", CANCELLED: "destructive",
};

function formatAmount(n: number): string {
  return n.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function buildPreviewTextFromRecord(inv: InvoiceRecord): string {
  const lines: string[] = [];
  if (inv.contactName) lines.push(inv.contactName);
  if (inv.projectCode) lines.push(`项目编号：${inv.projectCode}`);
  if (inv.sellerName) lines.push(`开票方：${inv.sellerName}`);
  if (inv.sellerTaxId) lines.push(`开票方税号：${inv.sellerTaxId}`);
  if (inv.sellerBankName || inv.sellerBankAccount) {
    lines.push(`开票方开户行及账号：${[inv.sellerBankName, inv.sellerBankAccount].filter(Boolean).join(" ")}`);
  }
  lines.push(`对方公司名称：${inv.buyerOrganizationName}`);
  if (inv.buyerTaxId) lines.push(`统一社会信用代码/纳税人识别号：${inv.buyerTaxId}`);
  if (inv.contentSummary) lines.push(`开票内容：${inv.contentSummary}`);
  if (inv.totalAmount > 0) lines.push(`金额：${formatAmount(inv.totalAmount)}`);
  lines.push(`普票/专票：${inv.invoiceType === "SPECIAL" ? "专票" : "普票"}`);
  for (const it of inv.items) {
    const parts: string[] = [`项目名称：${it.itemName}`];
    if (it.spec) parts.push(`规格：${it.spec}`);
    if (it.unit) parts.push(`单位：${it.unit}`);
    if (it.quantity != null) parts.push(`数量：${it.quantity}`);
    if (it.amount) parts.push(`金额：${formatAmount(it.amount)}`);
    lines.push(parts.join("；"));
  }
  if (inv.remark) lines.push(`备注：${inv.remark}`);
  return lines.join("\n");
}

export interface InvoiceCardCallbacks {
  onEdit?: (inv: InvoiceRecord) => void;
  onStatusChange?: (id: string, status: string) => void;
  onRemarkSave?: (id: string, remark: string) => Promise<void>;
  onConfirmTaxId?: (id: string) => void;
  confirmTaxIdPending?: boolean;
  onIssue?: (id: string) => void;
}

interface InvoiceCardProps {
  inv: InvoiceRecord;
  readOnly?: boolean;
  callbacks?: InvoiceCardCallbacks;
}

export function InvoiceCard({ inv, readOnly, callbacks }: InvoiceCardProps) {
  const [editRemarkId, setEditRemarkId] = useState<string | null>(null);
  const [editRemarkText, setEditRemarkText] = useState("");
  const [remarkSaving, setRemarkSaving] = useState(false);

  const copyText = async (text: string) => {
    try { await navigator.clipboard.writeText(text); toast.success("已复制到剪贴板"); }
    catch { toast.error("复制失败"); }
  };

  const exportPdf = async (data: InvoiceSheetData) => {
    try {
      await exportInvoiceSheetToPdf(data);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "PDF 导出失败");
    }
  };

  return (
    <Card>
      <CardContent className="p-3 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm font-medium truncate">{inv.buyerOrganizationName}</span>
            <Badge variant={inv.invoiceType === "SPECIAL" ? "default" : "secondary"} className="text-[10px] shrink-0">
              {inv.invoiceType === "SPECIAL" ? "专票" : "普票"}
            </Badge>
            <Badge variant={STATUS_VARIANTS[inv.status] || "outline"} className="text-[10px] shrink-0">
              {STATUS_LABELS[inv.status] || inv.status}
            </Badge>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <span className="text-sm font-medium">{formatAmount(inv.totalAmount)}</span>
            <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => copyText(buildPreviewTextFromRecord(inv))} title="复制给财务">
              <Copy className="h-3.5 w-3.5" />
            </Button>
            <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => void exportPdf(sheetDataFromRecord(inv))} title="导出 PDF">
              <FileDown className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
        {inv.items.length > 0 && (
          <div className="text-xs text-muted-foreground">{inv.items.map((it) => it.itemName).join("、")}</div>
        )}
        <div className="flex items-center justify-between">
          <div className="text-[10px] text-muted-foreground">
            {inv.createdBy?.name} · {formatDistanceToNow(new Date(inv.createdAt), { addSuffix: true, locale: zhCN })}
          </div>
          {!readOnly && callbacks && (
            <div className="flex items-center gap-1">
              {inv.status === "DRAFT" && (
                <>
                  {callbacks.onEdit && (
                    <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={() => callbacks.onEdit!(inv)}>
                      <Pencil className="mr-1 h-3 w-3" /> 编辑
                    </Button>
                  )}
                  {callbacks.onStatusChange && (
                    <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={() => callbacks.onStatusChange!(inv.id, "REQUESTED")}>
                      <Send className="mr-1 h-3 w-3" /> 提交申请
                    </Button>
                  )}
                  {callbacks.onIssue && (
                    <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={() => callbacks.onIssue!(inv.id)}>
                      <Upload className="mr-1 h-3 w-3" /> 登记已开票
                    </Button>
                  )}
                  {callbacks.onStatusChange && (
                    <Button size="sm" variant="ghost" className="h-6 text-xs text-destructive" onClick={() => callbacks.onStatusChange!(inv.id, "CANCELLED")}>
                      <XCircle className="mr-1 h-3 w-3" /> 取消
                    </Button>
                  )}
                </>
              )}
              {inv.status === "REQUESTED" && callbacks.onStatusChange && (
                <>
                  <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={() => { setEditRemarkId(inv.id); setEditRemarkText(inv.remark || ""); }}>
                    <MessageSquare className="mr-1 h-3 w-3" /> 备注
                  </Button>
                  {callbacks.onIssue && (
                    <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={() => callbacks.onIssue!(inv.id)}>
                      <Upload className="mr-1 h-3 w-3" /> 登记已开票
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" className="h-6 text-xs text-destructive" onClick={() => callbacks.onStatusChange!(inv.id, "CANCELLED")}>
                    <XCircle className="mr-1 h-3 w-3" /> 取消
                  </Button>
                </>
              )}
            </div>
          )}
        </div>
        {inv.buyerTaxIdFromLookup && inv.buyerOrganizationId && inv.buyerTaxId && !readOnly && callbacks?.onConfirmTaxId && (
          <div className="flex items-center gap-2 text-[10px] text-amber-600 bg-amber-50 rounded px-2 py-1">
            <span>税号 {inv.buyerTaxId} 来自查询，尚未同步到单位主数据</span>
            <Button
              size="sm" variant="outline" className="h-5 text-[10px] px-2"
              disabled={callbacks.confirmTaxIdPending}
              onClick={() => callbacks.onConfirmTaxId!(inv.id)}
            >
              确认并同步
            </Button>
          </div>
        )}
        {editRemarkId === inv.id && callbacks?.onRemarkSave && (
          <div className="flex items-start gap-2 pt-1 border-t">
            <Textarea
              value={editRemarkText}
              onChange={(e) => setEditRemarkText(e.target.value)}
              placeholder="备注信息" rows={2} className="text-xs resize-none flex-1"
            />
            <div className="flex flex-col gap-1">
              <Button size="sm" className="h-7 text-xs" disabled={remarkSaving} onClick={async () => {
                setRemarkSaving(true);
                try { await callbacks.onRemarkSave!(inv.id, editRemarkText); }
                finally { setRemarkSaving(false); }
              }}>
                {remarkSaving ? <Loader2 className="h-3 w-3 animate-spin" /> : "保存"}
              </Button>
              <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setEditRemarkId(null)}>取消</Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

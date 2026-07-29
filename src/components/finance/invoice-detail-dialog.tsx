"use client";

import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AnimatedMoney } from "@/components/ui/animated-money";
import { InvoiceStatusBadge } from "@/components/finance/finance-status-badge";
import { Badge } from "@/components/ui/badge";
import Link from "next/link";

interface InvoiceDetailDialogProps {
  invoiceId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface InvoiceDetailItem {
  itemName: string;
  spec?: string | null;
  unit?: string | null;
  quantity?: number | null;
  amount: number; // 元（API 已转换）
}

interface InvoiceDetailCoverage {
  amount: number; // 元
  order: { id: string; orderNo: string } | null;
}

interface InvoiceDetailDocument {
  id: string;
  fileName?: string | null;
  fileUrl?: string | null;
  createdAt: string;
  uploadedBy?: { id: string; name: string | null } | null;
}

interface InvoiceDetailReceipt {
  id: string;
  amount: number; // 元
  receivedAt: string | null;
}

interface InvoiceDetail {
  id: string;
  status: string;
  invoiceType: string;
  buyerOrganizationName: string | null;
  buyerTaxId?: string | null;
  contactName?: string | null;
  sellerName?: string | null;
  sellerTaxId?: string | null;
  contentSummary?: string | null;
  remark?: string | null;
  totalAmount: number; // 元
  actualInvoiceNo: string | null;
  actualIssuedAt: string | null;
  createdAt: string;
  updatedAt: string;
  order?: { id: string; orderNo: string } | null;
  orderCoverage?: InvoiceDetailCoverage[];
  items?: InvoiceDetailItem[];
  documents?: InvoiceDetailDocument[];
  receipts?: InvoiceDetailReceipt[];
  // adjustments 不在单张 GET 默认 include 中，预留兼容
  adjustmentsAsOriginal?: Array<{ id: string; kind: string }>;
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleDateString("zh-CN");
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 py-1.5 text-sm">
      <span className="text-muted-foreground w-24 shrink-0">{label}</span>
      <span className="min-w-0 flex-1 break-words">{children}</span>
    </div>
  );
}

export function InvoiceDetailDialog({
  invoiceId,
  open,
  onOpenChange,
}: InvoiceDetailDialogProps) {
  const { data, isLoading, error } = useQuery<{ invoice: InvoiceDetail }>({
    queryKey: ["order-invoice", invoiceId],
    queryFn: async () => {
      const res = await fetch(`/api/finance/order-invoices/${invoiceId}`);
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `加载失败 (${res.status})`);
      }
      return res.json();
    },
    enabled: !!invoiceId && open,
    retry: false,
  });

  const invoice = data?.invoice;
  const hasRedAdjustment = invoice?.adjustmentsAsOriginal?.some((a) => a.kind === "RED");
  const totalReceived = (invoice?.receipts ?? []).reduce(
    (sum, r) => sum + (r.amount || 0),
    0,
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>发票详情</DialogTitle>
          <DialogDescription>
            查看发票申请、开票信息与关联订单
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin" />
          </div>
        ) : error ? (
          <div className="py-8 text-center text-sm text-destructive">
            {error instanceof Error ? error.message : "发票详情加载失败"}
          </div>
        ) : !invoice ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            未找到发票
          </div>
        ) : (
          <div className="space-y-4">
            <div className="rounded-lg border bg-muted/30 p-3">
              <div className="flex items-center gap-2 flex-wrap">
                <InvoiceStatusBadge status={invoice.status} />
                {hasRedAdjustment && (
                  <Badge variant="outline" className="text-danger border-danger/40">
                    已冲红
                  </Badge>
                )}
                <Badge variant="outline">
                  {invoice.invoiceType === "SPECIAL" ? "专票" : "普票"}
                </Badge>
              </div>
              <div className="mt-3">
                <Row label="发票号">
                  {invoice.actualInvoiceNo || (
                    <span className="text-muted-foreground">未登记</span>
                  )}
                </Row>
                <Row label="开票日期">{formatDate(invoice.actualIssuedAt)}</Row>
                <Row label="创建时间">{formatDate(invoice.createdAt)}</Row>
              </div>
            </div>

            <div>
              <Row label="购方单位">{invoice.buyerOrganizationName || "-"}</Row>
              {invoice.buyerTaxId && <Row label="购方税号">{invoice.buyerTaxId}</Row>}
              {invoice.contactName && <Row label="联系人">{invoice.contactName}</Row>}
              {invoice.sellerName && <Row label="销方名称">{invoice.sellerName}</Row>}
              {invoice.sellerTaxId && <Row label="销方税号">{invoice.sellerTaxId}</Row>}
            </div>

            <div>
              <Row label="金额">
                <AnimatedMoney value={invoice.totalAmount} className="font-semibold" />
              </Row>
              {totalReceived > 0 && (
                <Row label="已回款">
                  <AnimatedMoney value={totalReceived} className="text-success" />
                </Row>
              )}
              {invoice.contentSummary && (
                <Row label="内容摘要">{invoice.contentSummary}</Row>
              )}
              {invoice.remark && <Row label="备注">{invoice.remark}</Row>}
            </div>

            {invoice.items && invoice.items.length > 0 && (
              <div>
                <p className="text-sm font-medium mb-2">明细</p>
                <div className="rounded-md border divide-y">
                  {invoice.items.map((it, idx) => (
                    <div key={idx} className="grid grid-cols-12 gap-2 px-2 py-1.5 text-xs">
                      <span className="col-span-6 break-words">
                        {it.itemName}
                        {it.spec ? `（${it.spec}）` : ""}
                      </span>
                      <span className="col-span-2 text-muted-foreground">
                        {it.quantity ?? "-"}
                        {it.unit ? ` ${it.unit}` : ""}
                      </span>
                      <span className="col-span-4 text-right">
                        <AnimatedMoney value={it.amount} />
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {(invoice.order || (invoice.orderCoverage?.length ?? 0) > 0) && (
              <div>
                <p className="text-sm font-medium mb-2">关联订单</p>
                <div className="flex flex-wrap gap-2">
                  {invoice.order && (
                    <Link
                      href={`/orders?focus=${invoice.order.id}`}
                      className="text-primary hover:underline text-sm"
                    >
                      {invoice.order.orderNo}
                    </Link>
                  )}
                  {invoice.orderCoverage
                    ?.filter((c) => c.order && c.order.id !== invoice.order?.id)
                    .map((c) =>
                      c.order ? (
                        <Link
                          key={c.order.id}
                          href={`/orders?focus=${c.order.id}`}
                          className="text-primary hover:underline text-sm"
                        >
                          {c.order.orderNo}
                          <span className="text-muted-foreground ml-1">
                            （分摊 <AnimatedMoney value={c.amount} className="inline" />）
                          </span>
                        </Link>
                      ) : null,
                    )}
                </div>
              </div>
            )}

            {invoice.documents && invoice.documents.length > 0 && (
              <div>
                <p className="text-sm font-medium mb-2">附件（{invoice.documents.length}）</p>
                <ul className="space-y-1">
                  {invoice.documents.map((doc) => (
                    <li key={doc.id} className="text-sm">
                      {doc.fileUrl ? (
                        <a
                          href={doc.fileUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary hover:underline break-all"
                        >
                          {doc.fileName || "查看附件"}
                        </a>
                      ) : (
                        <span className="break-all">{doc.fileName || "未命名附件"}</span>
                      )}
                      <span className="text-muted-foreground ml-2 text-xs">
                        {formatDate(doc.createdAt)}
                        {doc.uploadedBy?.name ? ` · ${doc.uploadedBy.name}` : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {hasRedAdjustment && (
              <div className="rounded-md border border-danger/40 bg-danger/5 p-2 text-sm text-danger">
                该发票已被冲红，原发票作废。
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

"use client";

import { useState } from "react";
import { Check, X, Loader2, FileText, Pencil, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CardShell } from "./card-shell";
import type { AgentCardProps } from "../agent-ui-types";
import { ENTITY_ROW_BUTTON_CLASS, openEntityResource } from "./open-resource";

function formatYuan(cents: number | undefined | null): string {
  if (cents == null || Number.isNaN(Number(cents))) return "¥0.00";
  return `¥${(Number(cents) / 100).toFixed(2)}`;
}

function formatBytes(size: number | undefined | null): string {
  if (size == null || !Number.isFinite(size)) return "-";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function invoiceTypeLabel(type: string | undefined | null): string {
  if (type === "SPECIAL") return "专票";
  if (type === "NORMAL") return "普票";
  return type || "-";
}

/**
 * Confirm card for `finance.register_issued_invoice`.
 */
export function RegisterIssuedInvoiceCard({
  descriptor,
  proposal,
  proposalBusyId,
  onConfirmProposal,
  onRejectProposal,
  onUpdateProposal,
  onApplyViewIntent,
  onOpenResource,
}: AgentCardProps) {
  const isSaved = descriptor.state === "saved";
  const props = descriptor.props;
  const handlers = { onOpenResource, onApplyViewIntent };
  const invoice = (props.invoice ?? {}) as Record<string, unknown>;
  const document = (props.document ?? {}) as Record<string, unknown>;
  const fileName =
    (typeof document.fileName === "string" ? document.fileName : null)
    || (typeof props.fileName === "string" ? props.fileName : "发票文件");
  const mimeType = (typeof props.mimeType === "string" ? props.mimeType : "") || "";
  const fileSize = typeof props.fileSize === "number" ? props.fileSize : undefined;
  const previewUrl = typeof props.previewUrl === "string" ? props.previewUrl : null;
  const buyerOrganizationName =
    typeof props.buyerOrganizationName === "string" ? props.buyerOrganizationName : "未知购方";
  const invoiceType = typeof props.invoiceType === "string" ? props.invoiceType : null;
  const totalAmountCents =
    typeof props.totalAmountCents === "number" ? props.totalAmountCents : undefined;
  const orderLabels = Array.isArray(props.orderLabels)
    ? props.orderLabels.filter((x): x is string => typeof x === "string")
    : [];
  const coveredOrders = Array.isArray(props.coveredOrders)
    ? (props.coveredOrders as Array<{ orderId?: string; orderNo?: string; title?: string }>)
    : [];
  const invoiceRequestId =
    typeof props.invoiceRequestId === "string" ? props.invoiceRequestId : "";

  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [actualInvoiceNo, setActualInvoiceNo] = useState(
    typeof props.actualInvoiceNo === "string" ? props.actualInvoiceNo : "",
  );
  const [actualIssuedAt, setActualIssuedAt] = useState(
    typeof props.actualIssuedAt === "string" ? props.actualIssuedAt : "",
  );

  async function handleConfirm() {
    if (!proposal) return;
    setSaving(true);
    try {
      await onConfirmProposal(proposal.id);
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveEdit() {
    if (!proposal) return;
    setSaving(true);
    try {
      await onUpdateProposal(proposal.id, {
        stagingFileId: props.stagingFileId,
        invoiceRequestId: props.invoiceRequestId,
        actualInvoiceNo: actualInvoiceNo.trim(),
        actualIssuedAt: actualIssuedAt.trim() || undefined,
        expectedSha256: props.expectedSha256,
        expectedStagingVersion: props.expectedStagingVersion,
      });
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }

  if (isSaved) {
    const savedNo =
      (typeof invoice.actualInvoiceNo === "string" ? invoice.actualInvoiceNo : null)
      || actualInvoiceNo
      || "已登记";
    const invoiceId =
      (typeof invoice.id === "string" ? invoice.id : undefined)
      || (invoiceRequestId || undefined);
    const summary = (
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-emerald-100">
          <Check className="h-5 w-5 text-emerald-600" />
        </div>
        <div className="min-w-0">
          <div className="text-sm font-medium">NO. {savedNo}</div>
          <div className="text-[11px] text-muted-foreground">
            {buyerOrganizationName} · {formatYuan(totalAmountCents)}
          </div>
        </div>
      </div>
    );
    return (
      <CardShell title="发票已登记" state="saved">
        {invoiceId ? (
          <button
            type="button"
            className="flex w-full items-center justify-between gap-2 rounded-xl text-left transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            onClick={() => openEntityResource("invoice", invoiceId, "打开发票详情", handlers)}
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
      title="登记已开发票"
      state={descriptor.state}
      footer={
        <div className="flex gap-2">
          {editing ? (
            <>
              <Button
                size="sm"
                className="flex-1"
                disabled={saving || !actualInvoiceNo.trim()}
                onClick={handleSaveEdit}
              >
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                保存修改
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={saving}
                onClick={() => setEditing(false)}
              >
                取消
              </Button>
            </>
          ) : (
            <>
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
                确认本张
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={saving || proposalBusyId === proposal?.id}
                onClick={() => setEditing(true)}
              >
                <Pencil className="h-4 w-4" />
                编辑
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
            </>
          )}
        </div>
      }
    >
      <div className="flex items-start gap-3 rounded-xl bg-muted/30 px-3 py-2">
        <FileText className="mt-0.5 h-5 w-5 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{fileName}</div>
          <div className="text-[11px] text-muted-foreground">
            {mimeType || "文件"} · {formatBytes(fileSize)}
            {previewUrl ? (
              <>
                {" · "}
                <a
                  href={previewUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sky-700 underline-offset-2 hover:underline"
                >
                  预览
                </a>
              </>
            ) : null}
          </div>
        </div>
      </div>

      <div className="mt-3 space-y-2 text-sm">
        <div className="flex items-center justify-between gap-2 rounded-lg bg-muted/20 px-3 py-1.5">
          <span className="text-[11px] text-muted-foreground">购方</span>
          <span className="truncate font-medium">{buyerOrganizationName}</span>
        </div>
        <div className="flex items-center justify-between gap-2 rounded-lg bg-muted/20 px-3 py-1.5">
          <span className="text-[11px] text-muted-foreground">金额 / 票种</span>
          <span className="tabular-nums">
            {formatYuan(totalAmountCents)} · {invoiceTypeLabel(invoiceType)}
          </span>
        </div>
        <div className="flex items-center justify-between gap-2 rounded-lg bg-muted/20 px-3 py-1.5">
          <span className="text-[11px] text-muted-foreground">申请</span>
          {invoiceRequestId ? (
            <button
              type="button"
              className="inline-flex items-center gap-1 font-mono text-[11px] text-sky-700 hover:underline focus-visible:outline-none"
              onClick={() => openEntityResource("invoice", invoiceRequestId, "打开发票详情", handlers)}
            >
              {invoiceRequestId.slice(-10) || "-"}
              <ChevronRight className="h-3 w-3" />
            </button>
          ) : (
            <span className="font-mono text-[11px]">-</span>
          )}
        </div>
        {coveredOrders.length > 0 ? (
          <div className="rounded-lg bg-muted/20 px-3 py-1.5">
            <div className="text-[11px] text-muted-foreground">关联订单</div>
            <div className="mt-1 space-y-0.5">
              {coveredOrders.slice(0, 3).map((row) => {
                const orderId = typeof row.orderId === "string" ? row.orderId : undefined;
                const label = [row.orderNo, row.title].filter(Boolean).join(" · ")
                  || orderId?.slice(-6)
                  || "-";
                if (!orderId) {
                  return (
                    <div key={label} className="truncate text-[12px]">{label}</div>
                  );
                }
                return (
                  <button
                    key={orderId}
                    type="button"
                    className={ENTITY_ROW_BUTTON_CLASS}
                    onClick={() => openEntityResource("order", orderId, "打开订单详情", handlers)}
                  >
                    <span className="min-w-0 truncate font-medium">{label}</span>
                    <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/60" />
                  </button>
                );
              })}
              {coveredOrders.length > 3 ? (
                <div className="text-[11px] text-muted-foreground">另有 {coveredOrders.length - 3} 笔</div>
              ) : null}
            </div>
          </div>
        ) : orderLabels.length > 0 ? (
          <div className="rounded-lg bg-muted/20 px-3 py-1.5">
            <div className="text-[11px] text-muted-foreground">关联订单</div>
            <div className="mt-1 space-y-0.5 text-[12px]">
              {orderLabels.slice(0, 3).map((label) => (
                <div key={label} className="truncate">{label}</div>
              ))}
              {orderLabels.length > 3 ? (
                <div className="text-[11px] text-muted-foreground">另有 {orderLabels.length - 3} 笔</div>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>

      {editing ? (
        <div className="mt-3 space-y-2">
          <div>
            <label className="mb-1 block text-[11px] text-muted-foreground">真实发票号</label>
            <Input
              value={actualInvoiceNo}
              onChange={(e) => setActualInvoiceNo(e.target.value)}
              placeholder="必填"
            />
          </div>
          <div>
            <label className="mb-1 block text-[11px] text-muted-foreground">开票日期</label>
            <Input
              type="date"
              value={actualIssuedAt}
              onChange={(e) => setActualIssuedAt(e.target.value)}
            />
          </div>
        </div>
      ) : (
        <div className="mt-3 flex items-center justify-between rounded-xl bg-emerald-50/70 px-3 py-2 text-sm">
          <div>
            <div className="text-[11px] font-medium text-emerald-900">真实发票号</div>
            <div className="font-semibold text-emerald-800">
              {typeof props.actualInvoiceNo === "string" && props.actualInvoiceNo
                ? props.actualInvoiceNo
                : "未填写"}
            </div>
          </div>
          <div className="text-right">
            <div className="text-[11px] font-medium text-emerald-900">开票日期</div>
            <div className="text-emerald-800">
              {typeof props.actualIssuedAt === "string" && props.actualIssuedAt
                ? props.actualIssuedAt
                : "未填写"}
            </div>
          </div>
        </div>
      )}
    </CardShell>
  );
}

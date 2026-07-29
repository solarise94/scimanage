"use client";

import { FileText, Loader2, X } from "lucide-react";
import type { AgentInvoiceStagingAttachment } from "@/lib/agent/invoice-staging-attachment";
import { formatInvoiceQueueProgress } from "@/lib/agent/invoice-staging-attachment";

function formatBytes(size: number): string {
  if (!Number.isFinite(size)) return "-";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function statusLabel(status: AgentInvoiceStagingAttachment["queueStatus"]): string {
  switch (status) {
    case "analyzing":
      return "分析中";
    case "analyzed":
      return "待选择";
    case "pending_confirm":
      return "待确认";
    case "registered":
      return "已登记";
    case "failed":
      return "失败";
    case "skipped":
      return "已跳过";
    case "uploaded":
    default:
      return "待分析";
  }
}

export function AgentInvoiceAttachmentList(props: {
  attachments: AgentInvoiceStagingAttachment[];
  uploading?: boolean;
  busy?: boolean;
  onClearOne?: (stagingFileId: string) => void;
  onClearAll?: () => void;
}) {
  const { attachments, uploading, busy, onClearOne, onClearAll } = props;
  if (attachments.length === 0 && !uploading) return null;

  const progress = formatInvoiceQueueProgress(attachments);

  return (
    <div className="mb-2 rounded-xl border border-border/50 bg-background px-3 py-2 shadow-sm">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <div className="text-[11px] font-medium text-muted-foreground">
          发票附件（{attachments.length}）
          {progress ? ` · ${progress}` : null}
          {uploading ? " · 上传中…" : null}
        </div>
        {onClearAll && attachments.length > 0 ? (
          <button
            type="button"
            className="text-[11px] text-muted-foreground underline-offset-2 hover:underline disabled:opacity-50"
            onClick={onClearAll}
            disabled={busy || uploading}
          >
            清空
          </button>
        ) : null}
      </div>
      <div className="space-y-1.5">
        {uploading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            正在上传…
          </div>
        ) : null}
        {attachments.map((item) => (
          <div
            key={item.stagingFileId}
            className="flex items-start gap-2 rounded-lg border border-border/60 bg-muted px-2 py-1.5"
          >
            <FileText className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs font-medium">{item.fileName}</div>
              <div className="text-[10px] text-muted-foreground">
                {formatBytes(item.fileSize)} · {statusLabel(item.queueStatus)}
                {item.uploadError ? ` · ${item.uploadError}` : null}
              </div>
            </div>
            {onClearOne ? (
              <button
                type="button"
                className="rounded p-0.5 text-muted-foreground hover:bg-muted disabled:opacity-50"
                onClick={() => onClearOne(item.stagingFileId)}
                disabled={busy || uploading}
                aria-label="移除附件"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

"use client";

import { X, FileText, Loader2 } from "lucide-react";
import {
  formatAttachmentSize,
  isImageAttachment,
  type AgentGenericAttachment,
} from "@/lib/agent/agent-attachment-upload";

interface AgentAttachmentChipsProps {
  attachments: AgentGenericAttachment[];
  uploading?: boolean;
  onRemove?: (stagingFileId: string) => void;
  disabled?: boolean;
}

/** 通用附件队列 chip：图片走授权内容端点显示缩略图，其余显示名称/MIME/大小。 */
export function AgentAttachmentChips({
  attachments,
  uploading = false,
  onRemove,
  disabled = false,
}: AgentAttachmentChipsProps) {
  if (attachments.length === 0 && !uploading) return null;

  return (
    <div className="flex flex-wrap gap-2 px-3 pt-2">
      {attachments.map((att) => {
        const failed = att.queueStatus === "failed";
        const thumbUrl = isImageAttachment(att.mimeType)
          ? `/api/agent/attachments/${att.stagingFileId}/content`
          : null;
        return (
          <div
            key={att.stagingFileId || att.fileName}
            className={`flex items-center gap-2 rounded-md border px-2 py-1 text-xs shadow-sm ${
              failed ? "border-destructive/50 bg-destructive/15" : "border-border bg-background"
            }`}
            title={failed ? att.uploadError : `${att.fileName} · ${att.mimeType}`}
          >
            {thumbUrl ? (
              <img
                src={thumbUrl}
                alt={att.fileName}
                className="h-8 w-8 rounded object-cover"
              />
            ) : (
              <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
            )}
            <div className="flex min-w-0 flex-col">
              <span className="max-w-[10rem] truncate">{att.fileName}</span>
              <span className="text-[10px] text-muted-foreground">
                {failed ? "上传失败" : formatAttachmentSize(att.fileSize)}
              </span>
            </div>
            {onRemove && !disabled && (
              <button
                type="button"
                onClick={() => onRemove(att.stagingFileId)}
                className="ml-1 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label={`移除 ${att.fileName}`}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        );
      })}
      {uploading && (
        <div className="flex items-center gap-2 rounded-md border border-border bg-background px-2 py-1 text-xs text-muted-foreground shadow-sm">
          <Loader2 className="h-4 w-4 animate-spin" />
          上传中…
        </div>
      )}
    </div>
  );
}

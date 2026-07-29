"use client";

import { FileText } from "lucide-react";
import type { AgentChatMessageAttachment } from "@/lib/agent-runtime/types";
import { formatAttachmentSize, isImageAttachment } from "@/lib/agent/agent-attachment-upload";

/**
 * 用户消息内的附件文件卡片（docs/agent-attachment-routing-design-2026-07-24.md §3.3）。
 * 未过期附件链接到授权内容端点（图片 inline 预览，PDF/Office 触发下载）；
 * 已过 TTL 的 staging 按「附件已过期」降级为不可点击。
 */
export function AgentMessageAttachmentCards({
  attachments,
}: {
  attachments: AgentChatMessageAttachment[];
}) {
  if (!attachments || attachments.length === 0) return null;

  return (
    <div className="flex flex-col items-end gap-1.5">
      {attachments.map((att) => {
        const thumbUrl = !att.expired && isImageAttachment(att.mimeType)
          ? `/api/agent/attachments/${att.stagingFileId}/content`
          : null;
        const body = (
          <>
            {thumbUrl ? (
              <img
                src={thumbUrl}
                alt={att.fileName}
                className="h-9 w-9 shrink-0 rounded-md object-cover"
              />
            ) : (
              <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
            )}
            <div className="flex min-w-0 flex-col">
              <span className="max-w-[14rem] truncate text-xs font-medium">{att.fileName}</span>
              <span className="text-[10px] text-muted-foreground">
                {att.expired ? "附件已过期" : formatAttachmentSize(att.fileSize)}
              </span>
            </div>
          </>
        );
        const className =
          "flex max-w-full items-center gap-2 rounded-xl border border-border bg-background px-3 py-2 text-left shadow-sm";
        if (att.expired) {
          return (
            <div key={att.stagingFileId || att.fileName} className={className} aria-disabled>
              {body}
            </div>
          );
        }
        return (
          <a
            key={att.stagingFileId || att.fileName}
            href={`/api/agent/attachments/${att.stagingFileId}/content`}
            target="_blank"
            rel="noreferrer"
            className={`${className} transition-colors hover:bg-muted/60`}
          >
            {body}
          </a>
        );
      })}
    </div>
  );
}

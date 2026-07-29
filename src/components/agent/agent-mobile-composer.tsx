"use client";

import { forwardRef, useRef, useState, type ClipboardEvent } from "react";
import { SendHorizontal, Loader2, Mic, Keyboard, Plus, Square, Camera, FileText, Receipt } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import type { AgentInvoiceStagingAttachment } from "@/lib/agent/invoice-staging-attachment";
import { AGENT_INVOICE_STAGING_MAX_FILES } from "@/lib/agent/invoice-staging-attachment";
import { AgentInvoiceAttachmentList } from "@/components/agent/agent-invoice-attachment-list";
import { AgentAttachmentChips } from "@/components/agent/agent-attachment-chips";
import {
  AGENT_ATTACHMENT_ACCEPT,
  AGENT_ATTACHMENT_MAX_FILES,
  type AgentGenericAttachment,
} from "@/lib/agent/agent-attachment-upload";
import { VoiceHoldButton } from "./voice-hold-button";

/**
 * Mobile bottom input area.
 *
 * - 1-4 row auto-growing textarea; Enter inserts newline, Ctrl/Cmd+Enter sends.
 * - Send disabled on empty text or while busy.
 * - Voice (when enabled): WeChat-style "按住 说话".
 * - ADMIN invoice staging: paperclip uploads up to 10 PDF/JPG/PNG to private staging.
 */
export const AgentMobileComposer = forwardRef<
  HTMLDivElement,
  {
    draft: string;
    onDraftChange: (value: string) => void;
    onSend: () => void;
    /** 流式生成中显示停止按钮，点击中断当前任务。 */
    onStop?: () => void;
    busy: boolean;
    asrEnabled?: boolean;
    onVoiceTranscribe?: (blob: Blob) => Promise<string>;
    onVoiceSend?: (transcript: string) => void;
    invoiceStagingEnabled?: boolean;
    invoiceStagingAttachments?: AgentInvoiceStagingAttachment[];
    invoiceStagingUploading?: boolean;
    onInvoiceStagingSelected?: (files: FileList | File[]) => void;
    onInvoiceStagingClear?: () => void;
    onInvoiceStagingRemove?: (stagingFileId: string) => void;
    genericAttachments?: AgentGenericAttachment[];
    genericUploading?: boolean;
    onGenericFilesSelected?: (files: File[]) => void;
    onGenericAttachmentRemove?: (stagingFileId: string) => void;
  }
>(function AgentMobileComposer(
  {
    draft,
    onDraftChange,
    onSend,
    onStop,
    busy,
    asrEnabled,
    onVoiceTranscribe,
    onVoiceSend,
    invoiceStagingEnabled = false,
    invoiceStagingAttachments = [],
    invoiceStagingUploading = false,
    onInvoiceStagingSelected,
    onInvoiceStagingClear,
    onInvoiceStagingRemove,
    genericAttachments = [],
    genericUploading = false,
    onGenericFilesSelected,
    onGenericAttachmentRemove,
  },
  ref,
) {
  const invoiceFileInputRef = useRef<HTMLInputElement | null>(null);
  const genericFileInputRef = useRef<HTMLInputElement | null>(null);
  const imageFileInputRef = useRef<HTMLInputElement | null>(null);
  const [voiceMode, setVoiceMode] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [uploadSheetOpen, setUploadSheetOpen] = useState(false);

  const voiceAvailable = Boolean(asrEnabled && onVoiceTranscribe);
  const genericInputEnabled = Boolean(onGenericFilesSelected);

  // 单 `+` 入口（docs Part 2 §2.2）：只要任一上传通道可用就显示。
  const plusButtonVisible = genericInputEnabled || invoiceStagingEnabled;

  const canSend = Boolean(
    (draft.trim() || invoiceStagingAttachments.length > 0 || genericAttachments.length > 0)
    && !busy
    && !transcribing
    && !invoiceStagingUploading
    && !genericUploading,
  );

  function handleGenericPaste(event: ClipboardEvent) {
    if (!genericInputEnabled || busy || genericUploading) return;
    const items = event.clipboardData?.items;
    if (!items) return;
    const pastedImages: File[] = [];
    for (const item of items) {
      if (item.kind === "file") {
        const file = item.getAsFile();
        if (file && file.type.startsWith("image/")) pastedImages.push(file);
      }
    }
    if (pastedImages.length > 0 && onGenericFilesSelected) {
      event.preventDefault();
      onGenericFilesSelected(pastedImages.slice(0, AGENT_ATTACHMENT_MAX_FILES));
    }
  }

  function handleVoiceTranscribe(blob: Blob): Promise<string> {
    if (!onVoiceTranscribe) return Promise.reject(new Error("语音识别不可用"));
    setTranscribing(true);
    return onVoiceTranscribe(blob).finally(() => setTranscribing(false));
  }

  function handleVoiceSend(transcript: string) {
    if (onVoiceSend) {
      onVoiceSend(transcript);
    } else {
      onDraftChange(draft ? `${draft} ${transcript}` : transcript);
      setVoiceMode(false);
    }
  }

  const placeholder = transcribing
    ? "识别中，识别完成后会直接发送…"
    : invoiceStagingAttachments.length > 1
      ? `已附 ${invoiceStagingAttachments.length} 张发票，发送后按顺序识别`
      : invoiceStagingAttachments.length === 1
        ? "可补充说明，或直接发送以识别并登记发票"
        : "给 Agent 发消息";

  return (
    // 悬浮胶囊卡：绝对定位于消息流之上（父级 relative 容器），消息可滑入其下方。
    // ChatGPT 风格：输入框与操作按钮收进同一张圆角浮卡，页面灰底透出。
    <div
      ref={ref}
      className="absolute inset-x-0 bottom-0 z-10 px-3 pt-1"
      style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 0.5rem)" }}
    >
      {transcribing ? (
        <div className="flex items-center justify-center gap-2 px-3 pb-1.5 text-[11px] text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          语音识别中 · 完成后自动发送
        </div>
      ) : null}

      <AgentInvoiceAttachmentList
        attachments={invoiceStagingAttachments}
        uploading={invoiceStagingUploading}
        busy={busy}
        onClearAll={onInvoiceStagingClear}
        onClearOne={onInvoiceStagingRemove}
      />

      <AgentAttachmentChips
        attachments={genericAttachments}
        uploading={genericUploading}
        onRemove={onGenericAttachmentRemove}
        disabled={busy}
      />
      {genericInputEnabled ? (
        <>
          <input
            ref={genericFileInputRef}
            type="file"
            accept={AGENT_ATTACHMENT_ACCEPT}
            multiple
            className="hidden"
            onChange={(event) => {
              const files = event.target.files;
              event.target.value = "";
              if (files && files.length > 0 && onGenericFilesSelected) {
                onGenericFilesSelected(Array.from(files).slice(0, AGENT_ATTACHMENT_MAX_FILES));
              }
            }}
          />
          {/* 「拍照 / 相册」专用图片输入（accept=image/*，移动端系统会提供相机/相册选择） */}
          <input
            ref={imageFileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(event) => {
              const files = event.target.files;
              event.target.value = "";
              if (files && files.length > 0 && onGenericFilesSelected) {
                onGenericFilesSelected(Array.from(files).slice(0, AGENT_ATTACHMENT_MAX_FILES));
              }
            }}
          />
        </>
      ) : null}

      <div className="rounded-[26px] border border-border/60 bg-card p-2 shadow-lg">
        {voiceAvailable && voiceMode ? (
          <VoiceHoldButton
            onTranscribe={handleVoiceTranscribe}
            onSend={handleVoiceSend}
            disabled={busy}
          />
        ) : (
          <Textarea
            value={draft}
            onChange={(e) => onDraftChange(e.target.value)}
            placeholder={placeholder}
            rows={1}
            className={cn(
              "min-h-[24px] max-h-[120px] w-full flex-1 resize-none overflow-y-auto rounded-2xl border-transparent bg-transparent px-2 py-1.5 text-sm leading-6 shadow-none focus-visible:border-transparent focus-visible:ring-0 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden",
              transcribing && "opacity-60",
            )}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                if (canSend) onSend();
              }
            }}
            onPaste={handleGenericPaste}
            disabled={transcribing}
          />
        )}

        <div className="mt-1 flex items-center justify-between">
          <div className="flex items-center gap-1">
            {/* 发票 staging hidden input（仅 ADMIN，sheet 项转发 click） */}
            {invoiceStagingEnabled ? (
              <input
                ref={invoiceFileInputRef}
                type="file"
                accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
                multiple
                className="hidden"
                onChange={(event) => {
                  const files = event.target.files;
                  event.target.value = "";
                  if (files && files.length > 0 && onInvoiceStagingSelected) {
                    onInvoiceStagingSelected(files);
                  }
                }}
              />
            ) : null}

            {/* 单 `+` 圆钮（docs Part 2 §2.2）：合并原 Paperclip + ImagePlus 两按钮 */}
            {plusButtonVisible ? (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-10 w-10 shrink-0 rounded-full"
                onClick={() => setUploadSheetOpen(true)}
                disabled={
                  busy
                  || transcribing
                  || invoiceStagingUploading
                  || genericUploading
                  || genericAttachments.length >= AGENT_ATTACHMENT_MAX_FILES
                }
                aria-label="上传附件"
              >
                {genericUploading || invoiceStagingUploading ? (
                  <Loader2 className="h-5 w-5 animate-spin" />
                ) : (
                  <Plus className="h-5 w-5" />
                )}
              </Button>
            ) : null}
          </div>

          <div className="flex items-center gap-1">
            {voiceAvailable ? (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-10 w-10 shrink-0 rounded-full"
                onClick={() => setVoiceMode((v) => !v)}
                disabled={busy || transcribing}
                aria-label={voiceMode ? "切换到键盘输入" : "切换到语音输入"}
              >
                {voiceMode ? (
                  <Keyboard className="h-5 w-5" />
                ) : (
                  <Mic className="h-5 w-5" />
                )}
              </Button>
            ) : null}

            {/* 生成中：发送键变停止键；语音模式：发送键保留但灰色禁用（不抓取视觉焦点） */}
            {busy && onStop ? (
              <Button
                type="button"
                size="icon"
                variant="outline"
                className="h-10 w-10 shrink-0 rounded-full"
                onClick={onStop}
                aria-label="停止生成"
              >
                <Square className="h-4 w-4 fill-current" />
              </Button>
            ) : (
              <Button
                type="button"
                size="icon"
                className="h-10 w-10 shrink-0 rounded-full"
                onClick={onSend}
                disabled={!canSend || (voiceAvailable && voiceMode)}
                aria-label="发送"
              >
                <SendHorizontal className="h-5 w-5" />
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* 上传 action sheet（docs Part 2 §2.2）：bottom sheet 收纳所有上传入口，转发 hidden input 的 click */}
      <Sheet open={uploadSheetOpen} onOpenChange={setUploadSheetOpen}>
        <SheetContent side="bottom" className="px-0 pb-[calc(env(safe-area-inset-bottom)+0.5rem)]">
          <SheetHeader className="px-4 pb-1">
            <SheetTitle>添加附件</SheetTitle>
          </SheetHeader>
          <div className="flex flex-col">
            {genericInputEnabled ? (
              <>
                <button
                  type="button"
                  className="flex items-center gap-3 px-4 py-3.5 text-left text-sm transition-colors hover:bg-muted/60"
                  onClick={() => {
                    setUploadSheetOpen(false);
                    // 等待 sheet 关闭动画后再触发 input click，避免 iOS Safari 上 picker 不弹出。
                    setTimeout(() => imageFileInputRef.current?.click(), 0);
                  }}
                >
                  <Camera className="h-5 w-5 text-muted-foreground" />
                  <span>拍照 / 相册</span>
                </button>
                <button
                  type="button"
                  className="flex items-center gap-3 px-4 py-3.5 text-left text-sm transition-colors hover:bg-muted/60"
                  onClick={() => {
                    setUploadSheetOpen(false);
                    setTimeout(() => genericFileInputRef.current?.click(), 0);
                  }}
                >
                  <FileText className="h-5 w-5 text-muted-foreground" />
                  <span>文件（图片 / PDF / 文档等）</span>
                </button>
              </>
            ) : null}
            {invoiceStagingEnabled ? (
              <button
                type="button"
                className="flex items-center gap-3 px-4 py-3.5 text-left text-sm transition-colors hover:bg-muted/60 disabled:opacity-50"
                disabled={
                  busy
                  || transcribing
                  || invoiceStagingUploading
                  || invoiceStagingAttachments.length >= AGENT_INVOICE_STAGING_MAX_FILES
                }
                onClick={() => {
                  setUploadSheetOpen(false);
                  setTimeout(() => invoiceFileInputRef.current?.click(), 0);
                }}
              >
                <Receipt className="h-5 w-5 text-muted-foreground" />
                <span>
                  上传发票
                  {invoiceStagingAttachments.length > 0
                    ? `（已附 ${invoiceStagingAttachments.length}）`
                    : ""}
                </span>
              </button>
            ) : null}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
});

AgentMobileComposer.displayName = "AgentMobileComposer";

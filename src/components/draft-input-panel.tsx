"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Wand2, Loader2, ChevronUp, ChevronDown, X, ImagePlus } from "lucide-react";
import { toast } from "sonner";
import { DraftPreview } from "./draft-preview";
import { VoiceRecorder } from "./voice-recorder";

interface ImagePreview {
  previewUrl: string;
  label: string;
}

interface DraftResult {
  summary?: string;
  warnings?: string[];
  draft: {
    fields: Record<string, unknown>;
    fieldMeta?: Record<string, unknown>;
    sources?: Array<unknown>;
  };
}

interface DraftInputPanelProps {
  formKey: string;
  projectId?: string;
  fieldLabels: Record<string, string>;
  onApply: (fields: Record<string, unknown>) => void | Promise<void>;
  fallbackPlugin?: string;
}

export function DraftInputPanel({ formKey, projectId, fieldLabels, onApply, fallbackPlugin }: DraftInputPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const [text, setText] = useState("");
  const [imagePreviews, setImagePreviews] = useState<ImagePreview[]>([]);
  const [loading, setLoading] = useState(false);
  const [ocrBusy, setOcrBusy] = useState(false);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [draftResult, setDraftResult] = useState<DraftResult | null>(null);
  const [previewKey, setPreviewKey] = useState(0);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [asrEnabled, setAsrEnabled] = useState(false);

  const mountedRef = useRef(true);
  const imageAbortRef = useRef<AbortController | null>(null);
  const imagePreviewsRef = useRef(imagePreviews);
  useEffect(() => { imagePreviewsRef.current = imagePreviews; }, [imagePreviews]);

  useEffect(() => {
    if (!expanded) return;
    fetch("/api/plugins")
      .then((r) => r.json())
      .then((d) => setAsrEnabled(!!d.capabilities?.asr))
      .catch(() => {});
  }, [expanded]);

  // Cleanup on unmount — use ref to get latest imagePreviews
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      imageAbortRef.current?.abort();
      for (const img of imagePreviewsRef.current) {
        URL.revokeObjectURL(img.previewUrl);
      }
    };
  }, []);

  const hasText = text.trim().length > 0;
  const canSubmit = hasText && !loading && !ocrBusy && !voiceBusy;

  /** Revoke all ObjectURLs and reset state */
  const cleanupAndReset = useCallback(() => {
    for (const img of imagePreviews) {
      URL.revokeObjectURL(img.previewUrl);
    }
    setExpanded(false);
    setText("");
    setImagePreviews([]);
  }, [imagePreviews]);

  // Image upload → OCR → append text to textarea
  const handleImageUpload = useCallback(async (files: FileList) => {
    setOcrBusy(true);
    const controller = new AbortController();
    imageAbortRef.current = controller;

    for (const file of Array.from(files)) {
      if (controller.signal.aborted || !mountedRef.current) break;
      if (!file.type.startsWith("image/")) { toast.error(`${file.name} 不是图片文件`); continue; }
      if (file.size > 10 * 1024 * 1024) { toast.error(`${file.name} 超过 10MB`); continue; }

      try {
        // Upload
        const fd = new FormData();
        fd.append("file", file);
        const uploadRes = await fetch("/api/draft-media/upload", {
          method: "POST", body: fd, signal: controller.signal,
        });
        if (!uploadRes.ok) {
          const d = await uploadRes.json().catch(() => ({}));
          if (mountedRef.current) toast.error(d.error || "上传失败");
          continue;
        }
        const uploadData = await uploadRes.json();
        if (!mountedRef.current) {
          fetch("/api/draft-media/delete", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ fileId: uploadData.fileId }),
          }).catch(() => {});
          break;
        }

        // Add preview thumbnail
        const previewUrl = URL.createObjectURL(file);
        setImagePreviews((prev) => [...prev, { previewUrl, label: file.name }]);

        // OCR → append text (file is deleted server-side by transcribe API)
        const ocrRes = await fetch("/api/draft-media/transcribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fileId: uploadData.fileId }),
          signal: controller.signal,
        });
        if (!mountedRef.current) break;
        if (!ocrRes.ok) {
          const d = await ocrRes.json().catch(() => ({}));
          toast.error(d.error || "图片识别失败");
          continue;
        }
        const ocrData = await ocrRes.json();
        if (ocrData.text?.trim() && mountedRef.current) {
          setText((prev) => prev ? `${prev}\n\n${ocrData.text.trim()}` : ocrData.text.trim());
          toast.success("图片文字已提取");
        } else if (mountedRef.current) {
          toast.warning("未识别到图片中的文字");
        }
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") break;
        if (mountedRef.current) toast.error(`${file.name} 处理失败`);
      }
    }

    imageAbortRef.current = null;
    if (mountedRef.current) setOcrBusy(false);
  }, []);

  const removeImagePreview = useCallback((idx: number) => {
    setImagePreviews((prev) => {
      const removed = prev[idx];
      if (removed) URL.revokeObjectURL(removed.previewUrl);
      return prev.filter((_, i) => i !== idx);
    });
  }, []);

  // Voice transcription → append text
  const handleTranscribed = useCallback((transcribedText: string) => {
    setText((prev) => prev ? `${prev}\n\n${transcribedText}` : transcribedText);
    toast.success("语音已转写");
  }, []);

  // Handle paste — extract images from clipboard
  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    if (ocrBusy || loading) return;
    const items = e.clipboardData?.items;
    if (!items) return;
    const imageFiles: File[] = [];
    for (const item of Array.from(items)) {
      if (item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) imageFiles.push(file);
      }
    }
    if (imageFiles.length > 0) {
      e.preventDefault();
      const dt = new DataTransfer();
      for (const f of imageFiles) dt.items.add(f);
      handleImageUpload(dt.files);
    }
  }, [handleImageUpload, ocrBusy, loading]);

  // Submit — always pure text, always use auto-draft (with fallback if AI not configured)
  const handleSubmit = useCallback(async () => {
    setLoading(true);
    try {
      const input = text.trim();

      // Try auto-draft first (AI extraction + entity resolution + search)
      const res = await fetch("/api/plugins/form-draft/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pluginKey: "project.auto-draft", formKey, input, projectId }),
      });
      const data = await res.json();

      // If AI not configured and fallback available, use fallback
      if (!res.ok && fallbackPlugin && data.error?.includes("AI 未配置")) {
        const fbRes = await fetch("/api/plugins/form-draft/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pluginKey: fallbackPlugin, formKey, input, projectId }),
        });
        const fbData = await fbRes.json();
        if (!fbRes.ok) { toast.error(fbData.error || "解析失败"); return; }
        const fields = fbData.result?.draft?.fields || {};
        if (Object.keys(fields).length === 0) { toast.warning("未能提取到有效字段"); return; }
        await onApply(fields);
        toast.success(fbData.result?.summary || "填写成功");
        cleanupAndReset(); return;
      }

      if (!res.ok) { toast.error(data.error || "解析失败"); return; }

      const result = data.result as DraftResult;
      if (!result?.draft?.fields || Object.keys(result.draft.fields).length === 0) {
        toast.warning("未能提取到有效字段"); return;
      }

      if (result.draft.fieldMeta) {
        setDraftResult(result);
        setPreviewKey((k) => k + 1);
        setPreviewOpen(true);
      } else {
        await onApply(result.draft.fields);
        toast.success(result.summary || "填写成功");
        cleanupAndReset();
      }
    } catch {
      toast.error("网络错误");
    } finally {
      setLoading(false);
    }
  }, [text, formKey, projectId, fallbackPlugin, onApply, cleanupAndReset]);

  const handleApply = useCallback(async (fields: Record<string, unknown>) => {
    await onApply(fields);
    toast.success("已应用到表单");
    cleanupAndReset();
    setDraftResult(null);
  }, [onApply, cleanupAndReset]);

  return (
    <>
      <div className="border rounded-lg overflow-hidden">
        <button
          type="button"
          className="w-full flex items-center justify-between px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-muted/50 transition-colors"
          onClick={() => setExpanded(!expanded)}
        >
          <span className="flex items-center gap-2">
            <Wand2 className="h-4 w-4" />
            智能填写
          </span>
          {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </button>

        {expanded && (
          <div className="px-3 pb-3 space-y-2 border-t">
            <p className="text-xs text-muted-foreground mt-2">
              粘贴文本、上传图片{asrEnabled ? "或录音" : ""}，AI 将自动提取项目信息。
            </p>

            <Textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              onPaste={handlePaste}
              placeholder="粘贴文本或图片（Ctrl+V），也可上传图片或录音，AI 将自动提取信息"
              rows={4}
              className="text-xs max-h-[200px] overflow-y-auto resize-none"
            />

            {/* Image previews */}
            {imagePreviews.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {imagePreviews.map((img, i) => (
                  <div key={i} className="relative group">
                    <img src={img.previewUrl} alt={img.label} className="h-12 w-12 object-cover rounded border opacity-60" />
                    <button type="button" className="absolute -top-1 -right-1 bg-destructive text-destructive-foreground rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition-opacity" onClick={() => removeImagePreview(i)}>
                      <X className="h-2.5 w-2.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Actions row */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <label className="flex items-center gap-1 text-xs text-muted-foreground cursor-pointer hover:text-foreground transition-colors">
                  <input type="file" accept="image/png,image/jpeg,image/webp" multiple className="hidden" onChange={(e) => e.target.files && handleImageUpload(e.target.files)} disabled={ocrBusy || loading} />
                  {ocrBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImagePlus className="h-4 w-4" />}
                  {ocrBusy ? "识别中..." : "图片识别"}
                </label>
                {imagePreviews.length > 0 && (
                  <Badge variant="secondary" className="text-[10px]">{imagePreviews.length} 张</Badge>
                )}
              </div>
              {asrEnabled && <VoiceRecorder onTranscribed={handleTranscribed} onBusyChange={setVoiceBusy} disabled={loading} />}
            </div>

            <Button type="button" variant="secondary" size="sm" className="w-full" disabled={!canSubmit} onClick={handleSubmit}>
              {loading ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Wand2 className="mr-1 h-3 w-3" />}
              {loading ? "解析中..." : "解析并填充"}
            </Button>
          </div>
        )}
      </div>

      {draftResult && (
        <DraftPreview
          key={previewKey}
          open={previewOpen}
          onOpenChange={setPreviewOpen}
          draft={draftResult.draft as Parameters<typeof DraftPreview>[0]["draft"]}
          summary={draftResult.summary}
          warnings={draftResult.warnings}
          fieldLabels={fieldLabels}
          onApply={handleApply}
        />
      )}
    </>
  );
}

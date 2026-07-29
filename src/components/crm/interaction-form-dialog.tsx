"use client";

import { useState, useCallback, useRef } from "react";
import { FormSheet } from "@/components/ui/form-sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { CRM_INTERACTION_TYPES, INTERACTION_TYPE_LABELS } from "@/lib/crm/constants";
import { crmKeys } from "@/lib/crm/query-keys";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Plus, Mic, MicOff, Check, Loader2, Sparkles } from "lucide-react";
import { useMediaQuery } from "@/hooks/use-media-query";
import { cn } from "@/lib/utils";

function toDatetimeLocal(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function InteractionFormDialog({ profileId, startOpen, onClose }: { profileId: string; startOpen?: boolean; onClose?: () => void }) {
  const isMobile = useMediaQuery("(max-width: 767px)");
  const [open, setOpen] = useState(startOpen || false);
  const [type, setType] = useState("CALL");
  const [summary, setSummary] = useState("");
  const [detail, setDetail] = useState("");
  const [happenedAt, setHappenedAt] = useState("");
  const queryClient = useQueryClient();

  const [voiceState, setVoiceState] = useState<"idle" | "recording" | "transcribing" | "done" | "failed">("idle");
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const voiceBlobRef = useRef<Blob | null>(null);
  const voiceMimeRef = useRef<string>("audio/webm");
  const draftSeqRef = useRef(0);
  const [summaryLoading, setSummaryLoading] = useState(false);

  const stopRecorder = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state === "recording") {
      recorder.stop();
    }
    mediaRecorderRef.current = null;
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  }, []);

  const processVoiceDraft = useCallback(async (blob: Blob, mimeType: string) => {
    const seq = draftSeqRef.current;
    setVoiceState("transcribing");
    try {
      const formData = new FormData();
      const ext = mimeType.includes("ogg") ? "ogg" : mimeType.includes("mp4") ? "m4a" : "webm";
      formData.append("file", blob, `voice_${Date.now()}.${ext}`);

      const res = await fetch("/api/crm/interactions/asr-draft", { method: "POST", body: formData });
      if (draftSeqRef.current !== seq) return;
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "语音识别失败");
      }
      const data = await res.json();
      if (draftSeqRef.current !== seq) return;
      setDetail(data.transcript);
      setVoiceState("done");
    } catch (err) {
      if (draftSeqRef.current !== seq) return;
      toast.error(err instanceof Error ? err.message : "语音识别失败");
      setVoiceState("failed");
    }
  }, []);

  const generateSummary = useCallback(async () => {
    if (!detail.trim()) return;
    setSummaryLoading(true);
    try {
      const res = await fetch("/api/crm/interactions/summary-draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ detail: detail.trim() }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "AI 摘要生成失败");
      }
      const data = await res.json();
      setSummary(data.summary);
      toast.success("摘要已生成");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "AI 摘要生成失败");
    } finally {
      setSummaryLoading(false);
    }
  }, [detail]);

  const resetForm = useCallback(() => {
    stopRecorder();
    setOpen(false);
    setSummary("");
    setDetail("");
    setHappenedAt("");
    setVoiceState("idle");
    voiceBlobRef.current = null;
    setSummaryLoading(false);
  }, [stopRecorder]);

  const invalidateProfile = () => {
    queryClient.invalidateQueries({ queryKey: crmKeys.profile(profileId) });
  };

  const mutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/crm/profiles/${profileId}/interactions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type,
          summary,
          detail: detail || undefined,
          happenedAt: happenedAt || undefined,
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "创建失败");
      }
      return res.json();
    },
    onSuccess: () => {
      toast.success("沟通记录已添加");
      queryClient.invalidateQueries({ queryKey: crmKeys.myToday() });
      queryClient.invalidateQueries({ queryKey: crmKeys.adminOverview() });
      invalidateProfile();
      resetForm();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const startRecording = useCallback(async () => {
    if (typeof MediaRecorder === "undefined") {
      toast.error("当前浏览器不支持录音");
      return;
    }
    const tryTypes = ["audio/ogg;codecs=opus", "audio/ogg", "audio/mp4", "audio/webm;codecs=opus", "audio/webm"];
    let mimeType = "audio/webm";
    for (const t of tryTypes) {
      if (MediaRecorder.isTypeSupported(t)) { mimeType = t; break; }
    }
    voiceMimeRef.current = mimeType;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const recorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = recorder;
      chunksRef.current = [];
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        mediaRecorderRef.current = null;
        if (chunksRef.current.length > 0) {
          const blob = new Blob(chunksRef.current, { type: mimeType });
          voiceBlobRef.current = blob;
          processVoiceDraft(blob, mimeType);
        } else {
          setVoiceState("idle");
        }
      };
      recorder.start(250);
      setVoiceState("recording");
    } catch {
      toast.error("无法访问麦克风");
    }
  }, [processVoiceDraft]);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
      mediaRecorderRef.current.stop();
    }
  }, []);

  const handleOpenChange = useCallback((v: boolean) => {
    if (v) {
      draftSeqRef.current += 1;
      stopRecorder();
      setType("CALL");
      setSummary("");
      setDetail("");
      setVoiceState("idle");
      voiceBlobRef.current = null;
      setSummaryLoading(false);
      setHappenedAt(toDatetimeLocal(new Date()));
      setOpen(true);
    } else {
      resetForm();
      onClose?.();
    }
  }, [resetForm, stopRecorder, onClose]);

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4 mr-1" />添加沟通
      </Button>
      <FormSheet open={open} onOpenChange={handleOpenChange} title="添加沟通记录" desktopVariant="plain" desktopMaxW="sm:max-w-md">
        <form onSubmit={(e) => { e.preventDefault(); mutation.mutate(); }} className="space-y-4">
          <div>
            <label className="text-sm font-medium">类型</label>
            {isMobile ? (
              /* 移动端：等宽网格 chips（4 列两行排完 7 类），替代横滑按钮带 */
              <div className="grid grid-cols-4 gap-1.5">
                {CRM_INTERACTION_TYPES.map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setType(t)}
                    className={cn(
                      "h-9 rounded-lg border text-xs font-medium transition-colors",
                      type === t
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-input bg-background text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                    )}
                  >
                    {INTERACTION_TYPE_LABELS[t]}
                  </button>
                ))}
              </div>
            ) : (
              <Select value={type} onValueChange={(v) => setType(v || "CALL")}>
                <SelectTrigger><span>{INTERACTION_TYPE_LABELS[type] || type}</span></SelectTrigger>
                <SelectContent>
                  {CRM_INTERACTION_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>{INTERACTION_TYPE_LABELS[t]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          <div>
            <label className="text-sm font-medium">摘要 *</label>
            <Input value={summary} onChange={(e) => setSummary(e.target.value)} required placeholder="简要描述沟通内容" />
          </div>
          <div>
            <label className="text-sm font-medium">详情</label>
            <Textarea value={detail} onChange={(e) => setDetail(e.target.value)} rows={3} placeholder="详细记录（可选）" />
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!detail.trim() || summaryLoading}
              onClick={generateSummary}
            >
              <Sparkles className="h-4 w-4 mr-1" />
              {summaryLoading ? "生成中..." : "AI 生成摘要"}
            </Button>
          </div>
          <div>
            <label className="text-sm font-medium">发生时间</label>
            <Input type="datetime-local" value={happenedAt} onChange={(e) => setHappenedAt(e.target.value)} />
          </div>

          <div className={cn("flex gap-2", isMobile && "flex-col")}>
            {voiceState === "idle" && (
              <Button type="button" size="sm" variant="outline" onClick={startRecording}>
                <Mic className="h-4 w-4 mr-1" />录音
              </Button>
            )}
            {voiceState === "recording" && (
              <Button type="button" size="sm" variant="destructive" onClick={stopRecording}>
                <MicOff className="h-4 w-4 mr-1" />停止录音
              </Button>
            )}
            {voiceState === "transcribing" && (
              <span className="text-xs text-muted-foreground"><Loader2 className="h-3 w-3 inline animate-spin mr-1" />识别中...</span>
            )}
            {voiceState === "done" && (
              <>
                <span className="text-xs text-success"><Check className="h-3 w-3 inline mr-1" />已识别，可编辑详情</span>
                <Button type="button" size="sm" variant="outline" className="h-6 text-xs" onClick={() => {
                  voiceBlobRef.current = null;
                  setVoiceState("idle");
                  setDetail("");
                }}>清除</Button>
                <Button type="button" size="sm" variant="outline" className="h-6 text-xs" onClick={startRecording}>重新录音</Button>
              </>
            )}
            {voiceState === "failed" && (
              <>
                <span className="text-xs text-danger">识别失败</span>
                <Button type="button" size="sm" variant="outline" className="h-6 text-xs" onClick={() => {
                  if (voiceBlobRef.current) processVoiceDraft(voiceBlobRef.current, voiceMimeRef.current);
                }}>重试</Button>
              </>
            )}
          </div>

          <Button type="submit" disabled={mutation.isPending || !summary.trim()} className="w-full">
            {mutation.isPending ? "保存中..." : "保存"}
          </Button>
        </form>
      </FormSheet>
    </>
  );
}

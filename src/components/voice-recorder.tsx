"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Mic, Square, Loader2 } from "lucide-react";
import { toast } from "sonner";

interface VoiceRecorderProps {
  /** Called with transcribed text after recording + ASR completes */
  onTranscribed: (text: string) => void;
  onBusyChange?: (busy: boolean) => void;
  disabled?: boolean;
}

function negotiateMimeType(): string | null {
  const candidates = [
    "audio/ogg;codecs=opus",
    "audio/ogg",
    "audio/mp4",
    "audio/webm;codecs=opus",
    "audio/webm",
  ];
  for (const mime of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(mime)) {
      return mime;
    }
  }
  return null;
}

function extFromMime(mime: string): string {
  if (mime.includes("ogg")) return "ogg";
  if (mime.includes("mp4")) return "m4a";
  if (mime.includes("webm")) return "webm";
  return "bin";
}

export function VoiceRecorder({ onTranscribed, onBusyChange, disabled }: VoiceRecorderProps) {
  const [recording, setRecording] = useState(false);
  const [processing, setProcessing] = useState<"uploading" | "transcribing" | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef(0);
  const mountedRef = useRef(true);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
      if (timerRef.current) clearInterval(timerRef.current);
      const recorder = mediaRecorderRef.current;
      if (recorder?.state === "recording") {
        recorder.onstop = () => {
          recorder.stream?.getTracks().forEach((t) => t.stop());
        };
        recorder.stop();
      }
    };
  }, []);

  const busy = recording || processing !== null;
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);

  const startRecording = useCallback(async () => {
    const mimeType = negotiateMimeType();
    if (!mimeType) { toast.error("当前浏览器不支持录音"); return; }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream, { mimeType });
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
        if (!mountedRef.current) return;

        const durationSec = Math.round((Date.now() - startTimeRef.current) / 1000);
        if (durationSec < 1) { toast.warning("录音时间太短"); setRecording(false); return; }
        if (durationSec > 60) { toast.warning("录音不能超过 60 秒"); setRecording(false); return; }

        const blob = new Blob(chunksRef.current, { type: recorder.mimeType });
        const ext = extFromMime(recorder.mimeType);
        setRecording(false);

        // Step 1: Upload
        setProcessing("uploading");
        const controller = new AbortController();
        abortRef.current = controller;

        try {
          const fd = new FormData();
          fd.append("file", blob, `recording_${Date.now()}.${ext}`);
          const uploadRes = await fetch("/api/draft-media/upload", {
            method: "POST", body: fd, signal: controller.signal,
          });
          if (!mountedRef.current) {
            if (uploadRes.ok) {
              const d = await uploadRes.json().catch(() => null);
              if (d?.fileId) fetch("/api/draft-media/delete", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ fileId: d.fileId }),
              }).catch(() => {});
            }
            return;
          }
          if (!uploadRes.ok) {
            const d = await uploadRes.json().catch(() => ({}));
            toast.error(d.error || "上传失败"); return;
          }
          const uploadData = await uploadRes.json();
          if (!mountedRef.current) {
            fetch("/api/draft-media/delete", {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ fileId: uploadData.fileId }),
            }).catch(() => {});
            return;
          }

          // Step 2: ASR
          setProcessing("transcribing");
          const asrRes = await fetch("/api/draft-media/asr", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ fileId: uploadData.fileId, mimeType: uploadData.mimeType }),
            signal: controller.signal,
          });
          if (!mountedRef.current) return;
          if (!asrRes.ok) {
            const d = await asrRes.json().catch(() => ({}));
            toast.error(d.error || "语音识别失败"); return;
          }
          const asrData = await asrRes.json();
          if (!mountedRef.current) return;

          if (asrData.text?.trim()) {
            onTranscribed(asrData.text.trim());
          } else {
            toast.warning("未识别到语音内容");
          }
        } catch (e) {
          if (e instanceof DOMException && e.name === "AbortError") return;
          if (mountedRef.current) toast.error("语音识别失败");
        } finally {
          abortRef.current = null;
          if (mountedRef.current) setProcessing(null);
        }
      };

      mediaRecorderRef.current = recorder;
      startTimeRef.current = Date.now();
      setElapsed(0);
      recorder.start(250);
      setRecording(true);

      timerRef.current = setInterval(() => {
        const sec = Math.round((Date.now() - startTimeRef.current) / 1000);
        setElapsed(sec);
        if (sec >= 60) recorder.stop();
      }, 500);
    } catch (e) {
      console.error("麦克风访问失败:", e);
      toast.error("无法访问麦克风，请检查浏览器权限");
    }
  }, [onTranscribed]);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current?.state === "recording") {
      mediaRecorderRef.current.stop();
    }
  }, []);

  const formatTime = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  if (processing) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {processing === "uploading" ? "上传中..." : "识别中..."}
      </div>
    );
  }

  if (recording) {
    return (
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-red-500 animate-pulse" />
          <span className="text-sm font-mono tabular-nums">{formatTime(elapsed)}</span>
          <span className="text-xs text-muted-foreground">/ 1:00</span>
        </div>
        <Button type="button" variant="destructive" size="sm" onClick={stopRecording}>
          <Square className="mr-1 h-3 w-3" />
          停止
        </Button>
      </div>
    );
  }

  return (
    <Button type="button" variant="outline" size="sm" onClick={startRecording} disabled={disabled}>
      <Mic className="mr-1 h-3.5 w-3.5" />
      录音
    </Button>
  );
}

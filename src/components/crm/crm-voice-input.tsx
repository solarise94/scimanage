"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Mic, Square, Loader2 } from "lucide-react";
import { toast } from "sonner";

interface CrmVoiceInputProps {
  onTranscribed: (text: string) => void;
  disabled?: boolean;
}

function negotiateMimeType(): string | null {
  const candidates = [
    "audio/ogg;codecs=opus",
    "audio/ogg",
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
  if (mime.includes("webm")) return "webm";
  return "bin";
}

export function CrmVoiceInput({ onTranscribed, disabled }: CrmVoiceInputProps) {
  const [recording, setRecording] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timerRef.current) clearInterval(timerRef.current);
      const recorder = mediaRecorderRef.current;
      if (recorder?.state === "recording") {
        recorder.onstop = () => recorder.stream?.getTracks().forEach((t) => t.stop());
        recorder.stop();
      }
    };
  }, []);

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

        const durationSec = Math.round((Date.now() - startTimeRef.current) / 1000);
        if (durationSec < 1) { toast.warning("录音时间太短"); setRecording(false); return; }
        if (durationSec > 60) { toast.warning("录音不能超过 60 秒"); setRecording(false); return; }

        const blob = new Blob(chunksRef.current, { type: recorder.mimeType });
        const ext = extFromMime(recorder.mimeType);
        setRecording(false);
        setProcessing(true);

        try {
          const fd = new FormData();
          fd.append("file", blob, `recording_${Date.now()}.${ext}`);
          const res = await fetch("/api/crm/interactions/asr-draft", { method: "POST", body: fd });
          if (!mountedRef.current) return;
          if (!res.ok) {
            const d = await res.json().catch(() => ({}));
            toast.error(d.error || "语音识别失败");
            return;
          }
          const data = await res.json();
          if (!mountedRef.current) return;
          if (data.transcript?.trim()) {
            onTranscribed(data.transcript.trim());
          } else {
            toast.warning("未识别到语音内容");
          }
        } catch {
          if (mountedRef.current) toast.error("语音识别失败");
        } finally {
          if (mountedRef.current) setProcessing(false);
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
    } catch {
      toast.error("无法访问麦克风，请检查浏览器权限");
    }
  }, [onTranscribed]);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current?.state === "recording") {
      mediaRecorderRef.current.stop();
    }
  }, []);

  if (processing) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        识别中...
      </div>
    );
  }

  if (recording) {
    const m = Math.floor(elapsed / 60);
    const s = elapsed % 60;
    return (
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-red-500 animate-pulse" />
          <span className="text-sm font-mono tabular-nums">{m}:{s.toString().padStart(2, "0")}</span>
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

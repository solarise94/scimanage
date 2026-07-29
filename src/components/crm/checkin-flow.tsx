"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { crmKeys } from "@/lib/crm/query-keys";
import { toast } from "sonner";
import { MapPin, Camera, Check, Loader2, Mic, Square } from "lucide-react";

interface CheckinFlowProps {
  profileId: string;
  autoStart?: boolean;
  onDone?: () => void;
}

export function CheckinFlow({ profileId, autoStart, onDone }: CheckinFlowProps) {
  const [step, setStep] = useState<"idle" | "locating" | "located" | "uploading" | "done">("idle");
  const [checkinId, setCheckinId] = useState<string | null>(null);
  const [location, setLocation] = useState<{ lat: number; lng: number; accuracy: number } | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [photoCount, setPhotoCount] = useState(0);
  const [voiceUrl, setVoiceUrl] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [asrText, setAsrText] = useState<string | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef(0);
  const queryClient = useQueryClient();

  const createCheckin = useMutation({
    mutationFn: async (geo: { lat: number; lng: number; accuracy: number } | null) => {
      const res = await fetch(`/api/crm/profiles/${profileId}/checkins`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(geo || {}),
      });
      if (!res.ok) throw new Error("签到创建失败");
      return res.json();
    },
    onSuccess: (data) => {
      setCheckinId(data.checkin.id);
      setAddress(data.checkin.addressSnapshot);
      setStep("located");
    },
    onError: () => toast.error("签到创建失败"),
  });

  const uploadVoice = useCallback(async (blob: Blob, ext: string) => {
    if (!checkinId) return;
    const fd = new FormData();
    fd.append("file", blob, `voice_${Date.now()}.${ext}`);
    fd.append("checkinId", checkinId);
    const res = await fetch("/api/crm/upload", { method: "POST", body: fd });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || "语音上传失败");
    }
    const data = await res.json();
    const url = data.media?.url as string;
    if (!url) throw new Error("上传未返回 URL");
    // Save voiceUrl to checkin
    const patchRes = await fetch(`/api/crm/profiles/${profileId}/checkins/${checkinId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ voiceUrl: url }),
    });
    if (!patchRes.ok) {
      const patchData = await patchRes.json().catch(() => ({}));
      throw new Error(patchData.error || "保存语音失败");
    }
    setVoiceUrl(url);
    // Trigger ASR
    const asrRes = await fetch(`/api/crm/checkins/${checkinId}/asr`, { method: "POST" });
    if (asrRes.ok) {
      const asrData = await asrRes.json();
      if (asrData.text) setAsrText(asrData.text);
    }
  }, [checkinId, profileId]);

  const startRecording = useCallback(async () => {
    const candidates = ["audio/ogg;codecs=opus", "audio/ogg", "audio/webm;codecs=opus", "audio/webm"];
    let mimeType: string | null = null;
    for (const mime of candidates) {
      if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(mime)) { mimeType = mime; break; }
    }
    if (!mimeType) { toast.error("当前浏览器不支持录音"); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream, { mimeType });
      chunksRef.current = [];
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
        const durationSec = Math.round((Date.now() - startTimeRef.current) / 1000);
        if (durationSec < 1) { toast.warning("录音时间太短"); setRecording(false); return; }
        const ext = mimeType.includes("ogg") ? "ogg" : "webm";
        const blob = new Blob(chunksRef.current, { type: mimeType });
        setRecording(false);
        try {
          await uploadVoice(blob, ext);
          toast.success("语音已保存并识别");
        } catch (err) {
          toast.error(err instanceof Error ? err.message : "语音处理失败");
        }
      };
      mediaRecorderRef.current = recorder;
      startTimeRef.current = Date.now();
      recorder.start(250);
      setRecording(true);
      timerRef.current = setInterval(() => {
        const sec = Math.round((Date.now() - startTimeRef.current) / 1000);
        if (sec >= 60) recorder.stop();
      }, 500);
    } catch {
      toast.error("无法访问麦克风，请检查浏览器权限");
    }
  }, [uploadVoice]);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current?.state === "recording") {
      mediaRecorderRef.current.stop();
    }
  }, []);

  const completeCheckin = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/crm/profiles/${profileId}/checkins/${checkinId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "COMPLETED" }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "完成签到失败");
      }
      return res.json();
    },
    onSuccess: async () => {
      toast.success("签到完成");
      setStep("done");
      const promises: Promise<void>[] = [
        queryClient.invalidateQueries({ queryKey: crmKeys.myToday() }),
        queryClient.invalidateQueries({ queryKey: crmKeys.adminOverview() }),
      ];
      promises.push(queryClient.invalidateQueries({ queryKey: crmKeys.profile(profileId) }));
      await Promise.all(promises);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const startLocating = useCallback(() => {
    setStep("locating");
    if (!navigator.geolocation) {
      toast.error("浏览器不支持定位");
      createCheckin.mutate(null);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const geo = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy };
        setLocation(geo);
        createCheckin.mutate(geo);
      },
      () => {
        toast.error("定位失败，可上传照片完成签到");
        createCheckin.mutate(null);
      },
      { enableHighAccuracy: true, timeout: 15000 }
    );
  }, [createCheckin]);

  useEffect(() => {
    if (autoStart && step === "idle") {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      startLocating();
    }
  }, [autoStart, step, startLocating]);

  // Cleanup recording on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      const recorder = mediaRecorderRef.current;
      if (recorder?.state === "recording") {
        recorder.onstop = () => recorder.stream?.getTracks().forEach((t) => t.stop());
        recorder.stop();
      }
    };
  }, []);

  useEffect(() => {
    if (step === "done" && onDone) {
      const timer = setTimeout(onDone, 2000);
      return () => clearTimeout(timer);
    }
  }, [step, onDone]);

  const handlePhotoUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!checkinId || !e.target.files?.length) return;
    setStep("uploading");
    for (const file of Array.from(e.target.files)) {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("checkinId", checkinId);
      try {
        const res = await fetch("/api/crm/upload", { method: "POST", body: formData });
        if (!res.ok) {
          const data = await res.json();
          toast.error(data.error || "上传失败");
        } else {
          setPhotoCount((c) => c + 1);
        }
      } catch {
        toast.error("上传失败");
      }
    }
    setStep("located");
  }, [checkinId]);

  if (step === "done") {
    return (
      <div className="flex items-center gap-2 text-success text-sm">
        <Check className="h-4 w-4" />签到完成
      </div>
    );
  }

  if (step === "idle") {
    return (
      <Button onClick={startLocating} size="sm">
        <MapPin className="h-4 w-4 mr-1" />现场签到
      </Button>
    );
  }

  if (step === "locating" || createCheckin.isPending) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />正在定位...
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-lg border p-3">
      <div className="text-sm">
        {location ? (
          <span className="text-success">定位成功{address ? `：${address}` : ""}</span>
        ) : (
          <span className="text-warning">定位失败，请上传照片</span>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <label className="cursor-pointer">
          <input type="file" accept="image/*" multiple capture="environment" className="hidden" onChange={handlePhotoUpload} />
          <span className="inline-flex h-11 w-full items-center justify-center gap-1 rounded-md border px-3 text-sm hover:bg-accent">
            <Camera className="h-4 w-4" />
            {step === "uploading" ? "上传中..." : `拍照/上传${photoCount > 0 ? ` (${photoCount})` : ""}`}
          </span>
        </label>
        <Button
          size="sm"
          className="h-11"
          variant={recording ? "destructive" : "outline"}
          onClick={recording ? stopRecording : startRecording}
          disabled={completeCheckin.isPending}
        >
          {recording ? <><Square className="h-4 w-4 mr-1" />停止录音</> : <><Mic className="h-4 w-4 mr-1" />{voiceUrl ? "重新录音" : "录音"}</>}
        </Button>
        <Button
          size="sm"
          className="h-11"
          onClick={() => completeCheckin.mutate()}
          disabled={completeCheckin.isPending || (!location && photoCount === 0 && !voiceUrl)}
        >
          {completeCheckin.isPending ? "提交中..." : "完成签到"}
        </Button>
      </div>
      {asrText && (
        <div className="text-sm text-muted-foreground border-t pt-2">
          <span className="font-medium">语音摘要：</span>{asrText}
        </div>
      )}
    </div>
  );
}

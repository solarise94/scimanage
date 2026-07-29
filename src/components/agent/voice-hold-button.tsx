"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Mic, X } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

/**
 * WeChat-style "按住 说话" (hold-to-talk) button with inline feedback.
 *
 * State machine (driven by Pointer Events, setPointerCapture keeps tracking
 * the gesture after the finger leaves the button bounds):
 *
 *   idle
 *     └─ pointerdown → acquiring (request mic) → recording
 *          ├─ pointermove (deltaY < -CANCEL_THRESHOLD) → recordingCancel
 *          │     └─ back below threshold → recording
 *          ├─ 60s elapsed → finish("max")        (auto stop)
 *          ├─ pointercancel / pointer leaves window → finish("send")
 *          └─ pointerup:
 *                cancel state          → discard, back to idle
 *                duration < 1s         → toast "说话时间太短", discard
 *                otherwise              → transcribing → onTranscribe → onSend → idle
 *
 * Failures (mic permission, ASR) toast and return to idle. Props contract
 * mirrors the composer's voice callbacks so the shell does not change.
 */

const MAX_DURATION_SEC = 60;
const MIN_DURATION_SEC = 1;
/** Upward swipe (negative deltaY) distance in px that flips into cancel mode. */
const CANCEL_THRESHOLD = 60;

type RecordingState = "idle" | "acquiring" | "recording" | "cancel" | "transcribing";

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

export interface VoiceHoldButtonProps {
  /** Upload + ASR; returns transcript text. Throws on failure. */
  onTranscribe: (blob: Blob) => Promise<string>;
  /** Send the transcript immediately after a successful ASR (GPT-style). */
  onSend: (transcript: string) => void;
  /** Disable interaction (e.g. while the agent is busy). */
  disabled?: boolean;
}

export function VoiceHoldButton({ onTranscribe, onSend, disabled }: VoiceHoldButtonProps) {
  const [state, setState] = useState<RecordingState>("idle");
  const [elapsed, setElapsed] = useState(0);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef(0);
  // Pointer state must live in refs: React state does not update synchronously,
  // and getUserMedia may resolve after the user has already lifted their finger.
  const pressedRef = useRef(false);
  const activePointerIdRef = useRef<number | null>(null);
  // clientY captured at pointerdown; used as the cancel-swipe baseline so the
  // threshold doesn't drift if the button reflows mid-recording.
  const pressClientYRef = useRef(0);

  // Resolve a release (pointerup) once the recorder actually stops. pointerup
  // fires before MediaRecorder.onstop, and we need the blob + duration there.
  const pendingResolveRef = useRef<null | ((reason: "send" | "max" | "discard") => void)>(null);
  const mountedRef = useRef(true);
  const cancellingRef = useRef(false);
  const pendingReasonRef = useRef<"send" | "max" | "discard">("send");
  // True from the moment we start finishing a release until the transcribe/send
  // pipeline is fully done. Prevents the 250ms timer firing twice, the unmount
  // cleanup, or a stray pointercancel from interrupting an in-flight release.
  const finishingRef = useRef(false);

  const stopTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const cleanupRecording = useCallback((force: boolean) => {
    stopTimer();
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      try {
        recorder.stop();
      } catch {
        // already stopped
      }
    } else if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (force) {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      mediaRecorderRef.current = null;
    }
  }, [stopTimer]);

  // Unmount safety: stop any in-flight recorder and release the mic.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      pressedRef.current = false;
      activePointerIdRef.current = null;
      cleanupRecording(true);
    };
  }, [cleanupRecording]);

  const finishRecording = useCallback(
    (reason: "send" | "max" | "discard") => {
      // Coordinate with onstop: tell it which path to take. If discarding
      // (cancel) we don't even need the blob — but we still must stop the
      // recorder so the mic indicator turns off.
      //
      // Re-entrancy guard: the 250ms timer can fire `finishRecording("max")`
      // twice before onstop runs (and stops the timer), and the unmount
      // cleanup also stops the recorder. Don't let a second entry corrupt the
      // in-flight release (e.g. clobber the transcribing state with idle).
      if (finishingRef.current) return;
      finishingRef.current = true;
      pendingReasonRef.current = reason;

      const recorder = mediaRecorderRef.current;
      if (!recorder || recorder.state === "inactive") {
        // Recorder never started (e.g. permission denied). Nothing to finish.
        finishingRef.current = false;
        setState("idle");
        return;
      }

      // Resolve once onstop fires (gives us the blob + duration).
      pendingResolveRef.current = (resolvedReason) => {
        if (!mountedRef.current) {
          finishingRef.current = false;
          return;
        }
        const durationMs = Date.now() - startTimeRef.current;
        const blob = new Blob(chunksRef.current, {
          type: recorder.mimeType || "audio/webm",
        });

        if (resolvedReason === "discard" || cancellingRef.current) {
          setState("idle");
          setElapsed(0);
          finishingRef.current = false;
          return;
        }

        if (durationMs < MIN_DURATION_SEC * 1000) {
          toast.warning("说话时间太短");
          setState("idle");
          setElapsed(0);
          finishingRef.current = false;
          return;
        }

        if (blob.size === 0) {
          toast.error("录音失败，请重试");
          setState("idle");
          setElapsed(0);
          finishingRef.current = false;
          return;
        }

        // Transcribe → send.
        setState("transcribing");
        onTranscribe(blob)
          .then((transcript) => {
            const text = transcript.trim();
            if (!text) {
              toast.error("没有识别到有效语音，请重试");
              return;
            }
            onSend(text);
          })
          .catch((error) => {
            toast.error(error instanceof Error ? error.message : "语音识别失败");
          })
          .finally(() => {
            finishingRef.current = false;
            if (mountedRef.current) {
              setState("idle");
              setElapsed(0);
            }
          });
      };

      if (reason === "max") {
        toast.info("最长 60 秒");
      }

      try {
        recorder.stop();
      } catch {
        pendingResolveRef.current?.(reason);
        pendingResolveRef.current = null;
      }
    },
    [onTranscribe, onSend],
  );

  const startRecording = useCallback(async () => {
    if (disabled) return;
    setState("acquiring");

    const mimeType = negotiateMimeType();
    if (!mimeType) {
      toast.error("当前浏览器不支持录音");
      setState("idle");
      return;
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      // A permission prompt may outlive the press. Releasing the button is not
      // a microphone error and must not restart or retain the recording UI.
      if (pressedRef.current) {
        toast.error("无法访问麦克风，请检查浏览器权限");
      }
      setState("idle");
      return;
    }

    // User may have lifted the finger while we were asking for the mic.
    if (!pressedRef.current || cancellingRef.current || !mountedRef.current) {
      stream.getTracks().forEach((t) => t.stop());
      setState("idle");
      return;
    }

    const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    chunksRef.current = [];

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      mediaRecorderRef.current = null;
      stopTimer();
      const resolve = pendingResolveRef.current;
      pendingResolveRef.current = null;
      if (resolve) {
        resolve(pendingReasonRef.current);
      }
    };

    streamRef.current = stream;
    mediaRecorderRef.current = recorder;
    startTimeRef.current = Date.now();
    setElapsed(0);
    recorder.start(250);
    setState("recording");

    stopTimer();
    timerRef.current = setInterval(() => {
      const sec = Math.round((Date.now() - startTimeRef.current) / 1000);
      setElapsed(sec);
      if (sec >= MAX_DURATION_SEC) {
        finishRecording("max");
      }
    }, 250);
  }, [disabled, finishRecording, stopTimer]);

  // ---- Pointer handlers (setPointerCapture keeps move/up firing off-button) ----

  const handlePointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (disabled || state === "transcribing" || pressedRef.current || finishingRef.current) return;
    // Only respond to primary button / touch / pen.
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    pressedRef.current = true;
    activePointerIdRef.current = e.pointerId;
    cancellingRef.current = false;
    pressClientYRef.current = e.clientY;
    void startRecording();
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (!pressedRef.current || activePointerIdRef.current !== e.pointerId) return;
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state === "inactive") return;
    // Vertical up-swipe (negative deltaY) past threshold => cancel mode.
    const deltaY = e.clientY - pressClientYRef.current;
    const shouldCancel = deltaY < -CANCEL_THRESHOLD;
    cancellingRef.current = shouldCancel;
    setState((current) => {
      if (current === "transcribing") return current;
      return shouldCancel ? "cancel" : "recording";
    });
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (activePointerIdRef.current !== e.pointerId) return;
    pressedRef.current = false;
    activePointerIdRef.current = null;
    // Release capture explicitly (the browser also auto-releases on pointerup,
    // but this is clearer and avoids a synthetic event edge case).
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // already released
    }
    if (cancellingRef.current) {
      finishRecording("discard");
      return;
    }
    finishRecording("send");
  };

  const handlePointerCancel = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (activePointerIdRef.current !== e.pointerId) return;
    pressedRef.current = false;
    activePointerIdRef.current = null;
    // pointercancel / finger leaves the window: treat as a normal release
    // (spec: "滑出按钮区域（非上滑取消方向）按正常松手处理").
    if (cancellingRef.current) {
      finishRecording("discard");
    } else {
      finishRecording("send");
    }
  };

  const pressing = state === "recording" || state === "cancel" || state === "acquiring";

  return (
    <button
      type="button"
      // Disable native context menu / text selection / scroll-chain on long press.
      onContextMenu={(e) => e.preventDefault()}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      disabled={disabled || state === "transcribing"}
      // `touch-none` is essential: without it the browser claims the gesture
      // for scrolling and we never see pointermove/up.
      className={cn(
        "flex h-11 w-full select-none items-center justify-center rounded-2xl text-sm font-medium transition-colors",
        "touch-none [-webkit-touch-callout:none] [-webkit-user-select:none] [user-select:none]",
        state === "cancel"
          ? "bg-danger text-white"
          : pressing
            ? "bg-primary text-primary-foreground"
            : "bg-muted/60 text-foreground hover:bg-muted",
        disabled && "opacity-50",
      )}
      aria-label="按住说话"
    >
      {state === "transcribing" ? (
          <>
            <VoiceBars className="mr-2" />
            识别中…
          </>
        ) : state === "cancel" ? (
          <>
            <X className="mr-1.5 h-4 w-4" />
            松开手指，取消发送
          </>
        ) : state === "recording" ? (
          <>
            <VoiceBars className="mr-2" />
            <span>松开 发送</span>
            <span className="ml-2 font-mono text-xs tabular-nums opacity-80">
              {Math.floor(elapsed / 60)}:{(elapsed % 60).toString().padStart(2, "0")}
            </span>
          </>
        ) : state === "acquiring" ? (
          <>
            <Mic className="mr-1.5 h-4 w-4" />
            准备录音…
          </>
        ) : (
          <>
            <Mic className="mr-1.5 h-4 w-4" />
            按住 说话
          </>
      )}
    </button>
  );
}

function VoiceBars({ className }: { className?: string }) {
  return (
    <span className={cn("flex h-4 items-end gap-0.5", className)} aria-hidden="true">
      {[0, 1, 2, 3, 4].map((i) => (
        <span
          key={i}
          className="h-full w-0.5 rounded-full bg-current"
          style={{
            animation: "voiceholdbar 0.9s ease-in-out infinite",
            animationDelay: `${i * 120}ms`,
          }}
        />
      ))}
    </span>
  );
}

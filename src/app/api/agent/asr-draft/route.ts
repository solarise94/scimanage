import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getSpeechProvider, isAnyAsrConfigured } from "@/lib/draft/providers";
import { requireAgentAccess } from "@/lib/agent-actions/require-agent-access";

/**
 * Agent ASR draft endpoint.
 *
 * Instant (in-memory) speech-to-text for the Agent mobile composer's voice
 * input.  Audio is NOT persisted - only the transcript is returned for the
 * user to review and edit before sending.
 *
 * Auth: requires user session (401 if no session).
 * Config: 503 if neither local nor fallback ASR is configured.
 * Limits: 10MB max (pre-flight via content-length + post-parse via file.size).
 * MIME: must be audio/*, extension in ALLOWED_AUDIO_EXT.
 * Rate limit: 10 requests per userId per 60-second window (429 if exceeded).
 * Timeout: 30s provider timeout (504 on timeout).
 *
 * @see docs/agent-mobile-crm-genui-functional-design-2026-07-14.md §5.5, §11.3, §13 Phase 4
 * @see docs/agent-mobile-and-crm-review-bug-fix-plan-2026-07-14.md AGENT-P2-03
 */
const ALLOWED_AUDIO_EXT = new Set([".webm", ".ogg", ".mp3", ".m4a", ".wav", ".aac"]);
const MAX_MB = 10;

// ── In-memory rate limiter (per userId, sliding window) ──
const RATE_LIMIT_WINDOW_MS = 60_000; // 60 seconds
const RATE_LIMIT_MAX_REQUESTS = 10;
const userRequestTimestamps = new Map<string, number[]>();

function checkRateLimit(userId: string): { allowed: boolean; retryAfterMs: number } {
  const now = Date.now();
  const timestamps = userRequestTimestamps.get(userId) ?? [];
  const recent = timestamps.filter((ts) => now - ts < RATE_LIMIT_WINDOW_MS);
  if (recent.length >= RATE_LIMIT_MAX_REQUESTS) {
    const oldest = recent[0];
    const retryAfterMs = RATE_LIMIT_WINDOW_MS - (now - oldest);
    return { allowed: false, retryAfterMs: Math.max(1000, retryAfterMs) };
  }
  recent.push(now);
  userRequestTimestamps.set(userId, recent);
  return { allowed: true, retryAfterMs: 0 };
}

// Periodically clean up stale entries to prevent unbounded growth
if (typeof setInterval !== "undefined") {
  setInterval(() => {
    const now = Date.now();
    for (const [userId, timestamps] of userRequestTimestamps) {
      const recent = timestamps.filter((ts) => now - ts < RATE_LIMIT_WINDOW_MS);
      if (recent.length === 0) {
        userRequestTimestamps.delete(userId);
      } else {
        userRequestTimestamps.set(userId, recent);
      }
    }
  }, RATE_LIMIT_WINDOW_MS).unref?.();
}

const PROVIDER_TIMEOUT_MS = 30_000;

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requireAgentAccess(session);
  if (denied) return denied;

  if (!(await isAnyAsrConfigured())) {
    return NextResponse.json({ error: "语音识别服务未配置" }, { status: 503 });
  }

  // ── Rate limit ──
  const rateCheck = checkRateLimit(session.user.id);
  if (!rateCheck.allowed) {
    return NextResponse.json(
      { error: "请求过于频繁，请稍后再试", code: "RATE_LIMITED" },
      { status: 429, headers: { "Retry-After": String(Math.ceil(rateCheck.retryAfterMs / 1000)) } },
    );
  }

  // Pre-flight: reject oversize requests before parsing multipart body into memory
  const contentLength = req.headers.get("content-length");
  if (contentLength) {
    const size = parseInt(contentLength, 10);
    if (!isNaN(size) && size > MAX_MB * 1024 * 1024) {
      return NextResponse.json({ error: `文件大小不能超过 ${MAX_MB}MB` }, { status: 413 });
    }
  }

  let file: File | null;
  try {
    const formData = await req.formData();
    file = formData.get("file") as File | null;
  } catch {
    return NextResponse.json({ error: "无法解析音频文件" }, { status: 400 });
  }

  if (!file) return NextResponse.json({ error: "file is required" }, { status: 400 });

  // Validate extension
  const ext = file.name.includes(".") ? file.name.slice(file.name.lastIndexOf(".")).toLowerCase() : "";
  if (!ALLOWED_AUDIO_EXT.has(ext)) {
    return NextResponse.json({ error: "不支持的音频格式", code: "INVALID_FORMAT" }, { status: 400 });
  }

  // Validate MIME type
  const mimeType = file.type || "audio/webm";
  if (!mimeType.startsWith("audio/")) {
    return NextResponse.json({ error: "不支持的音频格式", code: "INVALID_FORMAT" }, { status: 400 });
  }

  // Validate file size before reading into memory
  if (file.size > MAX_MB * 1024 * 1024) {
    return NextResponse.json({ error: `文件大小不能超过 ${MAX_MB}MB`, code: "FILE_TOO_LARGE" }, { status: 400 });
  }

  // In-memory transcription - audio is NOT persisted
  const buffer = Buffer.from(await file.arrayBuffer());

  // ── Provider call with AbortController timeout ──
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);

  try {
    const speech = getSpeechProvider();

    const result = await speech.transcribe({
      data: buffer,
      mimeType,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    return NextResponse.json({ transcript: result.text });
  } catch (err) {
    clearTimeout(timeoutId);
    // Auditable error classification
    const isTimeout = controller.signal.aborted
      || (err instanceof Error && err.message === "PROVIDER_TIMEOUT")
      || (err instanceof Error && err.name === "AbortError");
    const message = err instanceof Error ? err.message : "语音识别失败";
    const status = isTimeout ? 504 : 500;
    const code = isTimeout ? "PROVIDER_TIMEOUT" : "ASR_FAILED";

    console.error("[AGENT][ASR] transcription failed:", {
      userId: session.user.id,
      mimeType,
      size: file.size,
      error: message,
      code,
    });

    return NextResponse.json(
      { error: isTimeout ? "语音识别超时，请重试" : "语音识别失败，请重新录音", code },
      { status },
    );
  }
}

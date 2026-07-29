/**
 * LocalAsrProvider — 本地自建 ASR 服务客户端（asr-fast / whisper large-v3）。
 *
 * ── 服务约定（与 vector.ts 同一套 Hub 网关约定）──────────────────────────────
 * Base URL: ASR_LOCAL_BASE_URL
 *   - 默认 http://127.0.0.1:8102（asr-fast，SenseVoiceSmall+VAD，短语音指令）
 *   - 生产 Hub 网关示例 http://your-asr-gateway:48202/api/asr-fast
 * - GET  /health/ready                     → {"ready": true}
 * - POST /v1/transcriptions                multipart，字段名 `file`
 *                                          → {"status":"done","text":"...",
 *                                             "audioDurationSeconds":2.0,
 *                                             "elapsedSeconds":0.4}
 *   非 2xx 或 JSON 无 text 视为失败（抛错供上层 fallback）。
 *
 * ── 鉴权 ────────────────────────────────────────────────────────────────────
 * ASR_LOCAL_API_KEY 设置时所有请求（/health/ready、/v1/transcriptions）携带
 * `Authorization: Bearer <key>`（Hub 网关需要）；未设置时不加（本机直连无需 key）。
 * 该 key 只从 env 读取，绝不硬编码进源码/脚本/git（见 AGENTS.md 安全规范）。
 *
 * ── 客户端不需要音频转换 ─────────────────────────────────────────────────────
 * 本地服务自带 ffmpeg（服务端处理 VAD/解码），客户端原样上传 webm/ogg/mp3/wav
 * 等任意音频，不做任何 webm→wav 转换——跳过 TencentAsrProvider 那套客户端 ffmpeg 逻辑。
 *
 * ── health 缓存 ─────────────────────────────────────────────────────────────
 * /health/ready 结果在进程内缓存 60s（与 vector.ts 一致），避免热路径反复探活。
 * 缓存只对本 provider 进程内有效；smoke 测试若需要隔离缓存，请用动态 import。
 */

import type { SpeechProvider } from "./types";

// ── env 解析 ────────────────────────────────────────────────────────────────

function baseUrl(): string {
  return (process.env.ASR_LOCAL_BASE_URL || "http://127.0.0.1:8102").replace(/\/+$/, "");
}

/**
 * 可选 Bearer key（生产 Hub 网关需要；本机直连无需）。仅从 env 读取。
 * trim 后为空字符串视为「未设置」。
 */
function apiKey(): string {
  return (process.env.ASR_LOCAL_API_KEY || "").trim();
}

function timeoutMs(): number {
  const raw = parseInt(process.env.ASR_LOCAL_TIMEOUT_MS || "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 2_000;
}

/**
 * 构造请求 headers：
 * - 仅供 form-data 时调用（POST /v1/transcriptions 由 FormData 自动设置
 *   content-type boundary，故此处不强制写 content-type）；
 * - 设置 key 时追加 Authorization。
 */
function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const key = apiKey();
  if (key) headers["Authorization"] = `Bearer ${key}`;
  return headers;
}

// ── 常量 ─────────────────────────────────────────────────────────────────────

/** health 探活进程内缓存（毫秒）。 */
const HEALTH_CACHE_MS = 60_000;
/** 探活失败只短暂缓存，避免一次公网抖动让本地档被跳过整整一分钟。 */
const HEALTH_FAILURE_CACHE_MS = 5_000;
/** 探活属于快速前置判断，不应吃掉转写的 2 秒预算。 */
const HEALTH_TIMEOUT_MS = 1_000;

// ── health（带 60s 缓存） ───────────────────────────────────────────────────

let healthCache: { ready: boolean; expiresAt: number } | null = null;

/**
 * 探活本地 ASR 服务是否就绪。结果在进程内缓存 60s。
 * 任何错误降级为 false（不抛）——这是 FallbackSpeechProvider 决定是否跳过
 * 本地档、直接走腾讯云的关键信号。
 */
export async function isLocalAsrReady(): Promise<boolean> {
  const now = Date.now();
  if (healthCache && healthCache.expiresAt > now) {
    return healthCache.ready;
  }
  try {
    const res = await fetch(`${baseUrl()}/health/ready`, {
      method: "GET",
      headers: authHeaders(),
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(
        `[local-asr] /health/ready returned status ${res.status}; treating as not ready`,
      );
      healthCache = { ready: false, expiresAt: now + HEALTH_FAILURE_CACHE_MS };
      return false;
    }
    const json = (await res.json()) as { ready?: unknown };
    const ready = json?.ready === true;
    healthCache = { ready, expiresAt: now + HEALTH_CACHE_MS };
    return ready;
  } catch (err) {
    console.warn(
      `[local-asr] /health/ready failed; treating as not ready:`,
      err instanceof Error ? err.message : err,
    );
    healthCache = { ready: false, expiresAt: now + HEALTH_FAILURE_CACHE_MS };
    return false;
  }
}

// ── MIME → 文件扩展名（仅用于 multipart filename，服务端按内容自识别） ──────

function extForMime(mimeType: string): string {
  if (mimeType.includes("webm")) return "webm";
  if (mimeType.includes("ogg")) return "ogg";
  if (mimeType.includes("mp3") || mimeType.includes("mpeg")) return "mp3";
  if (mimeType.includes("m4a")) return "m4a";
  if (mimeType.includes("mp4")) return "mp4";
  if (mimeType.includes("aac")) return "aac";
  if (mimeType.includes("wav")) return "wav";
  return "bin";
}

type TranscriptionResponse = {
  status?: string;
  text?: unknown;
  audioDurationSeconds?: number;
  elapsedSeconds?: number;
};

/**
 * 本地 ASR Provider。
 *
 * transcribe 直接把客户端拿到的原始音频 Buffer（webm/ogg/wav/...）以 multipart
 * `file` 字段 POST 给 `${base}/v1/transcriptions`。服务端自带 ffmpeg 处理任意格式，
 * 因此本 provider **不做任何客户端转换**（与 TencentAsrProvider 不同）。
 */
export class LocalAsrProvider implements SpeechProvider {
  async transcribe(params: {
    data: Buffer;
    mimeType: string;
    language?: string;
    signal?: AbortSignal;
  }): Promise<{
    text: string;
    durationMs?: number;
    words?: Array<{ startMs: number; endMs: number; word: string }>;
  }> {
    // 调用方（FallbackSpeechProvider）应在就绪时才进来；这里仍做一次防御。
    if (params.signal?.aborted) {
      throw new Error("PROVIDER_TIMEOUT");
    }

    const ext = extForMime(params.mimeType);
    const filename = `audio.${ext}`;

    // 用 FormData 让运行时自动生成 multipart boundary。
    // Node 的 undici FormData 接受 Blob；包一层带 mime 的 Blob 以保留原 content-type。
    const blob = new Blob([new Uint8Array(params.data)], { type: params.mimeType || `audio/${ext}` });
    const form = new FormData();
    form.append("file", blob, filename);

    // AbortController 合并：调用方 signal + 本 provider 的 timeoutMs。
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs());
    const onCallerAbort = () => controller.abort();
    if (params.signal) {
      if (params.signal.aborted) controller.abort();
      else params.signal.addEventListener("abort", onCallerAbort, { once: true });
    }

    try {
      const res = await fetch(`${baseUrl()}/v1/transcriptions`, {
        method: "POST",
        headers: authHeaders(),
        body: form,
        signal: controller.signal,
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(
          `本地 ASR 请求失败 (${res.status}): ${detail.slice(0, 200)}`,
        );
      }

      const json = (await res.json()) as TranscriptionResponse;
      // text 必须是非空字符串；否则视为失败以触发上层 fallback。
      if (typeof json?.text !== "string") {
        throw new Error("本地 ASR 返回缺少 text 字段");
      }
      const text = json.text;
      if (text.length === 0) {
        // 空文本也视为失败（多数情况是上游解析错误），交给 fallback 顶上。
        throw new Error("本地 ASR 返回空文本");
      }

      const durationMs =
        typeof json.audioDurationSeconds === "number"
          ? Math.round(json.audioDurationSeconds * 1000)
          : undefined;

      // 仅日志，不改变返回类型（与 TencentAsrProvider 一致：不外露 elapsed）。
      if (typeof json.elapsedSeconds === "number") {
        console.log(
          `[local-asr] transcribed ${durationMs ?? 0}ms audio in ${json.elapsedSeconds}s`,
        );
      }

      return { text, durationMs };
    } catch (error) {
      if (controller.signal.aborted && !params.signal?.aborted) {
        throw new Error(`LOCAL_ASR_TIMEOUT (${timeoutMs()}ms)`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
      if (params.signal) {
        params.signal.removeEventListener("abort", onCallerAbort);
      }
    }
  }
}

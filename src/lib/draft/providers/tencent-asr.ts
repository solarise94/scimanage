import type { SpeechProvider } from "./types";
import { createHmac, createHash } from "crypto";
import { execFile } from "child_process";
import { writeFile, unlink, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";

const ENDPOINT = "asr.tencentcloudapi.com";
const SERVICE = "asr";
const VERSION = "2019-06-14";
const ACTION = "SentenceRecognition";

function getSecretId(): string {
  return process.env.TENCENTCLOUD_SECRET_ID || "";
}
function getSecretKey(): string {
  return process.env.TENCENTCLOUD_SECRET_KEY || "";
}

function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmacSha256(key: string | Buffer, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

/**
 * Canonicalize every browser container to PCM WAV before Tencent ASR.
 * Mobile browsers frequently advertise ogg/mp4 support while producing a
 * container/codec combination Tencent cannot decode reliably.
 */
export function needsTencentWavConversion(mimeType: string): boolean {
  return !mimeType.includes("wav");
}

/**
 * Map MIME type to Tencent ASR VoiceFormat.
 * Only called after conversion (if needed), so webm should never reach here.
 */
function toVoiceFormat(mimeType: string): string {
  if (mimeType.includes("wav")) return "wav";
  if (mimeType.includes("mp3") || mimeType.includes("mpeg")) return "mp3";
  if (mimeType.includes("m4a") || mimeType.includes("mp4")) return "m4a";
  if (mimeType.includes("ogg")) return "ogg-opus";
  if (mimeType.includes("aac")) return "aac";
  if (mimeType.includes("amr")) return "amr";
  return "wav";
}

/** Convert audio to 16kHz mono WAV using ffmpeg. */
async function convertToWav(inputData: Buffer, inputMime: string, signal?: AbortSignal): Promise<Buffer> {
  const nonce = randomBytes(4).toString("hex");
  const ext = inputMime.includes("ogg")
    ? "ogg"
    : inputMime.includes("mp4") || inputMime.includes("m4a")
      ? "m4a"
      : inputMime.includes("mp3") || inputMime.includes("mpeg")
        ? "mp3"
        : inputMime.includes("aac")
          ? "aac"
          : inputMime.includes("amr")
            ? "amr"
            : "webm";
  const inputPath = join(tmpdir(), `asr_in_${nonce}.${ext}`);
  const outputPath = join(tmpdir(), `asr_out_${nonce}.wav`);

  await writeFile(inputPath, inputData);

  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let onAbort: (() => void) | undefined;

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        if (signal && onAbort) {
          signal.removeEventListener("abort", onAbort);
        }
        fn();
      };

      const child = execFile("ffmpeg", [
        "-y", "-i", inputPath,
        "-ar", "16000", "-ac", "1", "-f", "wav",
        outputPath,
      ], { timeout: 30000 }, (err, _stdout, stderr) => {
        if (err) {
          const msg = (err as NodeJS.ErrnoException).code === "ENOENT"
            ? "服务器未安装 ffmpeg，无法转换此音频格式。请使用 Firefox 或 Safari 录音（原生 ogg/mp4 格式无需转换）"
            : `ffmpeg 转换失败: ${stderr || err.message}`;
          finish(() => reject(new Error(msg)));
        } else {
          finish(() => resolve());
        }
      });

      // Abort ffmpeg if signal fires; always remove the listener on settle.
      if (signal) {
        onAbort = () => {
          child.kill("SIGKILL");
          finish(() => reject(new Error("PROVIDER_TIMEOUT")));
        };
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort);
      }
    });

    return await readFile(outputPath);
  } finally {
    await unlink(inputPath).catch(() => {});
    await unlink(outputPath).catch(() => {});
  }
}

function buildAuthorization(
  secretId: string,
  secretKey: string,
  timestamp: number,
  payload: string,
): string {
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const credentialScope = `${date}/${SERVICE}/tc3_request`;

  const httpMethod = "POST";
  const canonicalUri = "/";
  const canonicalQueryString = "";
  const canonicalHeaders = `content-type:application/json\nhost:${ENDPOINT}\nx-tc-action:${ACTION.toLowerCase()}\n`;
  const signedHeaders = "content-type;host;x-tc-action";
  const hashedPayload = sha256(payload);
  const canonicalRequest = [
    httpMethod, canonicalUri, canonicalQueryString,
    canonicalHeaders, signedHeaders, hashedPayload,
  ].join("\n");

  const algorithm = "TC3-HMAC-SHA256";
  const hashedCanonicalRequest = sha256(canonicalRequest);
  const stringToSign = [algorithm, String(timestamp), credentialScope, hashedCanonicalRequest].join("\n");

  const secretDate = hmacSha256(`TC3${secretKey}`, date);
  const secretService = hmacSha256(secretDate, SERVICE);
  const secretSigning = hmacSha256(secretService, "tc3_request");
  const signature = createHmac("sha256", secretSigning).update(stringToSign).digest("hex");

  return `${algorithm} Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

export class TencentAsrProvider implements SpeechProvider {
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
    const secretId = getSecretId();
    const secretKey = getSecretKey();
    if (!secretId || !secretKey) {
      throw new Error("腾讯云 ASR 未配置，请设置 TENCENTCLOUD_SECRET_ID 和 TENCENTCLOUD_SECRET_KEY");
    }

    // Check abort signal before starting work
    if (params.signal?.aborted) {
      throw new Error("PROVIDER_TIMEOUT");
    }

    // Normalize browser-recorded containers/codecs to a Tencent-safe WAV.
    let audioData = params.data;
    let voiceFormat: string;

    if (needsTencentWavConversion(params.mimeType)) {
      audioData = await convertToWav(params.data, params.mimeType, params.signal);
      voiceFormat = "wav";
    } else {
      voiceFormat = toVoiceFormat(params.mimeType);
    }

    // Check abort signal after conversion
    if (params.signal?.aborted) {
      throw new Error("PROVIDER_TIMEOUT");
    }

    // Tencent ASR limit: 3MB after conversion
    if (audioData.length > 3 * 1024 * 1024) {
      throw new Error("音频文件不能超过 3MB");
    }

    const base64Data = audioData.toString("base64");

    const body = JSON.stringify({
      EngSerViceType: "16k_zh",
      SourceType: 1,
      VoiceFormat: voiceFormat,
      Data: base64Data,
      DataLen: audioData.length,
      WordInfo: 2,
    });

    const timestamp = Math.floor(Date.now() / 1000);
    const authorization = buildAuthorization(secretId, secretKey, timestamp, body);

    const res = await fetch(`https://${ENDPOINT}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Host": ENDPOINT,
        "X-TC-Action": ACTION,
        "X-TC-Version": VERSION,
        "X-TC-Timestamp": String(timestamp),
        Authorization: authorization,
      },
      body,
      signal: params.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`腾讯云 ASR 请求失败 (${res.status}): ${text}`);
    }

    const data = await res.json();
    const response = data.Response;

    if (response?.Error) {
      throw new Error(`腾讯云 ASR 错误 [${response.Error.Code}]: ${response.Error.Message}`);
    }

    const result = response?.Result || "";
    const durationMs = response?.AudioDuration ? response.AudioDuration : undefined;

    const wordList: Array<{ startMs: number; endMs: number; word: string }> = [];
    if (response?.WordList?.length) {
      for (const w of response.WordList) {
        wordList.push({
          startMs: w.StartTime ?? 0,
          endMs: w.EndTime ?? 0,
          word: w.Word ?? "",
        });
      }
    }

    return {
      text: result,
      durationMs,
      words: wordList.length > 0 ? wordList : undefined,
    };
  }
}

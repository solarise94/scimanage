import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getSpeechProvider, isAnyAsrConfigured } from "@/lib/draft/providers";

const ALLOWED_AUDIO_EXT = new Set([".webm", ".ogg", ".mp3", ".m4a", ".wav", ".aac"]);
const MAX_MB = 10;

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!(await isAnyAsrConfigured())) {
    return NextResponse.json({ error: "语音识别服务未配置" }, { status: 503 });
  }

  // Pre-flight: reject oversize requests before parsing multipart body into memory
  const contentLength = req.headers.get("content-length");
  if (contentLength) {
    const size = parseInt(contentLength, 10);
    if (!isNaN(size) && size > MAX_MB * 1024 * 1024) {
      return NextResponse.json({ error: `文件大小不能超过 ${MAX_MB}MB` }, { status: 413 });
    }
  }

  const formData = await req.formData();
  const file = formData.get("file") as File | null;
  if (!file) return NextResponse.json({ error: "file is required" }, { status: 400 });

  // Validate extension
  const ext = file.name.includes(".") ? file.name.slice(file.name.lastIndexOf(".")).toLowerCase() : "";
  if (!ALLOWED_AUDIO_EXT.has(ext)) {
    return NextResponse.json({ error: "不支持的音频格式" }, { status: 400 });
  }

  // Validate MIME type
  const mimeType = file.type || "audio/webm";
  if (!mimeType.startsWith("audio/")) {
    return NextResponse.json({ error: "不支持的音频格式" }, { status: 400 });
  }

  // Validate file size before reading into memory
  if (file.size > MAX_MB * 1024 * 1024) {
    return NextResponse.json({ error: `文件大小不能超过 ${MAX_MB}MB` }, { status: 400 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());

  try {
    const speech = getSpeechProvider();
    const result = await speech.transcribe({ data: buffer, mimeType });
    return NextResponse.json({ transcript: result.text });
  } catch (err) {
    console.error("Draft ASR failed:", err);
    const message = err instanceof Error ? err.message : "语音识别失败";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

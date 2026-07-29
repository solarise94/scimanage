import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { isRepresentative } from "@/lib/permissions";
import { resolveDraftMediaPath, deleteDraftMediaFile } from "@/lib/draft/media";
import { getSpeechProvider, isAnyAsrConfigured } from "@/lib/draft/providers";
import { readFile } from "fs/promises";

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (isRepresentative(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!(await isAnyAsrConfigured())) {
    return NextResponse.json({ error: "语音识别未配置" }, { status: 503 });
  }

  let filePath: string | null = null;
  try {
    const { fileId, mimeType } = await req.json();
    if (!fileId || typeof fileId !== "string") {
      return NextResponse.json({ error: "缺少 fileId" }, { status: 400 });
    }

    const userId = session.user.id;
    filePath = await resolveDraftMediaPath(fileId, userId);
    if (!filePath) {
      return NextResponse.json({ error: "文件不存在或无权访问" }, { status: 404 });
    }

    const data = await readFile(filePath);
    const speech = getSpeechProvider();
    const result = await speech.transcribe({
      data,
      mimeType: mimeType || "audio/webm",
    });

    return NextResponse.json({
      text: result.text,
      durationMs: result.durationMs,
    });
  } catch (error) {
    console.error("语音转写失败:", error);
    const msg = error instanceof Error ? error.message : "转写失败";
    return NextResponse.json({ error: msg }, { status: 500 });
  } finally {
    // Always clean up temp file, whether success or failure
    if (filePath) await deleteDraftMediaFile(filePath);
  }
}

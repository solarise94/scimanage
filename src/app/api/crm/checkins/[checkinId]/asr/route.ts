import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getSpeechProvider } from "@/lib/draft/providers";
import { readFile } from "fs/promises";
import { resolveCheckinFilePath } from "@/lib/crm/media";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ checkinId: string }> }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { checkinId } = await params;
  const checkin = await prisma.crmVisitCheckin.findUnique({
    where: { id: checkinId },
    select: { id: true, userId: true, voiceUrl: true, asrStatus: true },
  });

  if (!checkin) return NextResponse.json({ error: "Checkin not found" }, { status: 404 });
  if (checkin.userId !== session.user.id && session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!checkin.voiceUrl) {
    return NextResponse.json({ error: "没有可识别的语音文件" }, { status: 400 });
  }

  // Validate voiceUrl belongs to this checkin and resolve local path
  const filePath = resolveCheckinFilePath(checkin.voiceUrl, checkinId);
  if (!filePath) {
    return NextResponse.json({ error: "无效的音频路径" }, { status: 400 });
  }

  // Mark as transcribing
  await prisma.crmVisitCheckin.update({
    where: { id: checkinId },
    data: { asrStatus: "TRANSCRIBING" },
  });

  try {
    const speech = getSpeechProvider();
    const buffer = await readFile(filePath);
    const urlExt = checkin.voiceUrl.endsWith(".ogg") ? "audio/ogg"
      : checkin.voiceUrl.endsWith(".mp3") ? "audio/mpeg"
      : checkin.voiceUrl.endsWith(".m4a") ? "audio/mp4"
      : checkin.voiceUrl.endsWith(".wav") ? "audio/wav"
      : checkin.voiceUrl.endsWith(".aac") ? "audio/aac"
      : "audio/webm";

    const result = await speech.transcribe({ data: buffer, mimeType: urlExt });

    await prisma.crmVisitCheckin.update({
      where: { id: checkinId },
      data: { transcript: result.text, asrStatus: "DONE" },
    });

    return NextResponse.json({ text: result.text, durationMs: result.durationMs });
  } catch (err) {
    console.error("Checkin ASR failed:", err);
    await prisma.crmVisitCheckin.update({
      where: { id: checkinId },
      data: { asrStatus: "FAILED" },
    }).catch(() => {});
    return NextResponse.json({ error: "语音识别失败" }, { status: 500 });
  }
}

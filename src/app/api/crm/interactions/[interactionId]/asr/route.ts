import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getSpeechProvider } from "@/lib/draft/providers";
import { readFile } from "fs/promises";
import { resolveFilePath } from "@/lib/crm/media";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ interactionId: string }> }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { interactionId } = await params;
  const interaction = await prisma.crmInteraction.findUnique({
    where: { id: interactionId },
    select: { id: true, createdByUserId: true, voiceUrl: true, asrStatus: true },
  });

  if (!interaction) return NextResponse.json({ error: "Interaction not found" }, { status: 404 });
  if (interaction.createdByUserId !== session.user.id && session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!interaction.voiceUrl) {
    return NextResponse.json({ error: "没有可识别的语音文件" }, { status: 400 });
  }

  const filePath = resolveFilePath(interaction.voiceUrl, interactionId, "interaction");
  if (!filePath) {
    return NextResponse.json({ error: "无效的音频路径" }, { status: 400 });
  }

  await prisma.crmInteraction.update({
    where: { id: interactionId },
    data: { asrStatus: "TRANSCRIBING" },
  });

  try {
    const speech = getSpeechProvider();
    const buffer = await readFile(filePath);
    const urlExt = interaction.voiceUrl.endsWith(".ogg") ? "audio/ogg"
      : interaction.voiceUrl.endsWith(".mp3") ? "audio/mpeg"
      : interaction.voiceUrl.endsWith(".m4a") ? "audio/mp4"
      : interaction.voiceUrl.endsWith(".wav") ? "audio/wav"
      : interaction.voiceUrl.endsWith(".aac") ? "audio/aac"
      : "audio/webm";

    const result = await speech.transcribe({ data: buffer, mimeType: urlExt });

    await prisma.crmInteraction.update({
      where: { id: interactionId },
      data: { transcript: result.text, asrStatus: "DONE" },
    });

    return NextResponse.json({ text: result.text, durationMs: result.durationMs });
  } catch (err) {
    console.error("Interaction ASR failed:", err);
    await prisma.crmInteraction.update({
      where: { id: interactionId },
      data: { asrStatus: "FAILED" },
    }).catch(() => {});
    return NextResponse.json({ error: "语音识别失败" }, { status: 500 });
  }
}

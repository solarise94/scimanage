import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { validateVoiceUrl } from "@/lib/crm/media";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ interactionId: string }> }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { interactionId } = await params;

  const interaction = await prisma.crmInteraction.findUnique({ where: { id: interactionId } });
  if (!interaction) return NextResponse.json({ error: "Interaction not found" }, { status: 404 });
  if (interaction.createdByUserId !== session.user.id && session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json();
  const data: Record<string, unknown> = {};

  if (body.voiceUrl !== undefined) {
    if (typeof body.voiceUrl !== "string" || !validateVoiceUrl(body.voiceUrl, interactionId, "interaction")) {
      return NextResponse.json({ error: "无效的语音文件路径" }, { status: 400 });
    }
    data.voiceUrl = body.voiceUrl;
    if (!interaction.voiceUrl && interaction.asrStatus === "NONE") {
      data.asrStatus = "UPLOADED";
    }
  }

  const updated = await prisma.crmInteraction.update({
    where: { id: interactionId },
    data,
    include: { createdByUser: { select: { id: true, name: true } } },
  });

  return NextResponse.json({ interaction: updated });
}

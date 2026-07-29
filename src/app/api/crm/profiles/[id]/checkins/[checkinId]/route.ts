import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { businessActorFromSessionUser, buildInvocationContext } from "@/lib/application/actor";
import { ApplicationError } from "@/lib/application/errors";
import { prisma } from "@/lib/prisma";
import { validateCheckinVoiceUrl } from "@/lib/crm/media";
import { completeVisitCheckinForActor } from "@/lib/crm/application/create-visit-checkin";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; checkinId: string }> }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id, checkinId } = await params;

  const checkin = await prisma.crmVisitCheckin.findUnique({
    where: { id: checkinId },
    include: { media: true },
  });
  if (!checkin) return NextResponse.json({ error: "Checkin not found" }, { status: 404 });
  if (checkin.userId !== session.user.id && session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json();
  const data: Record<string, unknown> = {};

  // Accept voice URL (audio upload) - validate path and extension
  if (body.voiceUrl) {
    if (typeof body.voiceUrl !== "string" || !validateCheckinVoiceUrl(body.voiceUrl, checkinId)) {
      return NextResponse.json({ error: "无效的语音文件路径" }, { status: 400 });
    }
    data.voiceUrl = body.voiceUrl;
    if (!checkin.voiceUrl && checkin.asrStatus === "NONE") {
      data.asrStatus = "UPLOADED";
    }
  }

  if (body.status === "COMPLETED") {
    try {
      const actor = businessActorFromSessionUser(session.user);
      const invocation = buildInvocationContext({ channel: "web" });
      const result = await completeVisitCheckinForActor(actor, invocation, {
        profileId: id,
        checkinId,
        voiceUrl: typeof data.voiceUrl === "string" ? data.voiceUrl : undefined,
      });
      return NextResponse.json({ checkin: result.checkin });
    } catch (err) {
      if (err instanceof ApplicationError) {
        return NextResponse.json({ error: err.message }, { status: err.httpStatus });
      }
      throw err;
    }
  }

  const updated = await prisma.crmVisitCheckin.update({
    where: { id: checkinId },
    data,
    include: {
      media: true,
      user: { select: { id: true, name: true } },
    },
  });

  return NextResponse.json({ checkin: updated });
}

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertCrmProfileAccess } from "@/lib/crm/permissions";
import { resolveComplaint } from "@/lib/crm/complaints";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ complaintId: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { complaintId } = await params;

  const existing = await prisma.crmComplaint.findUnique({
    where: { id: complaintId },
    select: { id: true, profileId: true },
  });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    await assertCrmProfileAccess(existing.profileId, session.user.id, session.user.role);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "";
    if (msg === "NOT_FOUND") return NextResponse.json({ error: "Profile not found" }, { status: 404 });
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const { resolutionSummary } = body;

  try {
    const complaint = await resolveComplaint({
      complaintId,
      actorUserId: session.user.id,
      resolutionSummary: resolutionSummary?.trim() || undefined,
    });
    return NextResponse.json({ complaint });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "";
    if (msg === "NOT_FOUND") return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (msg === "INVALID_STATUS") return NextResponse.json({ error: "当前状态不可标记为已解决" }, { status: 400 });
    return NextResponse.json({ error: "标记解决失败" }, { status: 500 });
  }
}

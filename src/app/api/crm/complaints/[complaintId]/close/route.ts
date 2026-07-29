import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertCrmProfileAccess } from "@/lib/crm/permissions";
import { closeComplaint } from "@/lib/crm/complaints";

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
  const { customerSatisfied } = body;

  try {
    const result = await closeComplaint({
      complaintId,
      actorUserId: session.user.id,
      customerSatisfied: typeof customerSatisfied === "boolean" ? customerSatisfied : undefined,
    });
    return NextResponse.json(result);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "";
    if (msg === "NOT_FOUND") return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (msg === "ALREADY_CLOSED") return NextResponse.json({ error: "客诉已关闭" }, { status: 400 });
    if (msg === "INVALID_STATUS") return NextResponse.json({ error: "当前状态不可关闭" }, { status: 400 });
    return NextResponse.json({ error: "关闭客诉失败" }, { status: 500 });
  }
}

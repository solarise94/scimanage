import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertCrmProfileAccess } from "@/lib/crm/permissions";
import { convertInsightToManual } from "@/lib/crm/preferences";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ preferenceId: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { preferenceId } = await params;

  const existing = await prisma.crmCustomerPreference.findUnique({
    where: { id: preferenceId },
    select: { id: true, profileId: true, sourceType: true },
  });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    await assertCrmProfileAccess(existing.profileId, session.user.id, session.user.role);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "";
    if (msg === "NOT_FOUND") return NextResponse.json({ error: "Profile not found" }, { status: 404 });
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const preference = await convertInsightToManual({
      preferenceId,
      actorUserId: session.user.id,
    });
    return NextResponse.json({ preference }, { status: 201 });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "";
    if (msg === "NOT_FOUND") return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (msg === "FORBIDDEN") return NextResponse.json({ error: "仅自动洞察可转换为人工偏好" }, { status: 403 });
    if (msg === "ALREADY_CONVERTED") return NextResponse.json({ error: "该洞察已转换或已下线，不可重复转换" }, { status: 409 });
    return NextResponse.json({ error: "转换失败" }, { status: 500 });
  }
}

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { scanDormantCrmProfiles } from "@/lib/crm/lifecycle";

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const dormantDays = typeof body?.dormantDays === "number" ? body.dormantDays : undefined;
  const warningDays = typeof body?.warningDays === "number" ? body.warningDays : undefined;
  const dryRun = body?.dryRun === true;

  const result = await scanDormantCrmProfiles({
    dormantDays,
    warningDays,
    dryRun,
    actorUserId: session.user.id,
  });

  return NextResponse.json(result);
}

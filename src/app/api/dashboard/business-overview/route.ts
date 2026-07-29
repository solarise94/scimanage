import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { getDashboardBusinessOverview } from "@/lib/dashboard/business-overview";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const overview = await getDashboardBusinessOverview(
    session.user.id,
    session.user.role,
    session.user.department,
  );
  return NextResponse.json(overview);
}

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { scanOrgTextDriftCandidates } from "@/lib/governance/org-text-mismatch-scan";
import { upsertOrgTextDriftTasks } from "@/lib/governance/org-text-drift-task";

export async function POST() {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { role: true },
  });
  if (!user || user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const records = await scanOrgTextDriftCandidates();
  const result = await upsertOrgTextDriftTasks(records, session.user.id);
  const totalPending = await prisma.customerOrgTextDriftTask.count({
    where: { status: "PENDING" },
  });

  return NextResponse.json({ ...result, totalPending });
}

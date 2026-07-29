import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getRegionalManagerUserIds } from "@/lib/crm/permissions";
import { resolveRepresentativeForOwnerUserId } from "@/lib/crm/customer-owner-representative";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (session.user.role === "REPRESENTATIVE") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // REGIONAL_MANAGER: only self + managed reps; ADMIN: all reps
  let allowedRepEmails: Set<string> | null = null;
  if (session.user.role === "REGIONAL_MANAGER") {
    const managedIds = await getRegionalManagerUserIds(session.user.id);
    if (managedIds && managedIds.length > 0) {
      const managedUsers = await prisma.user.findMany({
        where: { id: { in: managedIds } },
        select: { email: true },
      });
      allowedRepEmails = new Set(managedUsers.map((u) => u.email));
    } else {
      allowedRepEmails = new Set();
    }
  }

  const reps = await prisma.representative.findMany({
    where: { archived: false },
    select: { id: true, name: true, email: true },
  });

  const repEmails = reps.map((r) => r.email);
  const repUsers = await prisma.user.findMany({
    where: { email: { in: repEmails } },
    select: { id: true, name: true, email: true },
  });

  const emailToUser = new Map(repUsers.map((u) => [u.email, u]));

  const assignees: Array<{
    userId: string;
    name: string;
    email: string;
    kind: "self" | "representative";
    representativeId?: string;
  }> = [];

  const ownResolved = await resolveRepresentativeForOwnerUserId(session.user.id);
  if (ownResolved.representativeId) {
    assignees.push({
      userId: session.user.id,
      name: session.user.name || "我",
      email: session.user.email || "",
      kind: "self",
      representativeId: ownResolved.representativeId,
    });
  }

  for (const rep of reps) {
    const user = emailToUser.get(rep.email);
    if (!user) continue;
    if (user.id === session.user.id) continue;
    // REGIONAL_MANAGER: only show managed reps
    if (allowedRepEmails && !allowedRepEmails.has(rep.email)) continue;
    assignees.push({
      userId: user.id,
      name: rep.name,
      email: rep.email,
      kind: "representative",
      representativeId: rep.id,
    });
  }

  return NextResponse.json({ assignees });
}

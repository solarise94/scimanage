import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getReadableProjectIds } from "@/lib/permissions";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const isAdmin = session.user.role === "ADMIN";

  let projectIds: string[] | null = null; // null = no filter (admin)
  if (!isAdmin) {
    projectIds = (await getReadableProjectIds(session.user.id, session.user.role)) ?? [];
    if (projectIds.length === 0) return NextResponse.json({ representatives: [], customers: [] });
  }

  const where: Record<string, unknown> = { deleted: false };
  if (projectIds) {
    where.id = { in: projectIds };
  }

  // Fetch all projects in scope — no archive/status/date/search filtering
  const projects = await prisma.project.findMany({
    where,
    select: {
      representative: true,
      client: true,
      rep: {
        select: { id: true, name: true },
      },
      profile: {
        select: { id: true, name: true },
      },
    },
  });

  // Build distinct rep list: registered reps by id, plus legacy text-only reps
  const repMap = new Map<string, { id: string; name: string }>();
  for (const p of projects) {
    if (p.rep) {
      repMap.set(p.rep.id, { id: p.rep.id, name: p.rep.name });
    } else if (p.representative) {
      const key = `_text:${p.representative}`;
      if (!repMap.has(key)) {
        repMap.set(key, { id: key, name: p.representative });
      }
    }
  }

  // Build distinct customer list: registered profiles by id, plus legacy text-only clients
  const custMap = new Map<string, { id: string; name: string }>();
  for (const p of projects) {
    if (p.profile) {
      custMap.set(p.profile.id, { id: p.profile.id, name: p.profile.name ?? "未命名客户" });
    } else if (p.client) {
      const key = `_text:${p.client}`;
      if (!custMap.has(key)) {
        custMap.set(key, { id: key, name: p.client });
      }
    }
  }

  return NextResponse.json({
    representatives: Array.from(repMap.values()),
    customers: Array.from(custMap.values()),
  });
}

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

/** GET /api/customer-merges/logs — list merge logs for history tab */
export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const currentUser = await prisma.user.findUnique({ where: { id: session.user.id }, select: { role: true } });
  if (!currentUser || currentUser.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { searchParams } = req.nextUrl;
  const page = Math.max(1, parseInt(searchParams.get("page") || "1") || 1);
  const pageSize = Math.min(100, Math.max(10, parseInt(searchParams.get("pageSize") || "20") || 20));

  const profileSelect = {
    id: true,
    name: true,
    customerCode: true,
  } as const;

  const [logs, total] = await Promise.all([
    prisma.customerMergeLog.findMany({
      include: {
        sourceProfile: { select: profileSelect },
        targetProfile: { select: profileSelect },
        operator: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.customerMergeLog.count(),
  ]);

  return NextResponse.json({
    logs: logs.map((log) => {
      const sourceName = log.sourceProfile?.name ?? null;
      const sourceCode = log.sourceProfile?.customerCode ?? null;
      const targetName = log.targetProfile?.name ?? null;
      const targetCode = log.targetProfile?.customerCode ?? null;
      return {
        ...log,
        sourceProfile: log.sourceProfile
          ? { id: log.sourceProfile.id, name: sourceName, customerCode: sourceCode }
          : { id: log.sourceProfileId, name: sourceName, customerCode: sourceCode },
        targetProfile: log.targetProfile
          ? { id: log.targetProfile.id, name: targetName, customerCode: targetCode }
          : { id: log.targetProfileId, name: targetName, customerCode: targetCode },
      };
    }),
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  });
}

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

const PAGE_SIZE = 20;
const VALID_KINDS = [
  "TEXT_DRIFT",
  "SITE_OR_ROOM_IN_ORG_TEXT",
  "INVALID_SITE",
];

export async function GET(req: NextRequest) {
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

  const { searchParams } = req.nextUrl;
  const status = searchParams.get("status") || "PENDING";
  const mismatchKind = searchParams.get("mismatchKind");
  const search = searchParams.get("search")?.trim() || "";
  const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10));
  const pageSize = Math.min(100, Math.max(1, parseInt(searchParams.get("pageSize") || String(PAGE_SIZE), 10)));

  const where: Record<string, unknown> = { status };
  if (mismatchKind && VALID_KINDS.includes(mismatchKind)) {
    where.mismatchKind = mismatchKind;
  }
  if (search) {
    where.OR = [
      { customerNameSnapshot: { contains: search } },
      { customerCodeSnapshot: { contains: search } },
      { organizationTextSnapshot: { contains: search } },
      { boundOrgNameSnapshot: { contains: search } },
      { boundOrgCodeSnapshot: { contains: search } },
    ];
  }

  const [tasks, total] = await Promise.all([
    prisma.customerOrgTextDriftTask.findMany({
      where,
      include: {
        profile: {
          select: {
            org: { select: { id: true, canonicalName: true, orgCode: true } },
            orgSite: { select: { id: true, siteName: true } },
          },
        },
      },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.customerOrgTextDriftTask.count({ where }),
  ]);

  const totalPages = Math.ceil(total / pageSize);

  return NextResponse.json({
    tasks,
    total,
    page,
    pageSize,
    totalPages,
  });
}

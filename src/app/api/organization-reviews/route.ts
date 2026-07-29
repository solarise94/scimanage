import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = await prisma.user.findUnique({ where: { id: session.user.id }, select: { role: true } });
  if (!user || user.role !== "ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  // Idempotent cleanup: cancel orphaned PENDING tasks from the old auto-review flow.
  // Customer create/edit no longer creates review tasks, so any remaining PENDING ones are stale.
  // Narrow condition + updateMany is cheap and idempotent; safe to run on every request.
  await prisma.organizationReviewTask.updateMany({
    where: {
      status: "PENDING",
      sourceType: { in: ["CUSTOMER_CREATE", "CUSTOMER_EDIT"] },
    },
    data: {
      status: "CANCELLED",
      reviewNote: "自动关闭：客户保存不再自动创建复核任务",
    },
  });

  const { searchParams } = new URL(req.url);
  const status = searchParams.get("status") || "PENDING";
  const sourceType = searchParams.get("sourceType") || "";
  const search = searchParams.get("search") || "";

  const where: Record<string, unknown> = {};
  if (status) where.status = status;
  if (sourceType) where.sourceType = sourceType;
  if (search) {
    where.OR = [
      { rawInput: { contains: search } },
      { suggestedCanonicalName: { contains: search } },
    ];
  }

  const tasks = await prisma.organizationReviewTask.findMany({
    where,
    include: {
      suggestedOrg: { select: { id: true, canonicalName: true, orgCode: true } },
      suggestedSite: { select: { id: true, siteName: true } },
      createdByUser: { select: { id: true, name: true } },
      reviewedByUser: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  return NextResponse.json({ tasks });
}

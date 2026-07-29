import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { normalizeOrgName } from "@/lib/organization-normalize";
import { resolveOrganization } from "@/lib/organization-resolver";

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const user = await prisma.user.findUnique({ where: { id: session.user.id }, select: { role: true } });
  if (!user || user.role === "REPRESENTATIVE") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json();
  const query = (body.query || "").trim();
  if (!query) {
    return NextResponse.json({ error: "查询内容不能为空" }, { status: 400 });
  }

  const normalized = normalizeOrgName(query);

  const resolved = await resolveOrganization(query);
  if (resolved.status === "exact") {
    return NextResponse.json({
      kind: "existing",
      organization: {
        id: resolved.organizationId,
        canonicalName: resolved.canonicalName,
        siteName: resolved.siteName,
        address: resolved.address,
      },
    });
  }

  // Check for existing PENDING task with same normalized input
  const existing = await prisma.organizationReviewTask.findFirst({
    where: {
      normalizedInput: normalized,
      sourceType: "ORG_CREATE_REQUEST",
      status: "PENDING",
    },
  });
  if (existing) {
    return NextResponse.json({ kind: "pending_exists", taskId: existing.id });
  }

  try {
    const task = await prisma.organizationReviewTask.create({
      data: {
        rawInput: query,
        normalizedInput: normalized,
        sourceType: "ORG_CREATE_REQUEST",
        sourceId: session.user.id,
        createdById: session.user.id,
        status: "PENDING",
      },
    });

    return NextResponse.json({
      kind: "review_created",
      taskId: task.id,
    });
  } catch (err) {
    console.error("Intake create error:", err);
    const message = err instanceof Error ? err.message : "建档申请失败";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

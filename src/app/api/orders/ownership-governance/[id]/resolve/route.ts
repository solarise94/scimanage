/**
 * Phase E: resolve a governance task (ADMIN manual assign).
 *
 * POST /api/orders/ownership-governance/[id]/resolve
 *   body: { targetUserId }
 *
 * Assigns technicalOwnerUserId to the resource; for Project also ensures
 * ProjectMember (MEMBER, not OWNER). Marks task RESOLVED_MANUAL.
 *
 * ADMIN-only.
 */
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assignTechnicalOwnerManual } from "@/lib/orders/application/technical-owner-governance";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id: taskId } = await params;
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Request body must be an object" }, { status: 400 });
  }
  const targetUserId = typeof body.targetUserId === "string" ? body.targetUserId.trim() : "";
  if (!targetUserId) {
    return NextResponse.json({ error: "targetUserId is required" }, { status: 400 });
  }

  const task = await prisma.technicalOwnerGovernanceTask.findUnique({
    where: { id: taskId },
    select: { resourceType: true, resourceId: true, status: true },
  });
  if (!task) {
    return NextResponse.json({ error: "Governance task not found" }, { status: 404 });
  }
  if (task.status !== "PENDING") {
    return NextResponse.json({ error: `Task already ${task.status}` }, { status: 409 });
  }

  await assignTechnicalOwnerManual({
    actorUserId: session.user.id,
    resourceType: task.resourceType as "ORDER" | "PROJECT",
    resourceId: task.resourceId,
    targetUserId,
  });

  return NextResponse.json({ ok: true, taskId });
}

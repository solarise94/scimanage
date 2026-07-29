/**
 * POST /api/project-governance/assignments/[id]/resolve  解决治理 assignment（绑定真实项目）
 *   body: { resolvedProjectId, note? }
 */
import { NextRequest, NextResponse } from "next/server";
import { requireActorFromSession, mapDomainErrorToHttp } from "@/lib/application/http-error-mapping";
import { resolveGovernanceAssignmentForActor } from "@/lib/projects/application/governance-bucket";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireActorFromSession();
  if (!auth.ok) return auth.response;
  const { id } = await params;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const resolvedProjectId = String(body.resolvedProjectId ?? "");
  if (!resolvedProjectId) {
    return NextResponse.json({ error: "resolvedProjectId 必填" }, { status: 400 });
  }
  try {
    const result = await resolveGovernanceAssignmentForActor(
      auth.actor,
      id,
      resolvedProjectId,
      typeof body.note === "string" ? body.note : null,
    );
    return NextResponse.json({ assignment: result });
  } catch (err) {
    return mapDomainErrorToHttp(err, "Failed to resolve governance assignment");
  }
}

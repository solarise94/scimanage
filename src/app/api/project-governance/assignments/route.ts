/**
 * GET  /api/project-governance/assignments           治理 assignment 列表
 * POST /api/project-governance/assignments           创建治理 assignment
 *   body: { governanceProjectId?, legacyProjectId?, orderId?, sourceRecordId?, reasonCode, note? }
 */
import { NextRequest, NextResponse } from "next/server";
import { requireActorFromSession, mapDomainErrorToHttp } from "@/lib/application/http-error-mapping";
import { listGovernanceAssignmentsForActor } from "@/lib/projects/application/governance-query";
import { createGovernanceAssignmentForActor } from "@/lib/projects/application/governance-bucket";

export async function GET(req: NextRequest) {
  const auth = await requireActorFromSession();
  if (!auth.ok) return auth.response;
  const status = req.nextUrl.searchParams.get("status") || undefined;
  const reasonCode = req.nextUrl.searchParams.get("reasonCode") || undefined;
  try {
    const items = await listGovernanceAssignmentsForActor(auth.actor, { status, reasonCode });
    return NextResponse.json({ items });
  } catch (err) {
    return mapDomainErrorToHttp(err, "Failed to list governance assignments");
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireActorFromSession();
  if (!auth.ok) return auth.response;
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  try {
    const result = await createGovernanceAssignmentForActor(auth.actor, {
      governanceProjectId: typeof body.governanceProjectId === "string" ? body.governanceProjectId : undefined,
      legacyProjectId: typeof body.legacyProjectId === "string" ? body.legacyProjectId : null,
      orderId: typeof body.orderId === "string" ? body.orderId : null,
      sourceRecordId: typeof body.sourceRecordId === "string" ? body.sourceRecordId : null,
      reasonCode: String(body.reasonCode ?? ""),
      note: typeof body.note === "string" ? body.note : null,
    });
    return NextResponse.json({ assignment: result }, { status: 201 });
  } catch (err) {
    return mapDomainErrorToHttp(err, "Failed to create governance assignment");
  }
}

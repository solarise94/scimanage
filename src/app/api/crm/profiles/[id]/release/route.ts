import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  mapApplicationError,
  requireCrmActor,
  unauthorizedResponse,
} from "@/lib/crm/route-helpers";
import { resolveCrmProfileAccess } from "@/lib/crm/profile-access";
import { releaseProfileToPool, type PoolEntryReason } from "@/lib/crm/profile-department-service";
import type { BusinessActor } from "@/lib/application/actor";

type Body = {
  /** RELEASED（默认）| OWNER_UNAVAILABLE（负责人不可用强制解除）。 */
  reason?: PoolEntryReason | null;
  /** 仅 ADMIN 可为其他部门操作。 */
  targetDepartment?: string | null;
};

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session) return unauthorizedResponse();

  const { id: profileId } = await params;

  let actor: BusinessActor;
  try {
    actor = requireCrmActor(session);
  } catch (err) {
    return mapApplicationError(err);
  }

  // §8.5：释放是 CLAIMED/RECALL_CANDIDATE state 写操作，POOL/NONE 统一 404。
  const access = await resolveCrmProfileAccess({ profileId, actor });
  if (access === "NONE") {
    return NextResponse.json({ error: "Profile not found" }, { status: 404 });
  }

  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    // 允许空 body（默认 reason = RELEASED）
  }

  try {
    const result = await releaseProfileToPool({
      actor,
      profileId,
      reason: body.reason,
      targetDepartment: body.targetDepartment,
    });
    return NextResponse.json({
      profileId: result.profileId,
      department: result.department,
      poolEntryReason: result.poolEntryReason,
      releasedAt: result.releasedAt.toISOString(),
    });
  } catch (err) {
    return mapApplicationError(err);
  }
}

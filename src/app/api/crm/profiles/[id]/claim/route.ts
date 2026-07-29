import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  mapApplicationError,
  requireCrmActor,
  unauthorizedResponse,
} from "@/lib/crm/route-helpers";
import { resolveCrmProfileAccess } from "@/lib/crm/profile-access";
import { claimProfileForDepartment } from "@/lib/crm/profile-department-service";
import type { BusinessActor } from "@/lib/application/actor";

type Body = {
  ownerUserId?: string | null;
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

  // §8.3：路由先经 access resolver——隐藏 POOL/NONE 统一 404。
  // 认领要求可见 POOL；FULL（已 CLAIMED）走认领会由 service 抛 409。
  const access = await resolveCrmProfileAccess({ profileId, actor });
  if (access === "NONE") {
    return NextResponse.json({ error: "Profile not found" }, { status: 404 });
  }

  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    // 允许空 body（默认 ownerUserId = actor）
  }

  // 非 ADMIN 默认认领给自己；ADMIN 可显式指定 ownerUserId / targetDepartment。
  const ownerUserId = body.ownerUserId ?? actor.userId;

  try {
    const result = await claimProfileForDepartment({
      actor,
      profileId,
      ownerUserId,
      targetDepartment: body.targetDepartment,
    });
    return NextResponse.json(
      {
        profileId: result.profileId,
        department: result.department,
        ownerUserId: result.ownerUserId,
        claimedAt: result.claimedAt.toISOString(),
      },
      { status: 201 },
    );
  } catch (err) {
    return mapApplicationError(err);
  }
}

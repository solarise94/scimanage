import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  mapApplicationError,
  requireCrmActor,
  unauthorizedResponse,
} from "@/lib/crm/route-helpers";
import { resolveCrmProfileAccess } from "@/lib/crm/profile-access";
import { transferProfileOwnership } from "@/lib/crm/profile-department-service";
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

  // §8.4：转派是 CLAIMED state 的写操作，POOL/NONE 统一 404。
  const access = await resolveCrmProfileAccess({ profileId, actor });
  if (access === "NONE") {
    return NextResponse.json({ error: "Profile not found" }, { status: 404 });
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "请求体必须是 JSON" }, { status: 400 });
  }

  if (!body.ownerUserId) {
    return NextResponse.json({ error: "ownerUserId 为必填" }, { status: 400 });
  }

  try {
    const result = await transferProfileOwnership({
      actor,
      profileId,
      ownerUserId: body.ownerUserId,
      targetDepartment: body.targetDepartment,
    });
    return NextResponse.json({
      profileId: result.profileId,
      department: result.department,
      fromOwnerUserId: result.fromOwnerUserId,
      toOwnerUserId: result.toOwnerUserId,
    });
  } catch (err) {
    return mapApplicationError(err);
  }
}

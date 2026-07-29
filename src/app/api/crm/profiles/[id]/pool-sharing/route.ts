import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  mapApplicationError,
  requireCrmActor,
  unauthorizedResponse,
} from "@/lib/crm/route-helpers";
import { resolveCrmProfileAccess } from "@/lib/crm/profile-access";
import { setProfilePoolShare } from "@/lib/crm/profile-pool-share";
import type { BusinessActor } from "@/lib/application/actor";

type Body = {
  targetDepartment?: string | null;
  shared?: boolean;
  sourceDepartment?: string | null;
};

export async function PUT(
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

  // §6.6 / §8.2：隐藏 POOL/NONE 统一 404（防存在性泄露）。
  // 共享授权属于来源部门 state 写操作，POOL 视图不允许；这里 NONE 与 POOL 都拒绝。
  const access = await resolveCrmProfileAccess({ profileId, actor });
  if (access === "NONE") {
    return NextResponse.json({ error: "Profile not found" }, { status: 404 });
  }
  // 共享/撤回只改变 CrmProfilePoolShare，来源部门 state 必须可管理；
  // POOL 视图调用方不持有来源部门 state，统一 403（不泄露具体状态）。
  if (access === "POOL") {
    return NextResponse.json(
      { error: "公海视图不能管理公海共享授权" },
      { status: 403 },
    );
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "请求体必须是 JSON" }, { status: 400 });
  }

  const shared = body.shared;
  if (typeof shared !== "boolean") {
    return NextResponse.json({ error: "shared 必须是布尔值" }, { status: 400 });
  }
  if (!body.targetDepartment) {
    return NextResponse.json({ error: "targetDepartment 为必填" }, { status: 400 });
  }

  try {
    const result = await setProfilePoolShare({
      actor,
      profileId,
      sourceDepartment: body.sourceDepartment,
      targetDepartment: body.targetDepartment,
      shared,
    });
    // §8.2：响应只含授权记录自身 status/sharedAt/revokedAt，
    // 不返回目标部门是否已认领、owner 或业务数量。
    return NextResponse.json({
      status: result.status,
      sharedAt: result.sharedAt?.toISOString() ?? null,
      revokedAt: result.revokedAt?.toISOString() ?? null,
    });
  } catch (err) {
    return mapApplicationError(err);
  }
}

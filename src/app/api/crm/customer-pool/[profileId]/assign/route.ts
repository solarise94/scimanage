import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sendMail } from "@/lib/mail";
import { ensureSalesUserForRepresentative } from "@/lib/representative-user";
import { getAppUrl } from "@/lib/app-url";
import {
  mapApplicationError,
  requireCrmActor,
  unauthorizedResponse,
} from "@/lib/crm/route-helpers";
import { resolveCrmProfileAccess } from "@/lib/crm/profile-access";
import {
  claimProfileForDepartment,
  transferProfileOwnership,
} from "@/lib/crm/profile-department-service";
import { ApplicationError, ConflictError } from "@/lib/application/errors";
import type { BusinessActor } from "@/lib/application/actor";

/**
 * §8.7 旧 customer-pool assign → FIELD_SALES 兼容 adapter。
 *
 * 语义映射（§8.7 状态机表）：
 *   - 公海（POOL，本部门或共享）→ claimProfileForDepartment（FIELD_SALES state
 *     POOL→CLAIMED，旧 assignmentStatus 投影 ASSIGNED 由 service 同事务双写）。
 *   - 已分配（CLAIMED）转派给新代表 → transferProfileOwnership。
 *
 * 权限、状态机、审计与事务全部来自 canonical service；本 adapter 只做：
 *   1) representativeId → User 解析（ensureSalesUserForRepresentative）；
 *   2) 旧前端契约返回结构（{ profile: {...} }）；
 *   3) 通知副作用（不阻塞响应）。
 * 不再直接写 CrmCustomerProfile owner/assignmentStatus。
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ profileId: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session) return unauthorizedResponse();
  if (session.user.role !== "ADMIN" && session.user.role !== "USER") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { profileId } = await params;
  const body = await req.json().catch(() => ({}));
  const { representativeId } = body;
  if (!representativeId) {
    return NextResponse.json({ error: "representativeId is required" }, { status: 400 });
  }

  const rep = await prisma.representative.findUnique({ where: { id: representativeId } });
  if (!rep || rep.archived) {
    return NextResponse.json({ error: "代表未找到或已归档" }, { status: 400 });
  }

  // 代表 → User（必要时创建，保持旧 ensureSalesUserForRepresentative 语义）。
  let targetUserId: string;
  try {
    ({ userId: targetUserId } = await ensureSalesUserForRepresentative(rep));
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "代表账号同步失败" },
      { status: 409 },
    );
  }
  const targetUserEmail = rep.email;

  let actor: BusinessActor;
  try {
    actor = requireCrmActor(session);
  } catch (err) {
    return mapApplicationError(err);
  }

  // 旧前端契约：池客户列表只展示 FIELD_SALES 公海，故此 adapter 固定走 FIELD_SALES 语义。
  // 注意：ADMIN 的 resolveCrmProfileAccess 恒为 FULL，不能用来区分 POOL/CLAIMED；
  // 这里直接查 FIELD_SALES department state 决定走 claim 还是 transfer。
  const access = await resolveCrmProfileAccess({ profileId, actor });
  if (access === "NONE") {
    return NextResponse.json({ error: "Profile not found" }, { status: 404 });
  }
  const fsState = await prisma.crmProfileDepartmentState.findUnique({
    where: { profileId_department: { profileId, department: "FIELD_SALES" } },
    select: { claimStatus: true },
  });
  const isPool = fsState?.claimStatus === "POOL";

  try {
    let updatedProfileId = profileId;
    if (isPool) {
      // 公海认领（FIELD_SALES state POOL→CLAIMED，service 同事务双写旧字段）。
      await claimProfileForDepartment({
        actor,
        profileId,
        ownerUserId: targetUserId,
      });
    } else {
      // access === "FULL"：已 CLAIMED，按转派处理。
      await transferProfileOwnership({
        actor,
        profileId,
        ownerUserId: targetUserId,
      });
    }

    // 旧契约返回结构：包含 ownerUser 投影。重新读取以反映 service 写入后的状态。
    const result = await prisma.crmCustomerProfile.findUnique({
      where: { id: profileId },
      include: { ownerUser: { select: { id: true, name: true } } },
    });
    updatedProfileId = result?.id ?? profileId;

    // 通知副作用（fire-and-forget，与旧 route 一致，不在事务内）。
    const profileRow = await prisma.crmCustomerProfile.findUnique({
      where: { id: updatedProfileId },
      select: { name: true },
    });
    const customerName = profileRow?.name || "未命名客户";
    prisma.notification
      .create({
        data: {
          userId: targetUserId,
          title: "有新的客户线索待查看",
          content: `客户 ${customerName} 已分配给您`,
          type: "CRM_ASSIGNMENT",
          link: `/crm/customers/${updatedProfileId}`,
        },
      })
      .catch(() => undefined);

    const loginUrl = getAppUrl("/login");
    sendMail({
      to: targetUserEmail,
      subject: "【SciManage】有新的客户线索待查看",
      text: `您好，\n\n有新的客户线索已分配给您，请登录系统查看。\n\n${loginUrl}`,
      html: `<p>您好，</p><p>有新的客户线索已分配给您，请登录系统查看。</p><p><a href="${loginUrl}">登录 SciManage</a></p>`,
    }).catch((err) => console.error("Failed to send assignment email:", err));

    return NextResponse.json({ profile: result });
  } catch (err) {
    if (err instanceof ApplicationError) {
      // 409 映射保持旧契约（assign 冲突多为 409）。
      if (err instanceof ConflictError) {
        return NextResponse.json({ error: err.message, code: err.code }, { status: 409 });
      }
      return NextResponse.json({ error: err.message }, { status: err.httpStatus });
    }
    throw err;
  }
}

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { clearProfileAssignmentOnRecall } from "@/lib/crm/customer-representative-sync";
import { retireManagingTag } from "@/lib/crm/customer-rep-tag-helpers";
import {
  mapApplicationError,
  requireCrmActor,
  unauthorizedResponse,
} from "@/lib/crm/route-helpers";
import { resolveCrmProfileAccess } from "@/lib/crm/profile-access";
import { releaseProfileToPool } from "@/lib/crm/profile-department-service";
import { ApplicationError } from "@/lib/application/errors";
import type { BusinessActor } from "@/lib/application/actor";

/**
 * §8.7 旧 customer-pool recall → FIELD_SALES 兼容 adapter。
 *
 * 语义映射（§8.7 状态机表）：
 *   - CLAIMED/RECALL_CANDIDATE → releaseProfileToPool(reason=RELEASED)
 *     （FIELD_SALES state → POOL + poolEntryReason=RELEASED，
 *      旧 assignmentStatus 投影 RECALLED 由 service 同事务双写）。
 *
 * 权限、状态机、审计与事务来自 canonical service；本 adapter 只做：
 *   1) 旧 recall 的 MANAGING tag retire + 代表缓存清理副作用（这些不属于部门
 *      state 写入，仍在本 adapter 事务内完成，保持旧语义）；
 *   2) 通知副作用（fire-and-forget）；
 *   3) 旧前端契约返回结构。
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
  const { reason } = body;

  let actor: BusinessActor;
  try {
    actor = requireCrmActor(session);
  } catch (err) {
    return mapApplicationError(err);
  }

  const access = await resolveCrmProfileAccess({ profileId, actor });
  if (access === "NONE") {
    return NextResponse.json({ error: "Profile not found" }, { status: 404 });
  }
  // 只能收回已分配（FULL）的客户；公海客户（POOL）不可再收回。
  if (access === "POOL") {
    return NextResponse.json({ error: "只能收回已分配的客户" }, { status: 400 });
  }

  // 旧 recall 按 active MANAGING tag 反查通知对象（决策 C，不走 effective resolver）。
  const activeManagingTags = await prisma.customerRepTag.findMany({
    where: { profileId, tagType: "MANAGING", isActive: true },
    select: { representativeId: true },
  });
  const repIdsToRetire = [...new Set(activeManagingTags.map((t) => t.representativeId))];

  const repsToNotify =
    repIdsToRetire.length > 0
      ? await prisma.representative.findMany({
          where: { id: { in: repIdsToRetire }, archived: false, kind: "HUMAN" },
          select: { id: true, email: true },
        })
      : [];
  const notifyUsers =
    repsToNotify.length > 0
      ? await prisma.user.findMany({
          where: {
            email: { in: repsToNotify.map((r) => r.email).filter(Boolean) },
            role: { in: ["REPRESENTATIVE", "REGIONAL_MANAGER"] },
          },
          select: { id: true },
        })
      : [];
  const notifyUserIds = notifyUsers.map((u) => u.id);

  try {
    // canonical service：FIELD_SALES CLAIMED/RECALL_CANDIDATE → POOL + RELEASED。
    await releaseProfileToPool({ actor, profileId, reason: "RELEASED" });

    // 旧 recall 副作用：retire active MANAGING tag + 清理代表缓存。
    // 这些是 FIELD_SALES 旧可见性链路的清理，与部门 state 写入正交；
    // 放在 service 事务外的本 adapter 事务内完成，保持旧语义。
    await prisma.$transaction(async (tx) => {
      const now = new Date();
      for (const repId of repIdsToRetire) {
        await retireManagingTag(tx, {
          profileId,
          representativeId: repId,
          now,
          actingUserId: session.user.id,
          note: reason ? `收回：${reason}` : "收回：管理关系转为跟进历史",
        });
      }
      await clearProfileAssignmentOnRecall(profileId, tx);
    });

    const result = await prisma.crmCustomerProfile.findUnique({
      where: { id: profileId },
      include: { ownerUser: { select: { id: true, name: true } } },
    });

    // 通知副作用（fire-and-forget）。
    const customerName = result?.name || "未命名客户";
    for (const notifyUserId of notifyUserIds) {
      if (notifyUserId === session.user.id) continue;
      prisma.notification
        .create({
          data: {
            userId: notifyUserId,
            title: "客户已收回",
            content: `客户 ${customerName} 已被收回到客户池`,
            type: "CRM_CUSTOMER_RECALLED",
            link: "/crm/organization-flow",
          },
        })
        .catch(() => undefined);
    }

    return NextResponse.json({ profile: result });
  } catch (err) {
    if (err instanceof ApplicationError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.httpStatus });
    }
    throw err;
  }
}

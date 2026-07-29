import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { syncEffectiveRepresentativeLinksForOrganization } from "@/lib/crm/customer-representative-sync";
import { retireManagingTag } from "@/lib/crm/customer-rep-tag-helpers";
import { checkRepresentativeEmailClaimConflict } from "@/lib/validation";
import { releaseProfileToPool } from "@/lib/crm/profile-department-service";

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function assertAdmin(session: { user?: { id?: string } } | null) {
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const currentUser = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { role: true },
  });
  if (currentUser?.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return null;
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getServerSession(authOptions);
  const forbidden = await assertAdmin(session);
  if (forbidden) return forbidden;

  const { id } = await params;

  try {
    const body = await req.json();
    const { name, email, archived, regionIds } = body;

    const existing = await prisma.representative.findUnique({ where: { id } });
    if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

    // Validate regionIds if provided — must be a string array, all must exist and not be archived
    if (regionIds !== undefined) {
      if (!Array.isArray(regionIds) || regionIds.some((id: unknown) => typeof id !== "string" || !id.trim())) {
        return NextResponse.json({ error: "regionIds 必须是字符串数组" }, { status: 400 });
      }
      const deduped: string[] = [...new Set(regionIds as string[])];
      if (deduped.length > 0) {
        const validRegions = await prisma.representativeRegion.findMany({
          where: { id: { in: deduped }, archived: false },
          select: { id: true },
        });
        if (validRegions.length !== deduped.length) {
          return NextResponse.json({ error: "地区不存在或已归档" }, { status: 400 });
        }
      }
    }

    const requestedEmail =
      email !== undefined ? email.trim().toLowerCase() : undefined;
    const requestedName = name !== undefined ? name.trim() : undefined;

    // Fast pre-check when the request intends to change email (authoritative re-check is in-tx)
    if (requestedEmail !== undefined && requestedEmail !== existing.email) {
      const preConflict = await checkRepresentativeEmailClaimConflict(requestedEmail, {
        excludeRepId: id,
        allowExistingSalesUser: false,
      });
      if (preConflict.conflict) {
        return NextResponse.json({ error: preConflict.error }, { status: preConflict.status });
      }
    }

    // §4.4 预处理：若本次 PATCH 是归档过渡（archived true 且当前未归档），
    // 先经 canonical service 把该代表名下 FIELD_SALES CLAIMED 的客户释放至
    // POOL + OWNER_UNAVAILABLE。release 在主 archive 事务外执行（service 开
    // 自己的事务）；release 只依赖 department state + owner，与 org binding
    // 解绑、tag 转换正交。actor 为当前 ADMIN（archive 仅 ADMIN 可操作）。
    let releasedProfileCount = 0;
    const isPreArchiveTransition = archived === true && !existing.archived;
    if (isPreArchiveTransition) {
      const linkedUserPre = await prisma.user.findUnique({
        where: { email: existing.email },
        select: { id: true, department: true },
      });
      if (linkedUserPre) {
        const claimedStates = await prisma.crmProfileDepartmentState.findMany({
          where: {
            ownerUserId: linkedUserPre.id,
            claimStatus: "CLAIMED",
            department: "FIELD_SALES",
          },
          select: { profileId: true },
        });
        const adminActor = {
          userId: session!.user!.id,
          role: "ADMIN",
          department: linkedUserPre.department ?? undefined,
        };
        for (const s of claimedStates) {
          try {
            await releaseProfileToPool({
              actor: adminActor,
              profileId: s.profileId,
              reason: "OWNER_UNAVAILABLE",
            });
            releasedProfileCount += 1;
          } catch (err) {
            // 并发或状态已变化时跳过单条，不阻断代表归档主流程；
            // 失败明细由 release service 自身的审计/日志覆盖。
            console.error(
              `[representatives][archive] release profile ${s.profileId} failed:`,
              err,
            );
          }
        }
      }
    }

    const result = await prisma.$transaction(async (tx) => {
      // Re-read inside the transaction so concurrent email moves stay consistent
      const current = await tx.representative.findUnique({ where: { id } });
      if (!current) {
        throw new HttpError(404, "Not found");
      }

      const targetEmail = requestedEmail ?? current.email;
      const targetName = requestedName ?? current.name;
      const emailChanging = targetEmail !== current.email;

      if (emailChanging) {
        const conflict = await checkRepresentativeEmailClaimConflict(
          targetEmail,
          { excludeRepId: id, allowExistingSalesUser: false },
          tx,
        );
        if (conflict.conflict) {
          throw new HttpError(conflict.status, conflict.error);
        }
      }

      const repData: Record<string, unknown> = {};
      if (name !== undefined) repData.name = targetName;
      if (email !== undefined) repData.email = targetEmail;
      if (archived !== undefined) {
        repData.archived = archived;
        repData.archivedAt = archived ? new Date() : null;
      }

      const updated = await tx.representative.update({
        where: { id },
        data: repData,
      });

      // Locate User by the in-tx current email (not a stale pre-tx snapshot)
      const linkedUser = await tx.user.findUnique({ where: { email: current.email } });
      if (linkedUser) {
        const userData: Record<string, unknown> = {};
        if (name !== undefined) userData.name = targetName;
        if (emailChanging) userData.email = targetEmail;
        if (Object.keys(userData).length > 0) {
          await tx.user.update({ where: { id: linkedUser.id }, data: userData });
        }
      }

      // Sync project representative text snapshots when name changes
      if (name !== undefined) {
        await tx.project.updateMany({
          where: { representativeId: id },
          data: { representative: targetName },
        });
      }

      // Region assignments: delete old + recreate new
      if (regionIds !== undefined) {
        await tx.representativeRegionAssignment.deleteMany({ where: { representativeId: id } });
        if (Array.isArray(regionIds) && regionIds.length > 0) {
          await tx.representativeRegionAssignment.createMany({
            data: regionIds.map((regionId: string) => ({
              representativeId: id,
              regionId,
            })),
          });
        }
      }

      // ── Task 2.6: departed-representative auto-derivation ──────────────────
      // On the archive TRANSITION (archived false→true), unwind this rep's
      // bindings/assignments so customers fall back to org bindings (or the pool).
      // archived:true→false (restore) does NOT reverse this — re-bind manually.
      const isArchiving = archived === true && !current.archived;
      if (isArchiving) {
        const now = new Date();
        const actingUserId = session!.user!.id;

        // (1) Collect this rep's ACTIVE bindings' orgIds, then archive the bindings.
        //     Must run BEFORE the resync so the resolver no longer sees them ACTIVE.
        const activeBindings = await tx.representativeOrganization.findMany({
          where: { representativeId: id, status: "ACTIVE" },
          select: { organizationId: true },
        });
        const affectedOrgIds = [
          ...new Set(activeBindings.map((b) => b.organizationId).filter((x): x is string => !!x)),
        ];
        await tx.representativeOrganization.updateMany({
          where: { representativeId: id, status: "ACTIVE" },
          data: { status: "ARCHIVED", isPrimary: false },
        });

        // (2) §4.4 生命周期语义改造：代表归档不再把 ownerUserId 下 ASSIGNED profile
        //     置 UNASSIGNED，而是经 FIELD_SALES state 写 POOL + OWNER_UNAVAILABLE。
        //     复用 releaseProfileToPool canonical service（权限/状态机/审计/旧字段
        //     兼容双写全部来自 service；不依赖 User relation 级联）。release 在本
        //     archive 事务外、绑定归档后执行——service 开自己的事务，release 只依赖
        //     department state + owner，与 org binding 解绑正交。
        //     unassignedCount 由 pre-tx 阶段填入（见 isArchiving 预处理）。

        // (3) MANAGING tags → historical FOLLOWED (endedAt=now); original MANAGING
        //     deactivated. Uses the shared retireManagingTag helper so any future
        //     change to the retirement semantics (e.g. an endedReason field) applies
        //     uniformly across assign / recall / archive / application-approval.
        const managingTags = await tx.customerRepTag.findMany({
          where: { representativeId: id, tagType: "MANAGING", isActive: true },
          select: { profileId: true },
        });
        for (const t of managingTags) {
          await retireManagingTag(tx, {
            profileId: t.profileId,
            representativeId: id,
            now,
            actingUserId,
            note: "代表归档：管理关系转为跟进历史",
          });
        }

        // (4) Recompute Project/Order rep snapshots for every affected org. Passing
        //     only organizationId (no siteId) covers all non-ASSIGNED customers under
        //     the org, including site-bound ones whose binding was just archived.
        for (const organizationId of affectedOrgIds) {
          await syncEffectiveRepresentativeLinksForOrganization({ organizationId, db: tx });
        }

        // (5) Audit summary.
        await tx.activityLog.create({
          data: {
            type: "REPRESENTATIVE_ARCHIVED",
            content: `代表「${updated.name}」已归档：解除 ${affectedOrgIds.length} 个机构绑定、释放 ${releasedProfileCount} 个客户至公海（OWNER_UNAVAILABLE）、转 ${managingTags.length} 个管理标签为跟进历史`,
            metadata: JSON.stringify({
              representativeId: id,
              affectedOrgIds,
              releasedProfileCount,
              managingConverted: managingTags.length,
            }),
            userId: actingUserId,
          },
        });
      }

      return updated;
    });
    return NextResponse.json({ representative: result });
  } catch (error) {
    if (error instanceof HttpError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error(error);
    return NextResponse.json({ error: "Failed to update representative" }, { status: 500 });
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  const forbidden = await assertAdmin(session);
  if (forbidden) return forbidden;

  const { id } = await params;

  try {
    const rep = await prisma.representative.findUnique({ where: { id } });
    if (!rep) return NextResponse.json({ error: "Not found" }, { status: 404 });

    return NextResponse.json(
      { error: "请使用归档功能代替删除" },
      { status: 400 }
    );
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: "Failed to delete representative" }, { status: 500 });
  }
}

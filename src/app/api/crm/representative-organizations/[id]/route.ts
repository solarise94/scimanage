import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { resolveBindingReviewers } from "@/lib/crm/supervisor";
import { syncEffectiveRepresentativeLinksForOrganization } from "@/lib/crm/customer-representative-sync";

function toSafeSyncError(err: unknown): string {
  console.error("[representative-organizations] sync failed", err);
  return "EFFECTIVE_LINKS_SYNC_FAILED";
}
import {
  findRepresentativeBindingByScope,
  validateRepresentativeBindingScope,
} from "@/lib/crm/representative-binding";

async function canReviewBinding(userId: string, role: string, representativeId: string): Promise<boolean> {
  if (role === "ADMIN") return true;
  const reviewers = await resolveBindingReviewers(representativeId);
  return reviewers.some((r) => r.id === userId);
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const body = await req.json();
  const { action, reviewNote, organizationSiteId } = body as {
    action: "approve" | "reject" | "archive" | "reactivate" | "set-primary" | "change-scope";
    reviewNote?: string;
    organizationSiteId?: string | null;
  };

  const binding = await prisma.representativeOrganization.findUnique({
    where: { id },
    include: { representative: { select: { id: true, email: true } } },
  });
  if (!binding) return NextResponse.json({ error: "绑定不存在" }, { status: 404 });

  if (!(await canReviewBinding(session.user.id, session.user.role, binding.representativeId))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (action === "approve") {
    let finalOrganizationId = binding.organizationId;
    let finalOrganizationSiteId = binding.organizationSiteId;

    // If organizationId is null (new-org request), it must be resolved first
    if (!binding.organizationId) {
      if (!binding.organizationReviewTaskId) {
        return NextResponse.json({ error: "该绑定缺少单位信息，无法审批" }, { status: 400 });
      }
      const task = await prisma.organizationReviewTask.findUnique({
        where: { id: binding.organizationReviewTaskId },
        select: { suggestedOrganizationId: true, suggestedSiteId: true, status: true },
      });
      if (task?.status !== "APPROVED" || !task.suggestedOrganizationId) {
        return NextResponse.json({ error: "单位审核任务尚未完成，请先通过单位主数据审核" }, { status: 400 });
      }
      finalOrganizationId = task.suggestedOrganizationId;
      finalOrganizationSiteId = task.suggestedSiteId || null;
    }

    if (!finalOrganizationId) {
      return NextResponse.json({ error: "绑定缺少单位信息，无法审批" }, { status: 400 });
    }

    const result = await prisma.$transaction(async (tx) => {
      const existingAtScope = await findRepresentativeBindingByScope(tx, {
        representativeId: binding.representativeId,
        organizationId: finalOrganizationId,
        organizationSiteId: finalOrganizationSiteId,
      });

      if (existingAtScope && existingAtScope.id !== binding.id) {
        const reused = await tx.representativeOrganization.update({
          where: { id: existingAtScope.id },
          data: {
            status: "ACTIVE",
            reviewedByUserId: session.user.id,
            reviewedAt: new Date(),
            reviewNote: reviewNote?.trim() || null,
          },
        });
        await tx.representativeOrganization.update({
          where: { id },
          data: {
            status: "ARCHIVED",
            isPrimary: false,
            reviewedByUserId: session.user.id,
            reviewedAt: new Date(),
            reviewNote: reviewNote?.trim() || "duplicate_binding_reused",
          },
        });
        return reused;
      }

      return tx.representativeOrganization.update({
        where: { id },
        data: {
          organizationId: finalOrganizationId,
          organizationSiteId: finalOrganizationSiteId,
          status: "ACTIVE",
          reviewedByUserId: session.user.id,
          reviewedAt: new Date(),
          reviewNote: reviewNote?.trim() || null,
        },
      });
    });

    let autoAssigned = 0;
    let syncError: string | null = null;
    if (finalOrganizationId) {
      try {
        autoAssigned = await syncEffectiveRepresentativeLinksForOrganization({
          organizationId: finalOrganizationId,
          organizationSiteId: finalOrganizationSiteId,
        });
      } catch (err) {
        syncError = toSafeSyncError(err);
      }
    }

    return NextResponse.json({
      binding: result,
      autoAssigned,
      syncOk: !syncError,
      ...(syncError ? { syncError } : {}),
    }, { status: syncError ? 207 : 200 });
  }

  if (action === "reject") {
    const updated = await prisma.representativeOrganization.update({
      where: { id },
      data: {
        status: "REJECTED",
        reviewedByUserId: session.user.id,
        reviewedAt: new Date(),
        reviewNote: reviewNote?.trim() || null,
      },
    });
    return NextResponse.json({ binding: updated });
  }

  if (action === "archive") {
    if (binding.status !== "ACTIVE") {
      return NextResponse.json({ error: "只能归档活跃状态的绑定" }, { status: 400 });
    }

    const updated = await prisma.representativeOrganization.update({
      where: { id },
      data: {
        status: "ARCHIVED",
        isPrimary: false,
        reviewNote: reviewNote?.trim() || null,
      },
    });

    // Sync affected customers: they may lose this fallback binding
    let autoAssigned = 0;
    let syncError: string | null = null;
    if (binding.organizationId) {
      try {
        autoAssigned = await syncEffectiveRepresentativeLinksForOrganization({
          organizationId: binding.organizationId,
          organizationSiteId: binding.organizationSiteId,
        });
      } catch (err) {
        syncError = toSafeSyncError(err);
      }
    }

    return NextResponse.json({
      binding: updated,
      autoAssigned,
      syncOk: !syncError,
      ...(syncError ? { syncError } : {}),
    }, { status: syncError ? 207 : 200 });
  }

  if (action === "reactivate") {
    if (binding.status !== "ARCHIVED") {
      return NextResponse.json({ error: "只能恢复已归档的绑定" }, { status: 400 });
    }

    const updated = await prisma.representativeOrganization.update({
      where: { id },
      data: {
        status: "ACTIVE",
        isPrimary: false, // don't auto-restore primary
        reviewNote: reviewNote?.trim() || null,
      },
    });

    // Sync affected customers: they may regain this fallback binding
    let autoAssigned = 0;
    let syncError: string | null = null;
    if (binding.organizationId) {
      try {
        autoAssigned = await syncEffectiveRepresentativeLinksForOrganization({
          organizationId: binding.organizationId,
          organizationSiteId: binding.organizationSiteId,
        });
      } catch (err) {
        syncError = toSafeSyncError(err);
      }
    }

    return NextResponse.json({
      binding: updated,
      autoAssigned,
      syncOk: !syncError,
      ...(syncError ? { syncError } : {}),
    }, { status: syncError ? 207 : 200 });
  }

  if (action === "change-scope") {
    if (binding.status !== "ACTIVE") {
      return NextResponse.json({ error: "只能修改活跃状态的绑定范围" }, { status: 400 });
    }
    if (!binding.organizationId) {
      return NextResponse.json({ error: "绑定缺少单位信息，无法修改范围" }, { status: 400 });
    }

    const nextSiteId = typeof organizationSiteId === "string" && organizationSiteId.trim()
      ? organizationSiteId.trim()
      : null;
    const scopeValidation = await validateRepresentativeBindingScope(prisma, binding.organizationId, nextSiteId);
    if (!scopeValidation.ok) {
      return NextResponse.json({ error: scopeValidation.error }, { status: 400 });
    }

    const existingAtScope = await findRepresentativeBindingByScope(prisma, {
      representativeId: binding.representativeId,
      organizationId: binding.organizationId,
      organizationSiteId: nextSiteId,
    });
    if (existingAtScope && existingAtScope.id !== binding.id) {
      return NextResponse.json({ error: "该代表在此绑定范围已有记录" }, { status: 409 });
    }

    const hasOtherActiveAtTarget = await prisma.representativeOrganization.findFirst({
      where: {
        organizationId: binding.organizationId,
        organizationSiteId: nextSiteId,
        status: "ACTIVE",
        id: { not: binding.id },
      },
      select: { id: true },
    });

    const updated = await prisma.representativeOrganization.update({
      where: { id },
      data: {
        organizationSiteId: nextSiteId,
        isPrimary: !hasOtherActiveAtTarget,
        reviewNote: reviewNote?.trim() || null,
      },
    });

    // Sync old + new scope；任一失败都显式返回
    let autoAssigned = 0;
    let syncError: string | null = null;
    try {
      if (binding.organizationId) {
        await syncEffectiveRepresentativeLinksForOrganization({
          organizationId: binding.organizationId,
          organizationSiteId: binding.organizationSiteId,
        });
      }
      autoAssigned = await syncEffectiveRepresentativeLinksForOrganization({
        organizationId: binding.organizationId,
        organizationSiteId: nextSiteId,
      });
    } catch (err) {
      syncError = toSafeSyncError(err);
    }

    return NextResponse.json({
      binding: updated,
      autoAssigned,
      syncOk: !syncError,
      ...(syncError ? { syncError } : {}),
    }, { status: syncError ? 207 : 200 });
  }

  if (action === "set-primary") {
    if (binding.status !== "ACTIVE") {
      return NextResponse.json({ error: "只有活跃状态的绑定才能设为主代表" }, { status: 400 });
    }

    const updated = await prisma.$transaction(async (tx) => {
      // Clear other primary at same level
      await tx.representativeOrganization.updateMany({
        where: {
          organizationId: binding.organizationId,
          organizationSiteId: binding.organizationSiteId ?? null,
          status: "ACTIVE",
          isPrimary: true,
          id: { not: binding.id },
        },
        data: { isPrimary: false },
      });

      return tx.representativeOrganization.update({
        where: { id },
        data: { isPrimary: true },
      });
    });

    return NextResponse.json({ binding: updated });
  }

  return NextResponse.json({ error: "无效操作" }, { status: 400 });
}

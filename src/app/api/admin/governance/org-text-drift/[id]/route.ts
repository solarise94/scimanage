import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { resolveCustomerOrganizationWrite } from "@/lib/customers/customer-organization-write";
import { syncProfileRepresentativeLinks } from "@/lib/crm/customer-representative-sync";
import { normalizeSiteName } from "@/lib/organization-normalize";

// W6.8：只认 profile.id，不再经 sourceCustomerId 转发 Customer-keyed sync。
function syncRepLinksForProfile(profile: { id: string }) {
  return syncProfileRepresentativeLinks(profile.id);
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { role: true },
  });
  if (!user || user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const body = await req.json();
  const { action, organizationId, organizationSiteId, siteName, resolutionNote } = body;

  const task = await prisma.customerOrgTextDriftTask.findUnique({
    where: { id },
  });
  if (!task) {
    return NextResponse.json({ error: "任务不存在" }, { status: 404 });
  }

  const now = new Date();

  // ── reopen / ignore 是状态转换，不需要重读 Profile ──
  if (action === "reopen") {
    const res = await prisma.customerOrgTextDriftTask.updateMany({
      where: { id, status: "IGNORED" },
      data: {
        status: "PENDING",
        resolvedAction: null,
        resolvedById: null,
        resolvedAt: null,
        resolutionNote: resolutionNote || null,
      },
    });
    if (res.count !== 1) {
      return NextResponse.json({ error: "任务状态已变更" }, { status: 409 });
    }
    return NextResponse.json({ success: true });
  }

  if (action === "ignore") {
    if (!resolutionNote?.trim()) {
      return NextResponse.json({ error: "忽略任务必须填写备注" }, { status: 400 });
    }
    const res = await prisma.customerOrgTextDriftTask.updateMany({
      where: { id, status: "PENDING" },
      data: {
        status: "IGNORED",
        resolvedAction: "IGNORED",
        resolvedById: session.user.id,
        resolvedAt: now,
        resolutionNote: resolutionNote.trim(),
      },
    });
    if (res.count !== 1) {
      return NextResponse.json({ error: "任务状态已变更" }, { status: 409 });
    }
    return NextResponse.json({ success: true });
  }

  // ── 以下动作需要重读 Profile 做 stale guard ──
  const profile = await prisma.crmCustomerProfile.findUnique({
    where: { id: task.profileId },
    include: {
      org: { select: { id: true, canonicalName: true, orgCode: true } },
      orgSite: { select: { id: true, siteName: true } },
    },
  });

  // 1. 源不再活跃 → 自动 RESOLVED
  if (!profile) {
    await prisma.customerOrgTextDriftTask.update({
      where: { id },
      data: {
        status: "RESOLVED",
        resolvedAction: "ALREADY_FIXED",
        resolvedById: session.user.id,
        resolvedAt: now,
        resolutionNote: "source no longer active",
      },
    });
    return NextResponse.json({ error: "源客户已删除或合并，任务已自动收敛" }, { status: 409 });
  }

  // 2. 当前值与快照不一致 → 409（需要重新扫描）
  if (
    profile.organizationId !== task.organizationIdSnapshot ||
    profile.organization !== task.organizationTextSnapshot
  ) {
    return NextResponse.json(
      { error: "客户机构字段与扫描快照不一致，请重新扫描后再处理" },
      { status: 409 },
    );
  }

  // 3. 当前已不再漂移 → 自动 RESOLVED
  const currentBoundOrg = profile.org;
  const currentText = profile.organization;
  const currentTextNorm = currentText ? currentText.trim() : "";
  const isCurrentlyDrifting =
    !currentBoundOrg ||
    !currentTextNorm ||
    currentTextNorm !== currentBoundOrg.canonicalName;
  if (!isCurrentlyDrifting) {
    await prisma.customerOrgTextDriftTask.update({
      where: { id },
      data: {
        status: "RESOLVED",
        resolvedAction: "ALREADY_FIXED",
        resolvedById: session.user.id,
        resolvedAt: now,
        resolutionNote: "当前已不再漂移",
      },
    });
    return NextResponse.json({ error: "当前已不再漂移，任务已自动收敛" }, { status: 409 });
  }

  if (action === "canonicalize") {
    if (!profile.org) {
      return NextResponse.json({ error: "绑定机构不存在" }, { status: 400 });
    }

    await prisma.$transaction(async (tx) => {
      await tx.crmCustomerProfile.update({
        where: { id: profile.id },
        data: {
          organization: profile.org!.canonicalName,
          organizationId: task.organizationIdSnapshot,
          organizationSiteId: task.organizationSiteIdSnapshot,
          organizationRawInput:
            task.organizationRawInputSnapshot ?? task.organizationTextSnapshot,
        },
      });

      await tx.customerOrgTextDriftTask.update({
        where: { id },
        data: {
          status: "RESOLVED",
          resolvedAction: "CANONICALIZED",
          resolvedById: session.user.id,
          resolvedAt: now,
          resolutionNote: resolutionNote?.trim() || null,
        },
      });
    });

    syncRepLinksForProfile(profile).catch(() => {});
    return NextResponse.json({ success: true });
  }

  if (action === "rebind") {
    if (!organizationId) {
      return NextResponse.json({ error: "换绑必须提供 organizationId" }, { status: 400 });
    }

    const orgWrite = await resolveCustomerOrganizationWrite(
      {
        organizationId,
        organizationSiteId: organizationSiteId || null,
        organizationRawInput: task.organizationRawInputSnapshot ?? task.organizationTextSnapshot,
      },
      prisma,
    );
    if (!orgWrite.ok) {
      return NextResponse.json({ error: orgWrite.message }, { status: orgWrite.status });
    }

    await prisma.$transaction(async (tx) => {
      await tx.crmCustomerProfile.update({
        where: { id: profile.id },
        data: {
          organizationId: orgWrite.organizationId,
          organizationSiteId: orgWrite.organizationSiteId,
          organization: orgWrite.organization,
          organizationRawInput: orgWrite.organizationRawInput,
        },
      });

      await tx.customerOrgTextDriftTask.update({
        where: { id },
        data: {
          status: "RESOLVED",
          resolvedAction: "REBOUND_ORG",
          resolvedOrganizationId: orgWrite.organizationId,
          resolvedSiteId: orgWrite.organizationSiteId,
          resolvedById: session.user.id,
          resolvedAt: now,
          resolutionNote: resolutionNote?.trim() || null,
        },
      });
    });

    syncRepLinksForProfile(profile).catch(() => {});
    return NextResponse.json({ success: true });
  }

  if (action === "assign-site") {
    if (!profile.org) {
      return NextResponse.json({ error: "绑定机构不存在" }, { status: 400 });
    }

    let targetSiteId: string | null = organizationSiteId || null;

    if (!targetSiteId && siteName?.trim()) {
      const normalized = normalizeSiteName(siteName.trim());
      const existing = await prisma.organizationSite.findUnique({
        where: {
          organizationId_normalizedSiteName: {
            organizationId: task.organizationIdSnapshot,
            normalizedSiteName: normalized,
          },
        },
      });
      if (existing) {
        targetSiteId = existing.id;
      } else {
        const created = await prisma.organizationSite.create({
          data: {
            organizationId: task.organizationIdSnapshot,
            siteName: siteName.trim(),
            normalizedSiteName: normalized,
          },
        });
        targetSiteId = created.id;
      }
    }

    if (!targetSiteId) {
      return NextResponse.json({ error: "请选择或填写院区" }, { status: 400 });
    }

    const orgWrite = await resolveCustomerOrganizationWrite(
      {
        organizationId: task.organizationIdSnapshot,
        organizationSiteId: targetSiteId,
        organizationRawInput: task.organizationRawInputSnapshot ?? task.organizationTextSnapshot,
      },
      prisma,
    );
    if (!orgWrite.ok) {
      return NextResponse.json({ error: orgWrite.message }, { status: orgWrite.status });
    }

    await prisma.$transaction(async (tx) => {
      await tx.crmCustomerProfile.update({
        where: { id: profile.id },
        data: {
          organization: orgWrite.organization,
          organizationId: orgWrite.organizationId,
          organizationSiteId: orgWrite.organizationSiteId,
          organizationRawInput: orgWrite.organizationRawInput,
        },
      });

      await tx.customerOrgTextDriftTask.update({
        where: { id },
        data: {
          status: "RESOLVED",
          resolvedAction: "ASSIGNED_SITE",
          resolvedSiteId: targetSiteId,
          resolvedById: session.user.id,
          resolvedAt: now,
          resolutionNote: resolutionNote?.trim() || null,
        },
      });
    });

    syncRepLinksForProfile(profile).catch(() => {});
    return NextResponse.json({ success: true });
  }

  return NextResponse.json({ error: "不支持的操作" }, { status: 400 });
}

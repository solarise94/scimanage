import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { syncProfileRepresentativeLinks, syncProfileRepresentativeLinksFromOwner } from "@/lib/crm/customer-representative-sync";
import { syncManagingTagForProfileOwner } from "@/lib/crm/customer-rep-tag-helpers";
import { assertRepresentativeBackedSalesUser } from "@/lib/representative-user";
import { getCrmLifecycleSummaryByProfileId, transitionCrmStage } from "@/lib/crm/lifecycle";
import { interactionOperatorInclude, followUpTaskOperatorInclude } from "@/lib/crm/includes";
import { buildCrmProfileCustomerView } from "@/lib/customers/customer-business-fields";
import { getProfilePreferenceSummary } from "@/lib/crm/preferences";
import { COMPLAINT_OPEN_STATUSES } from "@/lib/crm/constants";
import { toPinyinToneless } from "@/lib/crm/pinyin";
import { toPublicProfile } from "@/lib/crm/public-dto";
import {
  assertSharedProfileFreshness,
  buildCrmProfileDto,
  loadPoolDtoContext,
  resolveActorDepartment,
  resolveCrmProfileAccess,
} from "@/lib/crm/profile-access";
import { requireCrmActor } from "@/lib/crm/route-helpers";
import { ApplicationError } from "@/lib/application/errors";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;

  const actor = requireCrmActor(session);
  // §6.6：经部门隔离 access resolver；ADMIN→FULL，非 ADMIN FULL/POOL/NONE。
  // NONE 统一 404（防存在性泄露）；POOL 返回脱敏 PoolProfileDto（最小披露）。
  const access = await resolveCrmProfileAccess({ profileId: id, actor });
  if (access === "NONE") {
    return NextResponse.json({ error: "Profile not found" }, { status: 404 });
  }

  if (access === "POOL") {
    // 公海受限视图：只加载最小披露字段，绝不加载互动/订单/财务/联系方式。
    const department = await resolveActorDepartment(actor);
    const poolProfile = department
      ? await prisma.crmCustomerProfile.findUnique({
          where: { id },
          select: {
            id: true,
            name: true,
            customerCode: true,
            organization: true,
            labOrGroup: true,
            personCategory: true,
            org: { select: { canonicalName: true } },
            orgSite: { select: { siteName: true } },
          },
        })
      : null;
    if (!poolProfile) {
      return NextResponse.json({ error: "Profile not found" }, { status: 404 });
    }
    const context = department ? await loadPoolDtoContext(id, department) : null;
    const dto = buildCrmProfileDto(poolProfile, "POOL", context ?? undefined);
    return NextResponse.json({ profile: dto, pool: true });
  }

  // access === "FULL"：完整 DTO（沿用既有详情序列化）。
  const profile = await prisma.crmCustomerProfile.findUnique({
    where: { id },
    include: {
      org: { select: { id: true, canonicalName: true } },
      orgSite: { select: { id: true, siteName: true, siteType: true } },
      ownerUser: { select: { id: true, name: true } },
      addresses: { orderBy: { createdAt: "desc" } },
      interactions: {
        orderBy: { happenedAt: "desc" },
        take: 10,
        include: interactionOperatorInclude,
      },
      followUpTasks: {
        where: { status: "OPEN" },
        orderBy: { dueAt: "asc" },
        include: followUpTaskOperatorInclude,
      },
      visitCheckins: {
        orderBy: { createdAt: "desc" },
        take: 5,
        include: { media: true, user: { select: { id: true, name: true } } },
      },
      _count: { select: { interactions: true, followUpTasks: true, visitCheckins: true, addresses: true } },
    },
  });

  if (!profile) {
    return NextResponse.json({ error: "Profile not found" }, { status: 404 });
  }

  const [lifecycle, preferenceSummary, openComplaint, repTags] = await Promise.all([
    getCrmLifecycleSummaryByProfileId(profile.id),
    getProfilePreferenceSummary(profile.id),
    prisma.crmComplaint.findFirst({
      where: {
        profileId: profile.id,
        status: { in: [...COMPLAINT_OPEN_STATUSES] },
      },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        title: true,
        category: true,
        severity: true,
        status: true,
        updatedAt: true,
      },
    }),
    prisma.customerRepTag.findMany({
      where: { profileId: profile.id },
      orderBy: [{ isActive: "desc" }, { isPrimary: "desc" }, { startedAt: "desc" }],
      include: { representative: { select: { id: true, name: true } } },
    }),
  ]);

  const profileWithView = {
    ...toPublicProfile(profile),
    repTags,
    customerView: buildCrmProfileCustomerView(profile),
  };

  return NextResponse.json({
    profile: profileWithView,
    preferenceSummary,
    openComplaint,
    lifecycle: lifecycle ? {
      ...lifecycle,
      lastActiveOrderAt: lifecycle.lastActiveOrderAt?.toISOString() ?? null,
      lastHistoricalOrderAt: lifecycle.lastHistoricalOrderAt?.toISOString() ?? null,
      lastEffectiveInteractionAt: lifecycle.lastEffectiveInteractionAt?.toISOString() ?? null,
      nextCommunicationTaskAt: lifecycle.nextCommunicationTaskAt?.toISOString() ?? null,
    } : null,
  });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;

  const patchActor = requireCrmActor(session);
  // §6.6 / §8.6：编辑 profile 要求本部门 CLAIMED active owner（FULL）；POOL 只读，
  // NONE→404。ADMIN 保持 FULL（既有行为）。
  const patchAccess = await resolveCrmProfileAccess({ profileId: id, actor: patchActor });
  if (patchAccess === "NONE") {
    return NextResponse.json({ error: "Profile not found" }, { status: 404 });
  }
  if (patchAccess === "POOL") {
    return NextResponse.json({ error: "公海客户为只读视图，请先认领" }, { status: 403 });
  }

  const body = await req.json();
  const data: Record<string, unknown> = {};
  const existing = await prisma.crmCustomerProfile.findUnique({
    where: { id },
    select: {
      ownerUserId: true,
      assignmentStatus: true,
      name: true,
      organizationId: true,
      organizationSiteId: true,
      organization: true,
    },
  });
  if (!existing) return NextResponse.json({ error: "Profile not found" }, { status: 404 });

  if (body.summary !== undefined) data.summary = body.summary;
  if (body.tagsJson !== undefined) data.tagsJson = body.tagsJson;
  if (body.nextFollowUpAt !== undefined) data.nextFollowUpAt = body.nextFollowUpAt ? new Date(body.nextFollowUpAt) : null;
  if (body.archived !== undefined) {
    if (session.user.role !== "ADMIN") {
      return NextResponse.json({ error: "仅管理员可归档客户档案" }, { status: 403 });
    }
    data.archived = body.archived;
  }
  if (body.personCategory !== undefined) data.personCategory = body.personCategory || null;
  if (body.jobTitle !== undefined) data.jobTitle = body.jobTitle || null;
  if (body.graduationDate !== undefined) data.graduationDate = body.graduationDate ? new Date(body.graduationDate) : null;
  if (body.graduationReminderAt !== undefined) data.graduationReminderAt = body.graduationReminderAt ? new Date(body.graduationReminderAt) : null;

  // Phase D：业务主权字段也可经 CRM-native PATCH 写入（Profile-only 编辑入口）
  if (body.name !== undefined) {
    if (!String(body.name || "").trim()) {
      return NextResponse.json({ error: "客户姓名不能为空" }, { status: 400 });
    }
    data.name = String(body.name).trim();
    // namePinyin 与 name 同源计算，保证 name 变更后索引同步（空串写 null）。
    data.namePinyin = toPinyinToneless(String(body.name).trim()) || null;
  }
  if (body.principal !== undefined) data.principal = body.principal?.trim() || null;
  if (body.email !== undefined) data.email = body.email?.trim() || null;
  if (body.wechat !== undefined) data.wechat = body.wechat?.trim() || null;
  if (body.address !== undefined) data.address = body.address?.trim() || null;
  if (body.miniProgramId !== undefined) data.miniProgramId = body.miniProgramId?.trim() || null;
  if (body.labOrGroup !== undefined) data.labOrGroup = body.labOrGroup || null;

  const touchedOrganization =
    body.organization !== undefined ||
    body.organizationId !== undefined ||
    body.organizationSiteId !== undefined ||
    body.organizationRawInput !== undefined;
  if (touchedOrganization) {
    const { resolveCustomerOrganizationWrite } = await import("@/lib/customers/customer-organization-write");
    const orgWrite = await resolveCustomerOrganizationWrite({
      organizationId: body.organizationId !== undefined ? body.organizationId : existing.organizationId,
      organizationSiteId: body.organizationSiteId !== undefined ? body.organizationSiteId : existing.organizationSiteId,
      organizationText: typeof body.organization === "string" ? body.organization : undefined,
      organizationRawInput: typeof body.organizationRawInput === "string" ? body.organizationRawInput : undefined,
      existingOrganizationId: existing.organizationId,
    });
    if (!orgWrite.ok) {
      return NextResponse.json({ error: orgWrite.message }, { status: orgWrite.status });
    }
    data.organization = orgWrite.organization;
    data.organizationId = orgWrite.organizationId;
    data.organizationSiteId = orgWrite.organizationSiteId;
    data.organizationRawInput = orgWrite.organizationRawInput;
  }

  if (session.user.role !== "REPRESENTATIVE") {
    if (body.importance !== undefined) data.importance = body.importance;
    if (body.ownerUserId !== undefined) {
      if (body.ownerUserId) {
        try {
          await assertRepresentativeBackedSalesUser(body.ownerUserId);
        } catch (error) {
          return NextResponse.json({ error: error instanceof Error ? error.message : "负责人无效" }, { status: 400 });
        }
      }
      data.ownerUserId = body.ownerUserId;
    }
  }

  const ownerUserTouched = body.ownerUserId !== undefined && body.ownerUserId !== existing.ownerUserId;
  const nameTouched = body.name !== undefined && String(body.name).trim() !== (existing.name || "");
  const manualStageChange = body.stage !== undefined && body.stage !== "" && session.user.role !== "REPRESENTATIVE";

  // §8.6 共享 profile 乐观并发校验：客户端携带读取时的 updatedAt（expectedUpdatedAt），
  // 与当前库值不一致即 409，避免最后写入静默覆盖。缺省时维持现状（前端后续接入）。
  if (body.expectedUpdatedAt !== undefined && body.expectedUpdatedAt !== null) {
    try {
      await assertSharedProfileFreshness({ profileId: id, expectedUpdatedAt: body.expectedUpdatedAt });
    } catch (err) {
      if (err instanceof ApplicationError) {
        return NextResponse.json({ error: err.message, code: err.code }, { status: err.httpStatus });
      }
      throw err;
    }
  }

  let profile;
  try {
    profile = await prisma.$transaction(async (tx) => {
    const updated = await tx.crmCustomerProfile.update({
      where: { id },
      data,
      select: {
        id: true,
        ownerUserId: true,
        stage: true,
        importance: true,
        personCategory: true,
        jobTitle: true,
        graduationDate: true,
        graduationReminderAt: true,
        summary: true,
        tagsJson: true,
        nextFollowUpAt: true,
        archived: true,
        assignmentStatus: true,
        // 业务字段从 Profile 本体读取（主权）
        name: true,
        customerCode: true,
        principal: true,
        email: true,
        wechat: true,
        organization: true,
        address: true,
        miniProgramId: true,
        organizationId: true,
        organizationSiteId: true,
        org: { select: { canonicalName: true } },
        orgSite: { select: { siteName: true } },
        ownerUser: { select: { id: true, name: true } },
      },
    });

    if (body.archived !== undefined) {
      await tx.activityLog.create({
        data: {
          type: "CRM_PROFILE_ARCHIVED",
          content: body.archived
            ? `归档客户档案：${updated.name || id}`
            : `恢复客户档案：${updated.name || id}`,
          userId: session.user.id,
          metadata: JSON.stringify({ profileId: id, archived: body.archived }),
        },
      });
    }

    // 机构变化走 org binding；显式负责人优先同步代表缓存与 MANAGING 可见性
    if (touchedOrganization) {
      await syncProfileRepresentativeLinks(id, tx, { preserveOwnerUserId: ownerUserTouched });
    }
    if (ownerUserTouched) {
      await syncProfileRepresentativeLinksFromOwner(id, updated.ownerUserId, tx);
      if (updated.ownerUserId) {
        await syncManagingTagForProfileOwner(tx, {
          profileId: id,
          ownerUserId: updated.ownerUserId,
          actingUserId: session.user.id,
          note: "资料编辑：负责人变更",
        });
      }
    }

    // 姓名变化：同步 Project.client 快照（只按 profileId）
    if (nameTouched && updated.name) {
      await tx.project.updateMany({
        where: { profileId: id },
        data: { client: updated.name },
      });
    }

    return updated;
    });
  } catch (err) {
    if (err instanceof ApplicationError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.httpStatus });
    }
    throw err;
  }

  // 阶段人工变更通过统一入口记录历史（真正的强制改阶段，不走自动推导）
  if (manualStageChange) {
    try {
      await transitionCrmStage(id, {
        type: "MANUAL_UPDATE",
        actorUserId: session.user.id,
        targetStage: body.stage,
        reason: body.stageChangeReason || "人工调整阶段",
      });
    } catch (error) {
      console.error(`[CRM][PROFILE] manual stage transition failed for profile ${id}:`, error);
    }
  }

  return NextResponse.json({
    profile: {
      ...toPublicProfile(profile as unknown as Record<string, unknown>),
      customerView: buildCrmProfileCustomerView(profile),
    },
  });
}

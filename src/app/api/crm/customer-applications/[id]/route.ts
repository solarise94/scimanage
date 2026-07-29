import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isRepresentative } from "@/lib/permissions";
import { buildCustomerData, createCustomerWithRetry, findDuplicateCustomers } from "@/lib/crm/customer-application-review";
import { resolveCustomerOrganizationWrite } from "@/lib/customers/customer-organization-write";
import {
  canReviewApplication,
  confirmCustomerApplicationReview,
  rejectCustomerApplicationReview,
} from "@/lib/crm/customer-application-review-actions";
import { assertRepresentativeBackedSalesUser } from "@/lib/representative-user";
import { transitionCrmStage } from "@/lib/crm/lifecycle";
import { retireOtherManagingTags, upsertManagingTag } from "@/lib/crm/customer-rep-tag-helpers";
import { syncProfileRepresentativeLinksFromOwner } from "@/lib/crm/customer-representative-sync";
import { toPublicApplication } from "@/lib/crm/public-dto";

const applicationInclude = {
  submittedByUser: { select: { id: true, name: true, email: true } },
  reviewedByUser: { select: { id: true, name: true } },
  createdCrmProfile: { select: { id: true, name: true, customerCode: true } },
};

function pruneCandidate(c: {
  id: string;
  profileId?: string;
  name: string;
  customerCodeLast6: string;
  organization: string | null;
  hasCrmProfile: boolean;
  matchReasons: string[];
  matchedName?: string;
  matchedNameType?: string;
}) {
  return {
    id: c.id,
    profileId: c.profileId ?? c.id,
    name: c.name,
    customerCodeLast6: c.customerCodeLast6,
    organization: c.organization,
    hasCrmProfile: c.hasCrmProfile,
    matchReasons: c.matchReasons,
    matchedName: c.matchedName,
    matchedNameType: c.matchedNameType,
  };
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Allow-list: only ADMIN, REPRESENTATIVE, REGIONAL_MANAGER
  const allowedRoles = ["ADMIN", "REPRESENTATIVE", "REGIONAL_MANAGER"];
  if (!allowedRoles.includes(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const application = await prisma.crmCustomerApplication.findUnique({
    where: { id },
    include: applicationInclude,
  });
  if (!application) {
    return NextResponse.json({ error: "申请不存在" }, { status: 404 });
  }

  if (isRepresentative(session.user.role) && application.submittedByUserId !== session.user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (session.user.role === "REGIONAL_MANAGER" && !(await canReviewApplication(session.user.id, session.user.role, application))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { blocking, weak } = await findDuplicateCustomers({
    name: application.name,
    email: application.email,
    wechat: application.wechat,
    miniProgramId: application.miniProgramId,
    organizationId: application.organizationId,
    organizationRawInput: application.organizationRawInput,
    organization: application.organization,
    principal: application.principal,
  });
  const allCandidates = [...blocking, ...weak];

  // Privacy: reviewers get full detail; reps get pruned candidates
  const isReviewer = await canReviewApplication(session.user.id, session.user.role, application);
  const responseCandidates = isReviewer ? allCandidates : allCandidates.map(pruneCandidate);

  return NextResponse.json({ application: toPublicApplication(application), candidates: responseCandidates });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Allow-list: only ADMIN and REGIONAL_MANAGER can perform review actions
  // REPRESENTATIVE and USER are blocked from all mutations
  const allowedRoles = ["ADMIN", "REGIONAL_MANAGER"];
  if (!allowedRoles.includes(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const body = await req.json();
  const { action } = body;

  const application = await prisma.crmCustomerApplication.findUnique({ where: { id } });
  if (!application) {
    return NextResponse.json({ error: "申请不存在" }, { status: 404 });
  }

  // ── Supervisor review actions (confirm-review / reject-review) ──

  if (action === "confirm-review" || action === "reject-review") {
    if (!(await canReviewApplication(session.user.id, session.user.role, application))) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  if (action === "confirm-review") {
    const reviewNote = body.reviewNote?.trim() || null;
    const result = await confirmCustomerApplicationReview(session.user.id, id, reviewNote);
    if (!result.claimed) {
      return NextResponse.json({ error: "该申请已被处理" }, { status: 400 });
    }
    return NextResponse.json({ application: toPublicApplication(result.application) });
  }

  if (action === "reject-review") {
    const reviewNote = body.reviewNote?.trim() || null;
    const result = await rejectCustomerApplicationReview(session.user.id, id, reviewNote);
    if (!result.claimed) {
      return NextResponse.json({ error: "该申请已被处理" }, { status: 400 });
    }
    return NextResponse.json({ success: true });
  }

  // ── Legacy actions for old PENDING applications ──
  if (application.status !== "PENDING") {
    return NextResponse.json({ error: "该申请已处理" }, { status: 400 });
  }

  if (!(await canReviewApplication(session.user.id, session.user.role, application))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (action === "reject") {
    const reviewNote = body.reviewNote?.trim() || null;
    const updated = await prisma.crmCustomerApplication.update({
      where: { id },
      data: {
        status: "REJECTED",
        reviewedByUserId: session.user.id,
        reviewedAt: new Date(),
        reviewNote,
      },
      include: applicationInclude,
    });
    return NextResponse.json({ application: updated });
  }

  if (action === "approve") {
    return handleApprove(session, application, body);
  }

  if (action === "approve-bind") {
    return handleApproveBind(session, application, body);
  }

  return NextResponse.json({ error: "无效操作" }, { status: 400 });
}

async function handleApprove(
  session: { user: { id: string; role: string } },
  application: { id: string; submittedByUserId: string; name: string; principal: string | null; email: string | null; wechat: string | null; organization: string | null; organizationId: string | null; organizationSiteId: string | null; organizationRawInput: string | null; address: string | null; miniProgramId: string | null; locationLat: number | null; locationLng: number | null; locationAddress: string | null },
  body: { ownerUserId?: string; reviewNote?: string }
) {
  const finalOwnerUserId = body.ownerUserId || application.submittedByUserId;
  const reviewNote = body.reviewNote?.trim() || null;

  if (body.ownerUserId) {
    try {
      await assertRepresentativeBackedSalesUser(body.ownerUserId);
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : "负责人无效" }, { status: 400 });
    }
  }

  const rawOrgText = application.organizationRawInput || application.organization;
  const orgWrite = await resolveCustomerOrganizationWrite({
    organizationId: application.organizationId,
    organizationSiteId: application.organizationSiteId,
    organizationText: application.organization || null,
    organizationRawInput: rawOrgText,
  });
  if (!orgWrite.ok) {
    return NextResponse.json({ error: orgWrite.message }, { status: orgWrite.status });
  }

  const orgValidation = {
    organizationId: orgWrite.organizationId,
    organizationSiteId: orgWrite.organizationSiteId,
    canonicalName: orgWrite.organization,
  };

  const location = (application.locationLat != null && application.locationLng != null)
    ? { lat: application.locationLat, lng: application.locationLng, address: application.locationAddress || application.address || "" }
    : null;

  const customerData = buildCustomerData(application, orgValidation);
  const result = await createCustomerWithRetry(prisma, customerData, application.id, finalOwnerUserId, session.user.id, reviewNote, location);
  if (result.error) {
    return NextResponse.json({ error: result.error }, { status: result.status || 500 });
  }
  return NextResponse.json({ application: toPublicApplication(result.application) });
}

async function handleApproveBind(
  session: { user: { id: string; role: string } },
  application: { id: string; submittedByUserId: string; name: string },
  body: {
    targetProfileId?: string;
    ownerUserId?: string;
    reviewNote?: string;
  },
) {
  // 旧 *CustomerId 系参数一律 400（键名枚举，避免在源码里引用已废弃契约）。
  const legacyKey = Object.keys(body as Record<string, unknown>).find((k) => /customerids?$/i.test(k));
  if (legacyKey) {
    return NextResponse.json(
      { error: `请使用 targetProfileId 指定目标客户（不再接受 ${legacyKey}）` },
      { status: 400 },
    );
  }

  const rawTarget = body.targetProfileId;
  if (!rawTarget) {
    return NextResponse.json({ error: "targetProfileId 必填" }, { status: 400 });
  }

  const { findActiveProfile } = await import("@/lib/crm/ids");
  const ref = await findActiveProfile(rawTarget, prisma);
  if (!ref) {
    return NextResponse.json({ error: "目标客户不存在" }, { status: 404 });
  }

  const existingProfile = await prisma.crmCustomerProfile.findUnique({
    where: { id: ref.profileId },
    select: {
      id: true,
      ownerUserId: true,
      deleted: true,
      archived: true,
    },
  });
  if (!existingProfile || existingProfile.deleted) {
    return NextResponse.json({ error: "目标客户不存在" }, { status: 404 });
  }

  // 绑定既有客户：默认把档案分配给申请人（与 approve 新建一致）；
  // 显式传入 ownerUserId 时可覆盖。owner / MANAGING / Order·Project 代表缓存必须同向。
  const finalOwnerUserId = body.ownerUserId || application.submittedByUserId;

  try {
    await assertRepresentativeBackedSalesUser(finalOwnerUserId);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "负责人无效" }, { status: 400 });
  }

  const reviewNote = body.reviewNote?.trim() || null;

  try {
    const result = await prisma.$transaction(async (tx) => {
      // Phase D：候选已是 Profile；绑定到已有档案，不新建 Customer/Profile。
      await tx.crmCustomerProfile.update({
        where: { id: existingProfile.id },
        data: {
          ownerUserId: finalOwnerUserId,
          assignmentStatus: "ASSIGNED",
          assignedAt: new Date(),
        },
      });

      const ownerUser = await tx.user.findUnique({
        where: { id: finalOwnerUserId },
        select: { email: true },
      });
      const ownerRep = ownerUser?.email
        ? await tx.representative.findUnique({
            where: { email: ownerUser.email },
            select: { id: true },
          })
        : null;
      if (ownerRep) {
        const now = new Date();
        await retireOtherManagingTags(tx, {
          profileId: existingProfile.id,
          exceptRepId: ownerRep.id,
          now,
          actingUserId: session.user.id,
          note: "申请审批（绑定既有客户）：管理关系转为跟进历史",
        });
        await upsertManagingTag(tx, {
          profileId: existingProfile.id,
          representativeId: ownerRep.id,
          now,
          actingUserId: session.user.id,
        });
      }

      await syncProfileRepresentativeLinksFromOwner(existingProfile.id, finalOwnerUserId, tx);

      const updated = await tx.crmCustomerApplication.update({
        where: { id: application.id },
        data: {
          status: "APPROVED",
          reviewedByUserId: session.user.id,
          reviewedAt: new Date(),
          reviewNote,
          createdCrmProfileId: existingProfile.id,
        },
        include: applicationInclude,
      });

      return updated;
    });

    if (result.createdCrmProfileId) {
      try {
        await transitionCrmStage(result.createdCrmProfileId, {
          type: "APPLICATION_APPROVED",
          applicationId: application.id,
        });
      } catch (err) {
        console.error(`[CRM][APPLICATION] APPLICATION_APPROVED transition failed for ${result.createdCrmProfileId}:`, err);
      }
    }

    return NextResponse.json({ application: result });
  } catch (error) {
    console.error("Approve-bind application error:", error);
    const message = error instanceof Error ? error.message : "审核操作失败";
    const status = message.includes("单位") || message.includes("机构") || message.includes("院区") ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

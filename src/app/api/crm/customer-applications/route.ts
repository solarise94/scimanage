import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getManagedSubmitterUserIds } from "@/lib/crm/supervisor";
import { buildRepresentativeOwnApplicationsWhere } from "@/lib/crm/application/list-my-customer-applications";
import { submitCustomerApplicationForActor } from "@/lib/crm/application/submit-customer-application";
import { businessActorFromSessionUser, buildInvocationContext } from "@/lib/application/actor";
import { ForbiddenError } from "@/lib/application/errors";
import { toPublicApplication } from "@/lib/crm/public-dto";
import { resolveActorDepartmentOrNull } from "@/lib/department";

const applicationInclude = {
  submittedByUser: { select: { id: true, name: true, email: true } },
  reviewedByUser: { select: { id: true, name: true } },
  // 客户主权在 CrmCustomerProfile；旧锚点 relation 不再投影。
  createdCrmProfile: { select: { id: true, name: true, customerCode: true } },
};

// Privacy-safe candidate shape for 409 / non-reviewer responses
function pruneCandidate(c: {
  id: string; name: string; customerCodeLast6: string;
  organization: string | null; hasCrmProfile: boolean; matchReasons: string[];
  matchedName?: string; matchedNameType?: string;
}) {
  return {
    id: c.id,
    name: c.name,
    customerCodeLast6: c.customerCodeLast6,
    organization: c.organization,
    hasCrmProfile: c.hasCrmProfile,
    matchReasons: c.matchReasons,
    matchedName: c.matchedName,
    matchedNameType: c.matchedNameType,
  };
}

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = req.nextUrl;
  const status = searchParams.get("status") || "";
  const review = searchParams.get("review") || "";
  const view = searchParams.get("view") || "";

  const where: Record<string, unknown> = {};

  // §6.6 末条 / §8.6：非 ADMIN 列表查询 AND departmentSnapshot = actor 部门。
  // ADMIN 不加该过滤（可跨部门运营记录按部门标签展示）。
  // Fail-closed（设计 §6.1）：部门无法权威解析时返回空集，不静默降级 FIELD_SALES。
  if (session.user.role !== "ADMIN") {
    const actorDept = await resolveActorDepartmentOrNull(session.user.id);
    if (!actorDept) {
      return NextResponse.json({ applications: [] });
    }
    where.departmentSnapshot = actorDept;
  }

  // ── Role-based access (allow-list) ──
  if (session.user.role === "ADMIN" || session.user.role === "USER") {
    // no restriction
  } else if (session.user.role === "REPRESENTATIVE") {
    Object.assign(where, buildRepresentativeOwnApplicationsWhere(businessActorFromSessionUser(session.user)));
  } else if (session.user.role === "REGIONAL_MANAGER") {
    const repUserIds = await getManagedSubmitterUserIds(session.user.id);
    if (repUserIds.length > 0) {
      where.submittedByUserId = { in: repUserIds };
    } else {
      // Without managed reps, the review queue has nothing actionable.
      // Restrict only the review queue so all/other views still show self submissions.
      if (view === "review" || review === "PENDING") {
        return NextResponse.json({ applications: [] });
      }
      where.submittedByUserId = session.user.id;
    }
  } else {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (status) where.status = status;
  if (review === "PENDING") {
    where.status = "APPROVED";
    where.OR = [
      { supervisorReviewStatus: "PENDING" },
      { adminReviewStatus: "PENDING", supervisorReviewStatus: "NONE" },
    ];
  }
  if (view === "pending") {
    where.status = "PENDING";
  } else if (view === "review") {
    where.status = "APPROVED";
    where.OR = [
      { supervisorReviewStatus: "PENDING" },
      { adminReviewStatus: "PENDING", supervisorReviewStatus: "NONE" },
    ];
  }

  const applications = await prisma.crmCustomerApplication.findMany({
    where,
    include: applicationInclude,
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({ applications: applications.map(toPublicApplication) });
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Allow-list: only ADMIN, REPRESENTATIVE, REGIONAL_MANAGER can submit
  const allowedRoles = ["ADMIN", "REPRESENTATIVE", "REGIONAL_MANAGER"];
  if (!allowedRoles.includes(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json();
  const {
    name, principal, email, wechat, organization,
    organizationId, organizationSiteId, organizationRawInput, address, miniProgramId, notes,
    locationLat, locationLng, locationAddress,
    duplicateDecision,
  } = body;

  const location = (typeof locationLat === "number" && typeof locationLng === "number")
    ? { lat: locationLat, lng: locationLng, address: locationAddress?.trim() || address?.trim() || "" }
    : null;

  try {
    const result = await submitCustomerApplicationForActor(
      businessActorFromSessionUser(session.user),
      buildInvocationContext({ channel: "web" }),
      {
        name,
        organizationId,
        organizationSiteId,
        organizationRawInput,
        organization,
        principal,
        email,
        wechat,
        miniProgramId,
        address,
        notes,
        location: location ?? undefined,
        duplicateDecision,
      },
    );

    // If blocking duplicates were found (no CREATE_NEW), return 409 with candidates
    if (result.blockingDuplicates.length > 0) {
      return NextResponse.json({
        error: "检测到可能重复的客户",
        code: "DUPLICATE_CANDIDATES",
        candidates: result.blockingDuplicates.map(pruneCandidate),
      }, { status: 409 });
    }

    return NextResponse.json({ application: toPublicApplication(result.application) }, { status: 201 });
  } catch (error) {
    if (error instanceof ForbiddenError) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const msg = error instanceof Error ? error.message : "申请提交失败";
    // Check for duplicate candidates error from buildProposal path
    if (msg === "DUPLICATE_CANDIDATES") {
      return NextResponse.json({
        error: "检测到可能重复的客户",
        code: "DUPLICATE_CANDIDATES",
      }, { status: 409 });
    }
    const status = msg.includes("必填") || msg.includes("无效") ? 400 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}

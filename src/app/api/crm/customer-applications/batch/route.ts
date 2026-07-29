import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { validateOrg, buildCustomerData, createCustomerWithRetry } from "@/lib/crm/customer-application-review";
import { runBatchCustomerApplicationReview } from "@/lib/crm/customer-application-review-actions";
import { assertRepresentativeBackedSalesUser } from "@/lib/representative-user";

const VALID_CREATE_ACTIONS = new Set(["approve", "reject"]);
const VALID_REVIEW_ACTIONS = new Set(["confirm-review", "reject-review"]);
const VALID_ACTIONS = new Set([...VALID_CREATE_ACTIONS, ...VALID_REVIEW_ACTIONS]);

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const { action, ids, ownerUserId, reviewNote } = body as {
    action: string;
    ids: string[];
    ownerUserId?: string;
    reviewNote?: string;
  };

  if (!Array.isArray(ids) || ids.length === 0) {
    return NextResponse.json({ error: "ids must be a non-empty array" }, { status: 400 });
  }
  if (!VALID_ACTIONS.has(action)) {
    return NextResponse.json({ error: "action must be one of: approve, reject, confirm-review, reject-review" }, { status: 400 });
  }

  // ── Role-gate by action ──
  const isAdmin = session.user.role === "ADMIN";
  const isRegionalManager = session.user.role === "REGIONAL_MANAGER";

  if (VALID_CREATE_ACTIONS.has(action)) {
    if (!isAdmin) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  } else {
    // confirm-review / reject-review
    if (!isAdmin && !isRegionalManager) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  const trimmedNote = reviewNote?.trim() || null;

  // ── Review actions ──
  if (VALID_REVIEW_ACTIONS.has(action)) {
    if (action === "reject-review" && !trimmedNote) {
      return NextResponse.json({ error: "拒绝复核必须填写备注" }, { status: 400 });
    }
    const result = await runBatchCustomerApplicationReview(
      session.user.id,
      session.user.role,
      action as "confirm-review" | "reject-review",
      ids,
      trimmedNote,
    );

    return NextResponse.json({
      ok: true,
      action,
      confirmed: result.confirmed,
      reviewRejected: result.reviewRejected,
      skipped: result.skipped,
      errors: result.errors,
    });
  }

  // ── Create actions (approve / reject) ──
  // ADMIN-only; kept for backward compatibility with the existing pending queue

  if (ownerUserId) {
    try {
      await assertRepresentativeBackedSalesUser(ownerUserId);
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : "负责人无效" }, { status: 400 });
    }
  }

  let approved = 0;
  let createRejected = 0;
  const skipped: Array<{ id: string; reason: string }> = [];
  const errors: Array<{ id: string; error: string }> = [];

  for (const id of ids) {
    try {
      const application = await prisma.crmCustomerApplication.findUnique({
        where: { id },
        select: {
          id: true,
          status: true,
          autoApproved: true,
          supervisorReviewStatus: true,
          submittedByUserId: true,
          name: true,
          principal: true,
          email: true,
          wechat: true,
          organization: true,
          organizationId: true,
          organizationSiteId: true,
          organizationRawInput: true,
          address: true,
          miniProgramId: true,
          locationLat: true,
          locationLng: true,
          locationAddress: true,
        },
      });

      if (!application) {
        skipped.push({ id, reason: "申请不存在" });
        continue;
      }
      if (application.autoApproved || application.supervisorReviewStatus !== "NONE") {
        skipped.push({ id, reason: "需主管逐条复核，不支持批量操作" });
        continue;
      }
      if (application.status !== "PENDING") {
        skipped.push({ id, reason: "该申请已处理" });
        continue;
      }

      if (action === "reject") {
        await prisma.crmCustomerApplication.update({
          where: { id },
          data: {
            status: "REJECTED",
            reviewedByUserId: session.user.id,
            reviewedAt: new Date(),
            reviewNote: trimmedNote,
          },
        });
        createRejected++;
        continue;
      }

      // action === "approve"
      const finalOwnerUserId = ownerUserId || application.submittedByUserId;
      const orgValidation = await validateOrg(
        application.organizationId, application.organizationSiteId,
        application.organizationRawInput || application.organization,
      );
      if (orgValidation.error) {
        errors.push({ id, error: orgValidation.error });
        continue;
      }

      const location = (application.locationLat != null && application.locationLng != null)
        ? { lat: application.locationLat, lng: application.locationLng, address: application.locationAddress || application.address || "" }
        : null;

      const customerData = buildCustomerData(application, orgValidation);
      const result = await createCustomerWithRetry(
        prisma, customerData, application.id, finalOwnerUserId, session.user.id, trimmedNote, location,
      );

      if (result.error) {
        errors.push({ id, error: result.error || "审核失败" });
      } else {
        approved++;
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "未知错误";
      errors.push({ id, error: msg });
    }
  }

  return NextResponse.json({
    ok: true,
    action,
    approved,
    createRejected,
    // Backward-compat: frontend pending-queue mutations still read `rejected`
    rejected: createRejected,
    skipped,
    errors,
  });
}

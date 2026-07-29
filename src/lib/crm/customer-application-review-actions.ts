import { prisma } from "@/lib/prisma";
import { getApplicationReviewerUserIds } from "@/lib/crm/supervisor";
import { PrismaClient, Prisma } from "@prisma/client";

// Transaction client type from Prisma
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
interface PrismaTx extends Prisma.TransactionClient {}

const applicationInclude = {
  submittedByUser: { select: { id: true, name: true, email: true } },
  reviewedByUser: { select: { id: true, name: true } },
  createdCrmProfile: { select: { id: true, name: true, customerCode: true } },
};

/**
 * Check whether a user is authorised to review (confirm/reject) a specific application.
 *
 * ADMIN can review everything.
 * REGIONAL_MANAGER can only review applications whose submitter is in their managed pool.
 */
export async function canReviewApplication(
  userId: string,
  role: string,
  application: { submittedByUserId: string },
): Promise<boolean> {
  if (role === "ADMIN") return true;
  if (role === "REGIONAL_MANAGER") {
    const reviewerIds = await getApplicationReviewerUserIds(application.submittedByUserId);
    return reviewerIds.includes(userId);
  }
  return false;
}

/**
 * Claim an application for review by updating it atomically.
 * Returns true if the claim succeeded (i.e. the record matched the expected pending state).
 */
async function claimApplicationForReview(
  tx: PrismaTx,
  applicationId: string,
  reviewerUserId: string,
  reviewNote: string | null,
  targetStatus: "CONFIRMED" | "REJECTED",
): Promise<boolean> {
  const result = await (tx as unknown as PrismaClient).crmCustomerApplication.updateMany({
    where: {
      id: applicationId,
      OR: [
        { supervisorReviewStatus: "PENDING" },
        { adminReviewStatus: "PENDING", supervisorReviewStatus: "NONE" },
      ],
    },
    data: {
      supervisorReviewStatus: targetStatus,
      supervisorReviewedByUserId: reviewerUserId,
      supervisorReviewedAt: new Date(),
      supervisorReviewNote: reviewNote,
      adminReviewStatus: targetStatus,
      adminReviewedByUserId: reviewerUserId,
      adminReviewedAt: new Date(),
      adminReviewNote: reviewNote,
      reviewedByUserId: reviewerUserId,
      reviewedAt: new Date(),
      reviewNote,
      ...(targetStatus === "REJECTED" ? { status: "REJECTED" } : {}),
    },
  });

  return result.count > 0;
}

/**
 * Perform a single confirm-review action.
 *
 * Preconditions (caller must verify):
 *   - user has review permission (canReviewApplication)
 *
 * Returns:
 *   - claimed: false  → the application was already processed by someone else
 *   - claimed: true   → the application was successfully confirmed
 *   - application:    → the updated application record (only when claimed)
 */
export async function confirmCustomerApplicationReview(
  reviewerUserId: string,
  applicationId: string,
  reviewNote: string | null,
): Promise<{ claimed: boolean; application?: Record<string, unknown> | null }> {
  const claimed = await prisma.$transaction(async (tx) => {
    const ok = await claimApplicationForReview(tx, applicationId, reviewerUserId, reviewNote, "CONFIRMED");
    if (!ok) return { claimed: false, application: null };

    const updated = await tx.crmCustomerApplication.findUnique({
      where: { id: applicationId },
      include: applicationInclude,
    });
    return { claimed: true, application: updated };
  });

  return {
    claimed: claimed.claimed,
    application: claimed.application ?? undefined,
  };
}

/**
 * Clean up auto-created CRM profile after a reject-review.
 *
 * Profile-only（§3.7）：createdCrmProfileId 是唯一运行时键；按 Profile relation
 * 检查依赖，有业务依赖时软删（deleted=true），否则硬删。
 *
 * Must run inside the same transaction that claimed the application.
 */
async function cleanupRejectedApplication(
  tx: PrismaTx,
  applicationId: string,
): Promise<void> {
  const app = await (tx as unknown as PrismaClient).crmCustomerApplication.findUnique({
    where: { id: applicationId },
    select: {
      createdCrmProfileId: true,
    },
  });
  if (!app?.createdCrmProfileId) return;

  const profileId = app.createdCrmProfileId;
  const depCounts = await Promise.all([
    tx.project.count({ where: { profileId, deleted: false } }),
    tx.order.count({ where: { profileId } }),
    tx.financeCost.count({ where: { profileId } }),
    tx.customerRelation.count({
      where: {
        OR: [
          { fromProfileId: profileId },
          { toProfileId: profileId },
        ],
      },
    }),
  ]);
  const hasDeps = depCounts.some((c) => c > 0);
  if (hasDeps) {
    await tx.crmCustomerProfile.update({
      where: { id: profileId },
      data: { deleted: true, deletedAt: new Date() },
    });
  } else {
    await tx.crmCustomerProfile.deleteMany({
      where: { id: profileId },
    });
  }
}

/**
 * Perform a single reject-review action.
 *
 * Preconditions (caller must verify):
 *   - user has review permission (canReviewApplication)
 *
 * Returns:
 *   - claimed: false  → the application was already processed by someone else
 *   - claimed: true   → the application was successfully rejected and cleaned up
 */
export async function rejectCustomerApplicationReview(
  reviewerUserId: string,
  applicationId: string,
  reviewNote: string | null,
): Promise<{ claimed: boolean }> {
  const claimed = await prisma.$transaction(async (tx) => {
    const ok = await claimApplicationForReview(tx, applicationId, reviewerUserId, reviewNote, "REJECTED");
    if (!ok) return { claimed: false };

    await cleanupRejectedApplication(tx, applicationId);
    return { claimed: true };
  });

  return claimed;
}

/**
 * Batch-run review actions with per-item permission checks and per-item transactions.
 *
 * Each item is processed in its own transaction so that a failure in one
 * does not roll back successes in the same batch.
 */
export async function runBatchCustomerApplicationReview(
  reviewerUserId: string,
  reviewerRole: string,
  action: "confirm-review" | "reject-review",
  ids: string[],
  reviewNote: string | null,
): Promise<{
  confirmed: number;
  reviewRejected: number;
  skipped: Array<{ id: string; reason: string }>;
  errors: Array<{ id: string; error: string }>;
}> {
  let confirmed = 0;
  let reviewRejected = 0;
  const skipped: Array<{ id: string; reason: string }> = [];
  const errors: Array<{ id: string; error: string }> = [];

  for (const id of ids) {
    try {
      const application = await prisma.crmCustomerApplication.findUnique({
        where: { id },
        select: {
          id: true,
          submittedByUserId: true,
          supervisorReviewStatus: true,
          adminReviewStatus: true,
        },
      });

      if (!application) {
        skipped.push({ id, reason: "申请不存在" });
        continue;
      }

      // Check reviewer permission for this specific application
      const canReview = await canReviewApplication(reviewerUserId, reviewerRole, application);
      if (!canReview) {
        skipped.push({ id, reason: "无复核权限" });
        continue;
      }

      // Check whether the application is still in a reviewable state
      const isReviewable =
        application.supervisorReviewStatus === "PENDING" ||
        (application.adminReviewStatus === "PENDING" && application.supervisorReviewStatus === "NONE");
      if (!isReviewable) {
        skipped.push({ id, reason: "该申请已处理" });
        continue;
      }

      if (action === "confirm-review") {
        const result = await confirmCustomerApplicationReview(reviewerUserId, id, reviewNote);
        if (result.claimed) {
          confirmed++;
        } else {
          skipped.push({ id, reason: "该申请已被处理" });
        }
      } else {
        const result = await rejectCustomerApplicationReview(reviewerUserId, id, reviewNote);
        if (result.claimed) {
          reviewRejected++;
        } else {
          skipped.push({ id, reason: "该申请已被处理" });
        }
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "未知错误";
      errors.push({ id, error: msg });
    }
  }

  return { confirmed, reviewRejected, skipped, errors };
}

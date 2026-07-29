import { prisma } from "@/lib/prisma";
import { getAppUrl } from "@/lib/app-url";
import { sendMailInBackground } from "@/lib/mail";

export const SUPERVISOR_REASON_LABELS: Record<string, string> = {
  NORMAL: "常规复核",
  ORG_CONFLICT: "区域冲突",
  CUSTOMER_CONFLICT: "客户冲突",
  DUPLICATE_OVERRIDE: "重复强制新建",
  ORG_REQUEST: "单位主数据申请",
};

/**
 * Shared resolver: given a submitter userId, return the set of user IDs
 * authorised to review that submitter's applications.
 *
 * Used by notification targeting, list scoping, and PATCH canReview checks
 * so all three paths stay in sync.
 *
 * Walk: User → (by email) Representative → CrmRegionManagerRepresentative →
 * unarchived CrmRegionManager → User (must be REGIONAL_MANAGER or ADMIN).
 * Fallback: all ADMIN user IDs.
 */
export async function getApplicationReviewerUserIds(
  submittedByUserId: string,
): Promise<string[]> {
  const submitter = await prisma.user.findUnique({
    where: { id: submittedByUserId },
    select: { email: true },
  });
  if (!submitter?.email) {
    return getAdminFallbackIds();
  }

  const rep = await prisma.representative.findUnique({
    where: { email: submitter.email },
    select: { id: true },
  });
  if (!rep) {
    return getAdminFallbackIds();
  }

  const links = await prisma.crmRegionManagerRepresentative.findMany({
    where: { representativeId: rep.id },
    select: { managerId: true },
  });
  const managerIds = links.map((l) => l.managerId);
  if (managerIds.length === 0) {
    return getAdminFallbackIds();
  }

  const managers = await prisma.crmRegionManager.findMany({
    where: { id: { in: managerIds }, archived: false },
    select: { userId: true },
  });
  const userIds = managers.map((m) => m.userId);
  if (userIds.length === 0) {
    return getAdminFallbackIds();
  }

  // Only users with REGIONAL_MANAGER or ADMIN role can review
  const supervisors = await prisma.user.findMany({
    where: {
      id: { in: userIds },
      role: { in: ["REGIONAL_MANAGER", "ADMIN"] },
    },
    select: { id: true },
  });

  const deduped = [...new Set(supervisors.map((s) => s.id))];
  return deduped.length > 0 ? deduped : getAdminFallbackIds();
}

/**
 * Reverse companion to getApplicationReviewerUserIds:
 * given a regional manager's userId, return the set of submitter userIds
 * whose applications they are authorised to review.
 *
 * Walk: User → CrmRegionManager → CrmRegionManagerRepresentative →
 * Representative → User (must be REPRESENTATIVE or REGIONAL_MANAGER).
 *
 * Used by the list API so its scope stays in sync with the shared reviewer resolver.
 */
export async function getManagedSubmitterUserIds(
  managerUserId: string,
): Promise<string[]> {
  const manager = await prisma.crmRegionManager.findUnique({
    where: { userId: managerUserId, archived: false },
    include: {
      reps: {
        include: {
          representative: { select: { email: true } },
        },
      },
    },
  });
  if (!manager || manager.reps.length === 0) return [];

  const emails = manager.reps.map((r) => r.representative.email);
  const repUsers = await prisma.user.findMany({
    where: { email: { in: emails }, role: { in: ["REPRESENTATIVE", "REGIONAL_MANAGER"] } },
    select: { id: true },
  });
  return [...new Set(repUsers.map((u) => u.id))];
}

/**
 * Resolve supervisor users for a given submittedByUserId.
 * Delegates to getApplicationReviewerUserIds for the ID set, then hydrates full user objects.
 */
export async function resolveApplicationSupervisors(
  submittedByUserId: string,
): Promise<Array<{ id: string; email: string; name: string }>> {
  const ids = await getApplicationReviewerUserIds(submittedByUserId);
  const users = await prisma.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, email: true, name: true },
  });
  return users.map((u) => ({ id: u.id, email: u.email!, name: u.name }));
}

/**
 * Resolve reviewers for a RepresentativeOrganization binding.
 * Takes representativeId directly — regional manager first, ADMIN fallback.
 */
export async function resolveBindingReviewers(
  representativeId: string,
): Promise<Array<{ id: string; email: string; name: string }>> {
  const links = await prisma.crmRegionManagerRepresentative.findMany({
    where: { representativeId },
    select: { managerId: true },
  });
  const managerIds = links.map((l) => l.managerId);

  if (managerIds.length > 0) {
    const managers = await prisma.crmRegionManager.findMany({
      where: { id: { in: managerIds }, archived: false },
      select: { userId: true },
    });
    const userIds = managers.map((m) => m.userId);
    if (userIds.length > 0) {
      const supervisors = await prisma.user.findMany({
        where: { id: { in: userIds }, email: { not: "" } },
        select: { id: true, email: true, name: true },
      });
      const seen = new Set<string>();
      const deduped: Array<{ id: string; email: string; name: string }> = [];
      for (const s of supervisors) {
        if (!seen.has(s.id)) {
          seen.add(s.id);
          deduped.push({ id: s.id, email: s.email!, name: s.name });
        }
      }
      if (deduped.length > 0) return deduped;
    }
  }

  return getAdminFallback();
}

async function resolveBindingRegionalManagers(
  representativeId: string,
): Promise<Array<{ id: string; email: string; name: string }>> {
  const links = await prisma.crmRegionManagerRepresentative.findMany({
    where: { representativeId },
    select: { managerId: true },
  });
  const managerIds = links.map((l) => l.managerId);
  if (managerIds.length === 0) return [];

  const managers = await prisma.crmRegionManager.findMany({
    where: { id: { in: managerIds }, archived: false },
    select: { userId: true },
  });
  const userIds = managers.map((m) => m.userId);
  if (userIds.length === 0) return [];

  const supervisors = await prisma.user.findMany({
    where: { id: { in: userIds }, role: "REGIONAL_MANAGER", email: { not: "" } },
    select: { id: true, email: true, name: true },
  });

  const seen = new Set<string>();
  const deduped: Array<{ id: string; email: string; name: string }> = [];
  for (const s of supervisors) {
    if (!seen.has(s.id)) {
      seen.add(s.id);
      deduped.push({ id: s.id, email: s.email!, name: s.name });
    }
  }
  return deduped;
}

function getBindingWarningText(warningCodes: string[]): string | null {
  if (warningCodes.includes("ORG_BOUND_BY_OTHER_REP")) {
    return "注意：该机构当前已被其他代表绑定。";
  }
  if (warningCodes.includes("ORG_PENDING_BY_OTHER_REP")) {
    return "注意：该机构当前已有其他代表提交绑定申请。";
  }
  if (warningCodes.includes("ORG_NAME_PENDING_BY_OTHER_REP")) {
    return "注意：已有其他代表提交过同名新机构申请。";
  }
  return null;
}

async function getAdminFallbackIds(): Promise<string[]> {
  const admins = await prisma.user.findMany({
    where: { role: "ADMIN" },
    select: { id: true },
  });
  return admins.map((a) => a.id);
}

async function getAdminFallback(): Promise<Array<{ id: string; email: string; name: string }>> {
  return prisma.user.findMany({
    where: { role: "ADMIN" },
    select: { id: true, email: true, name: true },
  });
}

/**
 * Create in-app notifications for supervisors. Does NOT send email.
 * Email is cron-only via CrmApplicationSupervisorNotification.
 */
export async function notifyApplicationSupervisors(
  applicationId: string,
  reason: string,
): Promise<void> {
  const application = await prisma.crmCustomerApplication.findUnique({
    where: { id: applicationId },
    select: { name: true, organization: true, submittedByUserId: true },
  });
  if (!application) return;

  const supervisors = await resolveApplicationSupervisors(application.submittedByUserId);
  const reasonLabel = SUPERVISOR_REASON_LABELS[reason] || reason;

  for (const supervisor of supervisors) {
    try {
      await prisma.notification.create({
        data: {
          userId: supervisor.id,
          type: "CRM_SUPERVISOR_REVIEW",
          title: "客户申请待复核",
          content: `${application.name}（${application.organization || "-"}）提交了客户申请，原因：${reasonLabel}`,
          link: `/crm/customer-applications?view=review`,
          dedupeKey: `crm-supervisor-review:${applicationId}:${supervisor.id}`,
        },
      });
    } catch (e: unknown) {
      const isDup = typeof e === "object" && e !== null && "code" in e && (e as { code: string }).code === "P2002";
      if (!isDup) console.error(`Failed to notify supervisor ${supervisor.id} for application ${applicationId}:`, e);
    }
  }
}

/**
 * Create in-app notifications for pending org binding review.
 */
export async function notifyBindingReviewers(
  bindingId: string,
  representativeId: string,
  orgName: string,
  warningCodes: string[] = [],
): Promise<void> {
  const regionalManagers = await resolveBindingRegionalManagers(representativeId);
  const admins = await getAdminFallback();
  const warningText = getBindingWarningText(warningCodes);
  const contentBase = `代表申请负责单位「${orgName}」，请审核`;
  const content = warningText ? `${contentBase}。${warningText}` : contentBase;
  const reviewLink = `/crm/representatives/${representativeId}?tab=organizations`;

  for (const reviewer of admins) {
    try {
      await prisma.notification.create({
        data: {
          userId: reviewer.id,
          type: "CRM_ORG_BINDING_REVIEW",
          title: "单位绑定申请",
          content,
          link: reviewLink,
          dedupeKey: `org-binding-review:${bindingId}:${reviewer.id}`,
        },
      });
    } catch (e: unknown) {
      const isDup = typeof e === "object" && e !== null && "code" in e && (e as { code: string }).code === "P2002";
      if (!isDup) console.error(`Failed to notify binding reviewer ${reviewer.id} for binding ${bindingId}:`, e);
    }
  }

  for (const reviewer of regionalManagers) {
    try {
      const notification = await prisma.notification.create({
        data: {
          userId: reviewer.id,
          type: "CRM_ORG_BINDING_REVIEW",
          title: "单位绑定申请",
          content,
          link: reviewLink,
          emailStatus: "pending",
          dedupeKey: `org-binding-review-email:${bindingId}:${reviewer.id}`,
        },
      });

      sendMailInBackground({
        to: reviewer.email,
        subject: `[SciManage] 单位绑定申请待审核：${orgName}`,
        text: `${contentBase}${warningText ? `\n\n${warningText}` : ""}\n\n审核链接：${getAppUrl(reviewLink)}`,
      }, notification.id);
    } catch (e: unknown) {
      const isDup = typeof e === "object" && e !== null && "code" in e && (e as { code: string }).code === "P2002";
      if (!isDup) console.error(`Failed to email regional manager ${reviewer.id} for binding ${bindingId}:`, e);
    }
  }
}

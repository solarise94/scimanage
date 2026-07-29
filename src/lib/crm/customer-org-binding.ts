import { prisma } from "@/lib/prisma";
import { resolveCustomerOrganizationWrite } from "@/lib/customers/customer-organization-write";
import { syncProfileRepresentativeLinks } from "@/lib/crm/customer-representative-sync";

type DbLike = typeof prisma;

export type BindTaskResult =
  | { success: true; profileId: string }
  | { success: false; status: number; message: string };

class BindError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/**
 * 执行单条机构绑定任务（W6.7c：Profile 主体）。
 *
 * - 原子抢占 PENDING → PROCESSING
 * - 直接校验活动 Profile（不再经 Customer/sourceCustomerId 反查）
 * - 写 Profile 机构字段；代表同步走 syncProfileRepresentativeLinks
 * - task.customerId 仅历史审计，不参与绑定决策
 */
export async function executeCustomerOrgBinding(
  taskId: string,
  profileId: string,
  organizationId: string,
  siteId: string | null,
  resolvedById: string,
  resolutionNote: string | null,
  db: DbLike = prisma,
): Promise<BindTaskResult> {
  let outcome: BindTaskResult;

  try {
    outcome = await db.$transaction(async (tx) => {
      const claim = await tx.customerOrgBindingTask.updateMany({
        where: { id: taskId, status: "PENDING" },
        data: { status: "PROCESSING" },
      });
      if (claim.count !== 1) throw new BindError(409, "任务状态已变更或正被处理");

      const profile = await tx.crmCustomerProfile.findUnique({
        where: { id: profileId },
        select: {
          id: true,
          deleted: true,
          archived: true,
          mergedIntoProfileId: true,
          organizationId: true,
          organizationSiteId: true,
        },
      });

      if (
        !profile
        || profile.deleted
        || profile.archived
        || profile.mergedIntoProfileId !== null
      ) {
        await tx.customerOrgBindingTask.update({
          where: { id: taskId },
          data: {
            status: "IGNORED",
            resolvedById,
            resolvedAt: new Date(),
            resolutionNote: "客户档案已合并、删除或归档",
          },
        });
        return { success: false as const, status: 409, message: "客户档案已合并、删除或归档" };
      }

      if (profile.organizationId !== null) {
        await tx.customerOrgBindingTask.update({
          where: { id: taskId },
          data: {
            status: "RESOLVED",
            resolvedOrganizationId: profile.organizationId,
            resolvedSiteId: profile.organizationSiteId ?? null,
            resolvedById,
            resolvedAt: new Date(),
            resolutionNote: "Profile 已绑定机构，自动标记为已处理",
            profileId: profile.id,
          },
        });
        return { success: false as const, status: 409, message: "客户已绑定机构" };
      }

      if (!organizationId) throw new BindError(400, "绑定机构为必填");

      const orgWrite = await resolveCustomerOrganizationWrite(
        { organizationId, organizationSiteId: siteId },
        tx,
      );
      if (!orgWrite.ok) throw new BindError(orgWrite.status, orgWrite.message);

      await tx.crmCustomerProfile.update({
        where: { id: profile.id },
        data: {
          organizationId: orgWrite.organizationId,
          organizationSiteId: orgWrite.organizationSiteId,
          organization: orgWrite.organization,
          organizationRawInput: orgWrite.organizationRawInput,
        },
      });

      await tx.customerOrgBindingTask.update({
        where: { id: taskId },
        data: {
          status: "RESOLVED",
          profileId: profile.id,
          resolvedOrganizationId: orgWrite.organizationId,
          resolvedSiteId: orgWrite.organizationSiteId,
          resolvedById,
          resolvedAt: new Date(),
          resolutionNote,
        },
      });

      return { success: true as const, profileId: profile.id };
    });
  } catch (e) {
    if (e instanceof BindError) return { success: false, status: e.status, message: e.message };
    console.error("executeCustomerOrgBinding error:", e);
    return { success: false, status: 500, message: "绑定失败" };
  }

  if (outcome.success) {
    syncProfileRepresentativeLinks(outcome.profileId).catch(() => {});
  }

  return outcome;
}

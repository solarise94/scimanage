/**
 * Organization reference rebind — migrates all FK references from one
 * Organization to another, used during org merge and customer merge flows.
 *
 * Does NOT touch invoice buyer references (ProjectInvoice.buyerOrganizationId,
 * ExternalOrderInvoiceRequest.buyerOrganizationId) — those are intentionally
 * preserved for historical invoice accuracy.
 */

import { Prisma } from "@prisma/client";

export interface RebindCounts {
  customers: number;
  financeReceipts: number;
  crmApplications: number;
  representativeOrganizations: number;
  customerTextBackfill: number;
  applicationTextBackfill: number;
}

export interface RebindIds {
  profileIds: string[];
  receiptIds: string[];
  applicationIds: string[];
  repOrgIds: string[];
}

export interface RebindResult {
  counts: RebindCounts;
  ids: RebindIds;
}

/**
 * Rebind all references from sourceOrgId to targetOrgId within a transaction.
 *
 * @param tx - Prisma transaction client
 * @param sourceOrgId - Organization being merged away
 * @param targetOrgId - Organization being kept
 * @param targetOrgName - Target org canonicalName for text backfill
 * @param sourceOrgName - Source org canonicalName for text matching
 */
export async function rebindOrganizationReferences(
  tx: Prisma.TransactionClient,
  sourceOrgId: string,
  targetOrgId: string,
  targetOrgName: string,
  sourceOrgName: string,
): Promise<RebindResult> {
  const counts: RebindCounts = {
    customers: 0,
    financeReceipts: 0,
    crmApplications: 0,
    representativeOrganizations: 0,
    customerTextBackfill: 0,
    applicationTextBackfill: 0,
  };

  const ids: RebindIds = {
    profileIds: [],
    receiptIds: [],
    applicationIds: [],
    repOrgIds: [],
  };

  // 1. Customer Profile FK + canonical 快照一并重绑。
  // 不依赖旧 organization 文本恰好等于 sourceOrgName——空快照/漂移快照也写成 target 标准名。
  const profiles = await tx.crmCustomerProfile.findMany({
    where: { organizationId: sourceOrgId },
    select: { id: true },
  });
  if (profiles.length > 0) {
    const profileUpdate = await tx.crmCustomerProfile.updateMany({
      where: { organizationId: sourceOrgId },
      data: { organizationId: targetOrgId, organization: targetOrgName },
    });
    counts.customers = profiles.length;
    counts.customerTextBackfill = profileUpdate.count;
    ids.profileIds = profiles.map((p) => p.id);
  }
  // 2. FinanceReceipt FK rebind (organizationId)
  const receipts = await tx.financeReceipt.findMany({
    where: { organizationId: sourceOrgId },
    select: { id: true },
  });
  if (receipts.length > 0) {
    await tx.financeReceipt.updateMany({
      where: { organizationId: sourceOrgId },
      data: { organizationId: targetOrgId },
    });
    counts.financeReceipts = receipts.length;
    ids.receiptIds = receipts.map((r) => r.id);
  }

  // 3. CrmCustomerApplication FK rebind (organizationId)
  const apps = await tx.crmCustomerApplication.findMany({
    where: { organizationId: sourceOrgId },
    select: { id: true },
  });
  if (apps.length > 0) {
    await tx.crmCustomerApplication.updateMany({
      where: { organizationId: sourceOrgId },
      data: { organizationId: targetOrgId },
    });
    counts.crmApplications = apps.length;
    ids.applicationIds = apps.map((a) => a.id);
  }

  // 4. CrmCustomerApplication text backfill（仍按旧文本匹配，保留 sourceOrgName 语义）
  const appTextBackfill = await tx.crmCustomerApplication.updateMany({
    where: {
      organization: sourceOrgName,
      organizationId: targetOrgId,
    },
    data: { organization: targetOrgName },
  });
  counts.applicationTextBackfill = appTextBackfill.count;

  // 5. RepresentativeOrganization FK rebind (organizationId)
  const repOrgs = await tx.representativeOrganization.findMany({
    where: { organizationId: sourceOrgId },
    select: { id: true },
  });
  if (repOrgs.length > 0) {
    await tx.representativeOrganization.updateMany({
      where: { organizationId: sourceOrgId },
      data: { organizationId: targetOrgId },
    });
    counts.representativeOrganizations = repOrgs.length;
    ids.repOrgIds = repOrgs.map((r) => r.id);
  }

  return { counts, ids };
}

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

type DbLike = Prisma.TransactionClient | typeof prisma;

/**
 * Resolve the display name for a customer's organization.
 * Prefers the canonical name from the org relation (source of truth)
 * over the denormalized text snapshot on the customer record.
 *
 * When an `orgSite` is provided (the customer's bound site), the result is
 * composed as "canonicalName·siteName" so the院系 granularity is preserved
 * (e.g. "浙江大学·医学院" instead of just "浙江大学").
 */
export function getCustomerOrganizationName(customer: {
  organization?: string | null;
  org?: { canonicalName: string } | null;
  orgSite?: { siteName: string } | null;
}): string | null {
  const orgName = customer.org?.canonicalName?.trim() || customer.organization?.trim() || null;
  const siteName = customer.orgSite?.siteName?.trim();
  return orgName && siteName ? `${orgName}·${siteName}` : orgName;
}

/**
 * Fetch a profile's real organization name for snapshot backfill.
 * Returns `org.canonicalName || profile.organization` (composed with the
 * bound site name when available), or null if the profile doesn't exist or
 * has no organization.
 *
 * Accepts a transaction client so it can be called inside `$transaction`.
 */
export async function getProfileOrgForSnapshot(
  profileId: string,
  db: DbLike = prisma,
): Promise<string | null> {
  const profile = await db.crmCustomerProfile.findUnique({
    where: { id: profileId },
    select: {
      organization: true,
      org: { select: { canonicalName: true } },
      orgSite: { select: { siteName: true } },
    },
  });
  if (!profile) return null;
  return getCustomerOrganizationName(profile);
}

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getCustomerOrganizationName } from "@/lib/customer-organization";
import { resolveEffectiveRepresentativesForProfiles } from "@/lib/crm/customer-effective-representative";
import { findActiveProfile } from "@/lib/crm/ids";

type DbLike = Prisma.TransactionClient | typeof prisma;

export interface CustomerBusinessContext {
  profileId: string;
  clientName: string;
  organizationId: string | null;
  organizationName: string | null;
  buyerPhone: string | null;
  buyerWechat: string | null;
  buyerAddress: string | null;
  representativeId: string | null;
  representativeName: string | null;
}

const EMPTY_CONTEXT: CustomerBusinessContext = {
  profileId: "",
  clientName: "",
  organizationId: null,
  organizationName: null,
  buyerPhone: null,
  buyerWechat: null,
  buyerAddress: null,
  representativeId: null,
  representativeName: null,
};

/**
 * Resolve full business context for a CRM profile.
 * Used by project and order creation/editing to populate
 * client, organization, representative, and buyer snapshots.
 *
 * W5.1 / W6.9.2：入参必须是 Profile.id；代表解析只走 Profile resolver。
 */
export async function resolveCustomerBusinessContext(
  profileId: string,
  db: DbLike = prisma,
): Promise<CustomerBusinessContext> {
  const ref = await findActiveProfile(profileId, db);
  if (!ref) return EMPTY_CONTEXT;

  const profile = await db.crmCustomerProfile.findUnique({
    where: { id: ref.profileId },
    select: {
      id: true,
      name: true,
      principal: true,
      wechat: true,
      address: true,
      organization: true,
      organizationId: true,
      organizationSiteId: true,
      org: { select: { canonicalName: true } },
      orgSite: { select: { siteName: true } },
    },
  });

  if (!profile) return EMPTY_CONTEXT;

  const organizationId = profile.organizationId ?? null;
  const organizationName = getCustomerOrganizationName({
    organization: profile.organization,
    org: profile.org,
    orgSite: profile.orgSite,
  });

  const effective = (
    await resolveEffectiveRepresentativesForProfiles([profile.id], db)
  ).get(profile.id);

  return {
    profileId: profile.id,
    clientName: profile.name ?? "",
    organizationId,
    organizationName,
    buyerPhone: profile.principal ?? null,
    buyerWechat: profile.wechat ?? null,
    buyerAddress: profile.address ?? null,
    representativeId: effective?.representativeId ?? null,
    representativeName: effective?.representativeName ?? null,
  };
}

/**
 * Canonical actor-aware representative organization bindings list (T5.1).
 *
 * Shared by Agent `crm.list_my_organizations` and the self-service branch of
 * `GET /api/crm/representative-organizations` (no representativeId filter).
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { BusinessActor } from "@/lib/application/actor";
import { getRepresentativeIdByUserEmail } from "@/lib/crm/permissions";
import { assertCrmAgentReadAccess } from "@/lib/crm/application/crm-agent-access";

export type MyOrganizationListItem = {
  id: string;
  organizationName: string;
  siteName: string;
  status: string;
  isPrimary: string;
};

const BINDING_SELECT = {
  id: true,
  status: true,
  isPrimary: true,
  organization: { select: { canonicalName: true } },
  organizationSite: { select: { siteName: true } },
  requestedOrganizationName: true,
} satisfies Prisma.RepresentativeOrganizationSelect;

type BindingRecord = Prisma.RepresentativeOrganizationGetPayload<{ select: typeof BINDING_SELECT }>;

export function shapeMyOrganizationListItem(binding: BindingRecord): MyOrganizationListItem {
  return {
    id: binding.id,
    organizationName: binding.organization?.canonicalName ?? binding.requestedOrganizationName ?? "",
    siteName: binding.organizationSite?.siteName ?? "",
    status: binding.status,
    isPrimary: binding.isPrimary ? "true" : "false",
  };
}

export async function listMyOrganizationsForActor(
  actor: BusinessActor,
): Promise<{ items: MyOrganizationListItem[] }> {
  assertCrmAgentReadAccess(actor);

  const repId = await getRepresentativeIdByUserEmail(actor.email ?? "");
  if (!repId) return { items: [] };

  const bindings = await prisma.representativeOrganization.findMany({
    where: { representativeId: repId },
    orderBy: { createdAt: "desc" },
    select: BINDING_SELECT,
  });

  return { items: bindings.map(shapeMyOrganizationListItem) };
}

/** Web route include shape for self-service bindings (same query surface). */
export const MY_ORGANIZATION_WEB_INCLUDE = {
  organization: { select: { id: true, canonicalName: true, address: true } },
  organizationSite: { select: { id: true, siteName: true, siteType: true } },
} satisfies Prisma.RepresentativeOrganizationInclude;

export async function listMyOrganizationBindingsForWeb(
  actor: BusinessActor,
): Promise<
  Prisma.RepresentativeOrganizationGetPayload<{ include: typeof MY_ORGANIZATION_WEB_INCLUDE }>[]
> {
  assertCrmAgentReadAccess(actor);

  const repId = await getRepresentativeIdByUserEmail(actor.email ?? "");
  if (!repId) return [];

  return prisma.representativeOrganization.findMany({
    where: { representativeId: repId },
    include: MY_ORGANIZATION_WEB_INCLUDE,
    orderBy: { createdAt: "desc" },
  });
}

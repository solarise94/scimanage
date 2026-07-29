/**
 * Canonical actor-aware "my customer applications" query (T5.1).
 *
 * Shared by Agent `crm.list_my_customer_applications` and the REPRESENTATIVE
 * branch of `GET /api/crm/customer-applications`.
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { BusinessActor } from "@/lib/application/actor";
import { assertCrmRepSelfServiceAccess } from "@/lib/crm/application/crm-agent-access";

export type MyCustomerApplicationItem = {
  id: string;
  name: string;
  status: string;
  supervisorReviewStatus: string;
  createdAt: string;
};

const AGENT_APPLICATION_SELECT = {
  id: true,
  name: true,
  status: true,
  supervisorReviewStatus: true,
  createdAt: true,
} satisfies Prisma.CrmCustomerApplicationSelect;

type ApplicationRecord = Prisma.CrmCustomerApplicationGetPayload<{
  select: typeof AGENT_APPLICATION_SELECT;
}>;

export function shapeMyCustomerApplicationItem(
  application: ApplicationRecord,
): MyCustomerApplicationItem {
  return {
    id: application.id,
    name: application.name,
    status: application.status,
    supervisorReviewStatus: application.supervisorReviewStatus,
    createdAt: application.createdAt.toISOString(),
  };
}

export async function listMyCustomerApplicationsForActor(
  actor: BusinessActor,
  options: { limit?: number } = {},
): Promise<{ items: MyCustomerApplicationItem[] }> {
  assertCrmRepSelfServiceAccess(actor);

  const apps = await prisma.crmCustomerApplication.findMany({
    where: { submittedByUserId: actor.userId },
    orderBy: { createdAt: "desc" },
    ...(options.limit != null ? { take: options.limit } : {}),
    select: AGENT_APPLICATION_SELECT,
  });

  return { items: apps.map(shapeMyCustomerApplicationItem) };
}

/** Scope WHERE for representative self submissions (Web GET parity). */
export function buildRepresentativeOwnApplicationsWhere(
  actor: BusinessActor,
): Prisma.CrmCustomerApplicationWhereInput {
  return { submittedByUserId: actor.userId };
}

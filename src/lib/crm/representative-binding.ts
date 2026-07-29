import { Prisma } from "@prisma/client";

export type RepresentativeBindingTx = Pick<
  Prisma.TransactionClient,
  "organizationSite" | "representativeOrganization"
>;

export interface BindingScope {
  representativeId: string;
  organizationId: string;
  organizationSiteId: string | null;
}

export async function validateRepresentativeBindingScope(
  tx: RepresentativeBindingTx,
  organizationId: string,
  organizationSiteId: string | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!organizationSiteId) {
    return { ok: true };
  }

  const site = await tx.organizationSite.findUnique({
    where: { id: organizationSiteId },
    select: { organizationId: true, archived: true },
  });

  if (!site) {
    return { ok: false, error: "院区不存在" };
  }

  if (site.organizationId !== organizationId) {
    return { ok: false, error: "院区不属于该单位" };
  }

  if (site.archived) {
    return { ok: false, error: "该院区已归档" };
  }

  return { ok: true };
}

export async function findRepresentativeBindingByScope(
  tx: RepresentativeBindingTx,
  scope: BindingScope,
) {
  return tx.representativeOrganization.findFirst({
    where: {
      representativeId: scope.representativeId,
      organizationId: scope.organizationId,
      organizationSiteId: scope.organizationSiteId,
    },
    orderBy: { createdAt: "asc" },
  });
}

export async function hasActiveBindingAtLevel(
  tx: RepresentativeBindingTx,
  organizationId: string,
  organizationSiteId: string | null,
) {
  const existing = await tx.representativeOrganization.findFirst({
    where: {
      organizationId,
      organizationSiteId,
      status: "ACTIVE",
    },
    select: { id: true },
  });

  return !!existing;
}

type MergeableBinding = {
  id: string;
  representativeId: string;
  organizationId: string | null;
  organizationSiteId: string | null;
  status: string;
  isPrimary: boolean;
  reviewNote: string | null;
  reviewedByUserId: string | null;
  reviewedAt: Date | null;
  requestedOrganizationName: string | null;
  requestedOrganizationNormalizedName: string | null;
  organizationReviewTaskId: string | null;
  requestedByUserId: string | null;
};

const BINDING_STATUS_RANK: Record<string, number> = {
  ACTIVE: 4,
  PENDING: 3,
  ARCHIVED: 2,
  REJECTED: 1,
};

function pickPreferredBinding(a: MergeableBinding, b: MergeableBinding) {
  const aRank = BINDING_STATUS_RANK[a.status] ?? 0;
  const bRank = BINDING_STATUS_RANK[b.status] ?? 0;
  if (aRank !== bRank) {
    return aRank > bRank ? a : b;
  }
  if (a.isPrimary !== b.isPrimary) {
    return a.isPrimary ? a : b;
  }
  return a.id < b.id ? a : b;
}

export async function mergeRepresentativeBindingsAtScope(
  tx: RepresentativeBindingTx,
  incoming: MergeableBinding,
  targetScope: { organizationId: string; organizationSiteId: string | null },
) {
  const existing = await findRepresentativeBindingByScope(tx, {
    representativeId: incoming.representativeId,
    organizationId: targetScope.organizationId,
    organizationSiteId: targetScope.organizationSiteId,
  });

  if (!existing || existing.id === incoming.id) {
    return tx.representativeOrganization.update({
      where: { id: incoming.id },
      data: {
        organizationId: targetScope.organizationId,
        organizationSiteId: targetScope.organizationSiteId,
      },
    });
  }

  const preferred = pickPreferredBinding(existing, incoming);
  const duplicate = preferred.id === existing.id ? incoming : existing;

  if (preferred.id === incoming.id && duplicate.organizationSiteId && duplicate.organizationSiteId === targetScope.organizationSiteId) {
    await tx.representativeOrganization.update({
      where: { id: duplicate.id },
      data: {
        organizationSiteId: null,
        status: "ARCHIVED",
        isPrimary: false,
        reviewNote: duplicate.reviewNote ?? "merged_duplicate_binding",
      },
    });
  }

  await tx.representativeOrganization.update({
    where: { id: preferred.id },
    data: {
      organizationId: targetScope.organizationId,
      organizationSiteId: targetScope.organizationSiteId,
      status: BINDING_STATUS_RANK[existing.status] >= BINDING_STATUS_RANK[incoming.status] ? existing.status : incoming.status,
      isPrimary: existing.isPrimary || incoming.isPrimary,
      reviewNote: preferred.reviewNote ?? duplicate.reviewNote,
      reviewedByUserId: preferred.reviewedByUserId ?? duplicate.reviewedByUserId,
      reviewedAt: preferred.reviewedAt ?? duplicate.reviewedAt,
      requestedOrganizationName: preferred.requestedOrganizationName ?? duplicate.requestedOrganizationName,
      requestedOrganizationNormalizedName:
        preferred.requestedOrganizationNormalizedName ?? duplicate.requestedOrganizationNormalizedName,
      organizationReviewTaskId: preferred.organizationReviewTaskId ?? duplicate.organizationReviewTaskId,
      requestedByUserId: preferred.requestedByUserId ?? duplicate.requestedByUserId,
    },
  });

  await tx.representativeOrganization.update({
    where: { id: duplicate.id },
    data: {
      organizationId: duplicate.organizationId,
      status: "ARCHIVED",
      isPrimary: false,
      reviewNote: duplicate.reviewNote ?? "merged_duplicate_binding",
    },
  });

  return tx.representativeOrganization.findUnique({
    where: { id: preferred.id },
  });
}

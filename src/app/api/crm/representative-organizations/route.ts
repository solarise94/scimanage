import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { isRepresentative } from "@/lib/permissions";
import {
  canManageRepresentativeBindings,
  getRepresentativeIdByUserEmail,
  isRegionalManagerRole,
} from "@/lib/crm/permissions";
import { listMyOrganizationBindingsForWeb } from "@/lib/crm/application/list-my-organizations";
import { requestOrganizationBindingForActor } from "@/lib/crm/application/request-organization-binding";
import { businessActorFromSessionUser, buildInvocationContext } from "@/lib/application/actor";
import { ForbiddenError, ValidationError } from "@/lib/application/errors";
import { resolveOrganization } from "@/lib/organization-resolver";
import { syncEffectiveRepresentativeLinksForOrganization } from "@/lib/crm/customer-representative-sync";

function toSafeSyncError(err: unknown): string {
  console.error("[representative-organizations] sync failed", err);
  return "EFFECTIVE_LINKS_SYNC_FAILED";
}
import { notifyBindingReviewers } from "@/lib/crm/supervisor";
import {
  findRepresentativeBindingByScope,
  hasActiveBindingAtLevel,
  validateRepresentativeBindingScope,
} from "@/lib/crm/representative-binding";

type BindingWarningCode =
  | "ORG_BOUND_BY_OTHER_REP"
  | "ORG_PENDING_BY_OTHER_REP"
  | "ORG_NAME_PENDING_BY_OTHER_REP";

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Allow-list: only ADMIN, REPRESENTATIVE, REGIONAL_MANAGER
  const allowedRoles = ["ADMIN", "REPRESENTATIVE", "REGIONAL_MANAGER"];
  if (!allowedRoles.includes(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { searchParams } = req.nextUrl;
  const status = searchParams.get("status")?.trim() || "";
  const representativeId = searchParams.get("representativeId")?.trim() || "";

  if (session.user.role === "ADMIN" && !representativeId) {
    const where: Prisma.RepresentativeOrganizationWhereInput = {};
    if (status && ["ACTIVE", "PENDING", "REJECTED", "ARCHIVED"].includes(status)) {
      where.status = status;
    }
    if (representativeId) where.representativeId = representativeId;

    const bindings = await prisma.representativeOrganization.findMany({
      where,
      include: {
        organization: { select: { id: true, canonicalName: true, address: true } },
        organizationSite: { select: { id: true, siteName: true, siteType: true } },
        representative: { select: { id: true, name: true, email: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    return NextResponse.json({ bindings });
  }

  if (representativeId) {
    const allowed = await canManageRepresentativeBindings(
      session.user.id,
      session.user.role,
      representativeId,
      session.user.email,
    );
    if (!allowed) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const where: Prisma.RepresentativeOrganizationWhereInput = { representativeId };
    if (status && ["ACTIVE", "PENDING", "REJECTED", "ARCHIVED"].includes(status)) {
      where.status = status;
    }

    const bindings = await prisma.representativeOrganization.findMany({
      where,
      include: {
        organization: { select: { id: true, canonicalName: true, address: true } },
        organizationSite: { select: { id: true, siteName: true, siteType: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    return NextResponse.json({ bindings });
  }

  const ownRepresentativeId = await getRepresentativeIdByUserEmail(session.user.email);
  if (!ownRepresentativeId) return NextResponse.json({ bindings: [] });

  try {
    const bindings = await listMyOrganizationBindingsForWeb(
      businessActorFromSessionUser(session.user),
    );
    return NextResponse.json({ bindings });
  } catch (error) {
    if (error instanceof ForbiddenError) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    throw error;
  }
}

function normalizeOrgName(text: string): string {
  return text.replace(/\s+/g, "").toLowerCase();
}

async function collectExistingOrgWarnings(
  representativeId: string,
  organizationId: string,
  organizationSiteId: string | null,
): Promise<BindingWarningCode[]> {
  const warnings: BindingWarningCode[] = [];

  const otherActive = await prisma.representativeOrganization.findFirst({
    where: {
      organizationId,
      organizationSiteId: organizationSiteId ?? null,
      status: "ACTIVE",
      representativeId: { not: representativeId },
    },
    select: { id: true },
  });
  if (otherActive) warnings.push("ORG_BOUND_BY_OTHER_REP");

  const otherPending = await prisma.representativeOrganization.findFirst({
    where: {
      organizationId,
      organizationSiteId: organizationSiteId ?? null,
      status: "PENDING",
      representativeId: { not: representativeId },
    },
    select: { id: true },
  });
  if (otherPending) warnings.push("ORG_PENDING_BY_OTHER_REP");

  return warnings;
}

async function collectRequestedNameWarnings(
  representativeId: string,
  requestedOrganizationNormalizedName: string,
): Promise<BindingWarningCode[]> {
  const otherPending = await prisma.representativeOrganization.findFirst({
    where: {
      representativeId: { not: representativeId },
      organizationId: null,
      requestedOrganizationNormalizedName,
      status: "PENDING",
    },
    select: { id: true },
  });

  return otherPending ? ["ORG_NAME_PENDING_BY_OTHER_REP"] : [];
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Allow-list: only ADMIN, REPRESENTATIVE, REGIONAL_MANAGER
  const allowedRoles = ["ADMIN", "REPRESENTATIVE", "REGIONAL_MANAGER"];
  if (!allowedRoles.includes(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json();
  const { organizationId, canonicalName, representativeId: bodyRepIdRaw, organizationSiteId } = body as Record<string, unknown>;

  if (!organizationId && !canonicalName) {
    return NextResponse.json({ error: "organizationId or canonicalName is required" }, { status: 400 });
  }

  const siteId = (typeof organizationSiteId === "string" && organizationSiteId.trim()) ? organizationSiteId.trim() : null;

  const isAdmin = session.user.role === "ADMIN";
  const bodyRepId =
    bodyRepIdRaw && typeof bodyRepIdRaw === "string" ? bodyRepIdRaw.trim() : "";

  // Self-service PENDING path (REP/RM binding own rep) — shared canonical facade with Agent.
  if (!bodyRepId && !isAdmin) {
    try {
      const result = await requestOrganizationBindingForActor(
        businessActorFromSessionUser(session.user),
        buildInvocationContext({ channel: "web" }),
        {
          organizationId: typeof organizationId === "string" ? organizationId : undefined,
          canonicalName: typeof canonicalName === "string" ? canonicalName : undefined,
          organizationSiteId: siteId ?? undefined,
        },
      );
      return NextResponse.json(
        { binding: result.binding, warningCodes: result.warnings },
        { status: 201 },
      );
    } catch (error) {
      if (error instanceof ForbiddenError) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
      const msg = error instanceof Error ? error.message : "绑定申请失败";
      if (error instanceof ValidationError || msg.includes("必填") || msg.includes("不能")) {
        return NextResponse.json({ error: msg }, { status: 400 });
      }
      if (msg.includes("已存在")) {
        return NextResponse.json({ error: msg }, { status: 409 });
      }
      if (msg.includes("Representative not found")) {
        return NextResponse.json({ error: "Representative not found" }, { status: 404 });
      }
      throw error;
    }
  }

  const isSales = isRepresentative(session.user.role) || isRegionalManagerRole(session.user.role);

  // ADMIN can target any representative. REGIONAL_MANAGER can target managed reps.
  // Without representativeId the request always binds to the caller's own representative record.
  let rep: { id: string; email: string } | null = null;
  if (bodyRepId) {
    const allowed = await canManageRepresentativeBindings(
      session.user.id,
      session.user.role,
      bodyRepId,
      session.user.email,
    );
    if (!allowed) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    rep = await prisma.representative.findUnique({
      where: { id: bodyRepId },
      select: { id: true, email: true },
    });
  } else {
    if (!session.user.email) {
      return NextResponse.json({ error: "当前账号无邮箱，无法解析代表" }, { status: 400 });
    }
    rep = await prisma.representative.findUnique({
      where: { email: session.user.email },
      select: { id: true, email: true },
    });
  }
  if (!rep) return NextResponse.json({ error: "Representative not found" }, { status: 404 });

  const canAutoApproveBinding = isAdmin || (isRegionalManagerRole(session.user.role) && !!bodyRepId);
  const status = canAutoApproveBinding ? "ACTIVE" : "PENDING";
  let warningCodes: BindingWarningCode[] = [];

  let orgId: string | null = (organizationId as string) || null;
  let requestedOrgName: string | null = null;
  let requestedOrganizationNormalizedName: string | null = null;
  const reviewTaskId: string | null = null;

  // If canonicalName provided, resolve organization
  if (!orgId && canonicalName && typeof canonicalName === "string" && canonicalName.trim()) {
    const resolved = await resolveOrganization(canonicalName.trim());
    if (resolved.status === "exact" && resolved.organizationId) {
      orgId = resolved.organizationId;
    } else {
      // New org — task + binding + sourceId backfill in a single transaction
      // to prevent orphan OrganizationReviewTask if binding creation fails.
      const newRequestedOrgName = canonicalName.trim();
      const newRequestedOrgNormalizedName = normalizeOrgName(newRequestedOrgName);
      if (siteId) {
        return NextResponse.json({ error: "新单位绑定申请不能指定院区" }, { status: 400 });
      }
      requestedOrgName = newRequestedOrgName;
      requestedOrganizationNormalizedName = newRequestedOrgNormalizedName;
      warningCodes = await collectRequestedNameWarnings(rep.id, newRequestedOrgNormalizedName);

      // Manual dedup: check existing pending new-org request for same rep + normalized name
      const existingPending = await prisma.representativeOrganization.findFirst({
        where: {
          representativeId: rep.id,
          organizationId: null,
          requestedOrganizationNormalizedName: newRequestedOrgNormalizedName,
          status: "PENDING",
        },
      });
      if (existingPending) {
        return NextResponse.json({ error: "该单位绑定申请已存在，正在等待审核", binding: existingPending }, { status: 409 });
      }

      let newBinding: Prisma.RepresentativeOrganizationGetPayload<{
        include: { organization: { select: { canonicalName: true } } };
      }>;
      try {
        newBinding = await prisma.$transaction(async (tx) => {
          const task = await tx.organizationReviewTask.create({
            data: {
              rawInput: newRequestedOrgName,
              normalizedInput: newRequestedOrgNormalizedName,
              status: "PENDING",
              sourceType: "REP_ORG_BINDING_REQUEST",
              sourceId: "", // backfilled below
            },
          });

          const created = await tx.representativeOrganization.create({
            data: {
              representativeId: rep.id,
              organizationId: null,
              organizationSiteId: null,
              requestedOrganizationName: newRequestedOrgName,
              requestedOrganizationNormalizedName: newRequestedOrgNormalizedName,
              organizationReviewTaskId: task.id,
              status: "PENDING",
              source: isSales ? "REP_REQUEST" : "MANUAL",
              requestedByUserId: session.user.id,
            },
            include: { organization: { select: { canonicalName: true } } },
          });

          await tx.organizationReviewTask.update({
            where: { id: task.id },
            data: { sourceId: created.id },
          });

          return created;
        });
      } catch (e: unknown) {
        const isPrismaUnique = typeof e === "object" && e !== null && "code" in e && (e as { code: string }).code === "P2002";
        if (isPrismaUnique) {
          return NextResponse.json({ error: "绑定已存在" }, { status: 409 });
        }
        throw e;
      }

      notifyBindingReviewers(newBinding.id, rep.id, newRequestedOrgName, warningCodes).catch(() => {});

      return NextResponse.json({ binding: newBinding, warningCodes }, { status: 201 });
    }
  }

  let isPrimary = false;

  // Existing-org flow below
  if (orgId) {
    const scopeValidation = await validateRepresentativeBindingScope(prisma, orgId, siteId);
    if (!scopeValidation.ok) {
      return NextResponse.json({ error: scopeValidation.error }, { status: 400 });
    }

    warningCodes = await collectExistingOrgWarnings(rep.id, orgId, siteId);

    // Service-layer uniqueness check: same rep + same org + same site level
    const existing = await findRepresentativeBindingByScope(prisma, {
      representativeId: rep.id,
      organizationId: orgId,
      organizationSiteId: siteId ?? null,
    });
    if (existing) {
      if (existing.status === "REJECTED" || existing.status === "ARCHIVED") {
        const hasExistingActive = await hasActiveBindingAtLevel(prisma, orgId, siteId ?? null);
        // Re-activate: update existing row
        const updated = await prisma.representativeOrganization.update({
          where: { id: existing.id },
          data: {
            status,
            isPrimary: status === "ACTIVE" ? !hasExistingActive : false,
            reviewNote: null,
            reviewedByUserId: null,
            reviewedAt: null,
          },
          include: { organization: { select: { canonicalName: true } } },
        });
        if (status === "PENDING") {
          notifyBindingReviewers(updated.id, rep.id, updated.organization?.canonicalName || orgId, warningCodes).catch(() => {});
        }
        let autoAssigned = 0;
        let syncError: string | null = null;
        if (status === "ACTIVE" && orgId) {
          try {
            autoAssigned = await syncEffectiveRepresentativeLinksForOrganization({
              organizationId: orgId,
              organizationSiteId: siteId,
            });
          } catch (err) {
            syncError = toSafeSyncError(err);
          }
        }
        return NextResponse.json({
          binding: updated,
          warningCodes,
          autoAssigned,
          syncOk: !syncError,
          ...(syncError ? { syncError } : {}),
        }, { status: syncError ? 207 : 200 });
      }
      return NextResponse.json({ error: "绑定已存在", binding: existing }, { status: 409 });
    }

    // Determine isPrimary: first ACTIVE binding at this level → auto primary
    const hasExistingActive = await hasActiveBindingAtLevel(prisma, orgId, siteId ?? null);
    isPrimary = !hasExistingActive;
  }

  let binding: Prisma.RepresentativeOrganizationGetPayload<{
    include: { organization: { select: { canonicalName: true } } };
  }>;
  try {
    binding = await prisma.representativeOrganization.create({
      data: {
        representativeId: rep.id,
        organizationId: orgId,
        organizationSiteId: siteId,
        isPrimary,
        requestedOrganizationName: requestedOrgName,
        requestedOrganizationNormalizedName,
        organizationReviewTaskId: reviewTaskId,
        status,
        source: isSales ? "REP_REQUEST" : "MANUAL",
        requestedByUserId: session.user.id,
      },
      include: { organization: { select: { canonicalName: true } } },
    });
  } catch (e: unknown) {
    const isPrismaUnique = typeof e === "object" && e !== null && "code" in e && (e as { code: string }).code === "P2002";
    if (isPrismaUnique) {
      return NextResponse.json({ error: "绑定已存在" }, { status: 409 });
    }
    throw e;
  }

  if (status === "PENDING") {
    const orgDisplayName = binding.organization?.canonicalName || requestedOrgName || orgId || "";
    notifyBindingReviewers(binding.id, rep.id, orgDisplayName, warningCodes).catch(() => {});
  }

  let autoAssigned = 0;
  let syncError: string | null = null;
  if (status === "ACTIVE" && orgId) {
    try {
      autoAssigned = await syncEffectiveRepresentativeLinksForOrganization({
        organizationId: orgId,
        organizationSiteId: siteId,
      });
    } catch (err) {
      syncError = toSafeSyncError(err);
    }
  }

  // 绑定行已写入成功，但同步失败时明确返回 partial，避免 UI 当成全成功
  return NextResponse.json({
    binding,
    warningCodes,
    autoAssigned,
    syncOk: !syncError,
    ...(syncError ? { syncError } : {}),
  }, { status: syncError ? 207 : 201 });
}

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { syncProfileRepresentativeLinks } from "@/lib/crm/customer-representative-sync";
import { CUSTOMER_API_AUDIT_TARGETS, logCustomerApiAudit } from "@/lib/customers/customer-api-audit";
import { resolveCanonicalOrganizationBindingFromSiteId } from "@/lib/customers/customer-organization-write";

/**
 * POST /api/customers/batch-assign-site
 *
 * Batch-rebind CRM profiles to an OrganizationSite (院区下钻).
 * Prefer `/api/crm/profiles/batch-assign-site` for new callers.
 *
 * Body: { profileIds: string[], organizationSiteId: string }
 * Legacy `customerIds` is rejected with 400.
 */
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) {
    await logCustomerApiAudit({
      path: "/api/customers/batch-assign-site",
      method: "POST",
      forwardedTo: CUSTOMER_API_AUDIT_TARGETS.PROFILE_COMPAT,
      statusCode: 401,
      callerTag: "batch-assign-site-route",
    });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const currentUser = await prisma.user.findUnique({ where: { id: session.user.id }, select: { role: true } });
  if (!currentUser || currentUser.role !== "ADMIN") {
    await logCustomerApiAudit({
      path: "/api/customers/batch-assign-site",
      method: "POST",
      callerUserId: session.user.id,
      forwardedTo: CUSTOMER_API_AUDIT_TARGETS.PROFILE_COMPAT,
      statusCode: 403,
      callerTag: "batch-assign-site-route",
    });
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  // 旧 *CustomerId(s) 系参数一律 400（键名枚举，避免在源码里引用已废弃契约）。
  const legacyKey = Object.keys((body ?? {}) as Record<string, unknown>).find((k) => /customerids?$/i.test(k));
  if (legacyKey) {
    return NextResponse.json(
      { error: `请使用 profileIds 批量改绑院区（不再接受 ${legacyKey}）` },
      { status: 400 },
    );
  }
  const rawIds = Array.isArray(body?.profileIds) ? body.profileIds : [];
  const profileIds: string[] = Array.from(new Set(
    (rawIds as unknown[]).map((id) => String(id).trim()).filter((id: string) => id.length > 0),
  ));
  if (profileIds.length === 0) {
    return NextResponse.json({ error: "profileIds 不能为空" }, { status: 400 });
  }
  const organizationSiteId = typeof body?.organizationSiteId === "string" ? body.organizationSiteId.trim() : "";
  if (!organizationSiteId) {
    return NextResponse.json({ error: "organizationSiteId 必填" }, { status: 400 });
  }

  const siteResolved = await resolveCanonicalOrganizationBindingFromSiteId(organizationSiteId);
  if (!siteResolved.ok) {
    return NextResponse.json({ error: siteResolved.message }, { status: siteResolved.status });
  }
  const { patch, siteName } = siteResolved;

  const profiles = await prisma.crmCustomerProfile.findMany({
    where: { id: { in: profileIds } },
    select: {
      id: true,
      name: true,
      organizationId: true,
      archived: true,
      deleted: true,
    },
  });
  const foundIds = new Set(profiles.map((p) => p.id));
  const missing = profileIds.filter((id) => !foundIds.has(id));
  if (missing.length > 0) {
    return NextResponse.json({ error: "部分客户无 CRM 档案", missing }, { status: 400 });
  }

  const deleted = profiles.filter((p) => p.deleted).map((p) => ({ id: p.id, name: p.name }));
  if (deleted.length > 0) {
    return NextResponse.json({ error: "部分客户已删除，无法改绑", deleted }, { status: 400 });
  }

  const archived = profiles.filter((p) => p.archived).map((p) => ({ id: p.id, name: p.name }));
  if (archived.length > 0) {
    return NextResponse.json({ error: "部分客户已归档，无法改绑", archived }, { status: 400 });
  }

  const mismatched = profiles
    .filter((p) => p.organizationId !== patch.organizationId)
    .map((p) => ({ id: p.id, name: p.name, organizationId: p.organizationId }));
  if (mismatched.length > 0) {
    return NextResponse.json(
      { error: "部分客户不属于该院区所在机构，无法挂载", mismatched, siteOrganizationId: patch.organizationId },
      { status: 400 },
    );
  }

  try {
    const updatedCount = await prisma.$transaction(
      async (tx) => {
        const update = await tx.crmCustomerProfile.updateMany({
          where: { id: { in: profileIds }, archived: false, deleted: false },
          data: {
            organizationSiteId: patch.organizationSiteId,
            organizationId: patch.organizationId,
            organization: patch.organization,
          },
        });

        if (update.count !== profileIds.length) {
          throw new Error(`批量挂院区部分失败：期望 ${profileIds.length}，实际 ${update.count}`);
        }

        for (const id of profileIds) {
          const synced = await syncProfileRepresentativeLinks(id, tx);
          if (synced.skipped) {
            throw new Error(
              synced.reason === "PROFILE_NOT_ASSIGNABLE"
                ? `客户 ${id} 处于冻结状态，无法同步代表缓存`
                : `客户 ${id} 代表同步失败`,
            );
          }
        }

        await tx.activityLog.create({
          data: {
            type: "CUSTOMER_BATCH_ASSIGN_SITE",
            content: `批量挂院区「${siteName}」（${update.count} 个客户）`,
            metadata: JSON.stringify({
              organizationSiteId: patch.organizationSiteId,
              siteName,
              organizationId: patch.organizationId,
              organization: patch.organization,
              profileIds,
              updated: update.count,
              fieldsTouched: ["organizationSiteId", "organizationId", "organization"],
            }),
            userId: session.user.id,
          },
        });

        return update.count;
      },
      { timeout: 30000, maxWait: 10000 },
    );

    await logCustomerApiAudit({
      path: "/api/customers/batch-assign-site",
      method: "POST",
      callerUserId: session.user.id,
      fieldsTouched: ["organizationSiteId", "organizationId", "organization"],
      forwardedTo: CUSTOMER_API_AUDIT_TARGETS.PROFILE_COMPAT,
      statusCode: 200,
      callerTag: "batch-assign-site-route",
    });
    return NextResponse.json({ updated: updatedCount, organizationSiteId: patch.organizationSiteId });
  } catch (error) {
    console.error(error);
    const message = error instanceof Error ? error.message : "批量挂院区失败";
    await logCustomerApiAudit({
      path: "/api/customers/batch-assign-site",
      method: "POST",
      callerUserId: session.user.id,
      fieldsTouched: ["organizationSiteId", "organizationId", "organization"],
      forwardedTo: CUSTOMER_API_AUDIT_TARGETS.PROFILE_COMPAT,
      statusCode: message.includes("冻结") || message.includes("代表同步") || message.includes("部分失败") ? 409 : 500,
      callerTag: "batch-assign-site-route",
    });
    if (message.includes("冻结") || message.includes("代表同步") || message.includes("部分失败")) {
      return NextResponse.json({ error: message }, { status: 409 });
    }
    return NextResponse.json({ error: "批量挂院区失败" }, { status: 500 });
  }
}

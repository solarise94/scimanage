import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertProfileEditable, assertProfileReadable } from "@/lib/customers/permissions";
import { resolveCustomerOrganizationWrite } from "@/lib/customers/customer-organization-write";
import { syncProfileRepresentativeLinks } from "@/lib/crm/customer-representative-sync";
import { toPinyinToneless } from "@/lib/crm/pinyin";
import { CUSTOMER_API_AUDIT_TARGETS, logCustomerApiAudit, extractCustomerApiAuditContext } from "@/lib/customers/customer-api-audit";
import { buildLegacyCustomerFields, customerCrmProfileSelect } from "@/lib/customers/customer-business-fields";

/**
 * W6.9.4：路径参数 `id` 只认 Profile.id（与 projects 页 / CustomerSelect 一致）。
 * 不再接受 Customer.id，也不经 sourceCustomerId 反查。
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auditCtx = extractCustomerApiAuditContext(req);
  const session = await getServerSession(authOptions);
  if (!session) {
    await logCustomerApiAudit({
      path: "/api/customers/[id]",
      method: "GET",
      forwardedTo: CUSTOMER_API_AUDIT_TARGETS.PROFILE_COMPAT,
      statusCode: 401,
      callerTag: "customer-detail-route",
      ...auditCtx,
    });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: profileId } = await params;

  const readable = await assertProfileReadable(profileId, session.user.id, session.user.role);
  if (!readable.ok) {
    await logCustomerApiAudit({
      path: "/api/customers/[id]",
      method: "GET",
      callerUserId: session.user.id,
      profileId,
      forwardedTo: CUSTOMER_API_AUDIT_TARGETS.PROFILE_COMPAT,
      statusCode: readable.status,
      callerTag: "customer-detail-route",
      ...auditCtx,
    });
    return NextResponse.json({ error: readable.message }, { status: readable.status });
  }

  const profile = await prisma.crmCustomerProfile.findUnique({
    where: { id: profileId, deleted: false },
    select: customerCrmProfileSelect,
  });

  if (!profile) {
    return NextResponse.json({ error: "客户不存在" }, { status: 404 });
  }

  const biz = buildLegacyCustomerFields({ crmProfile: profile });
  await logCustomerApiAudit({
    path: "/api/customers/[id]",
    method: "GET",
    callerUserId: session.user.id,
    profileId,
    forwardedTo: CUSTOMER_API_AUDIT_TARGETS.PROFILE_COMPAT,
    statusCode: 200,
    callerTag: "customer-detail-route",
    ...auditCtx,
  });
  return NextResponse.json({
    customer: {
      id: profileId,
      profileId,
      ...biz,
    },
  });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auditCtx = extractCustomerApiAuditContext(req);
  const session = await getServerSession(authOptions);
  if (!session) {
    await logCustomerApiAudit({
      path: "/api/customers/[id]",
      method: "PATCH",
      forwardedTo: CUSTOMER_API_AUDIT_TARGETS.PROFILE_COMPAT,
      statusCode: 401,
      callerTag: "customer-detail-route",
      ...auditCtx,
    });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: profileId } = await params;

  const editable = await assertProfileEditable(profileId, session.user.id, session.user.role);
  if (!editable.ok) {
    await logCustomerApiAudit({
      path: "/api/customers/[id]",
      method: "PATCH",
      callerUserId: session.user.id,
      profileId,
      forwardedTo: CUSTOMER_API_AUDIT_TARGETS.PROFILE_COMPAT,
      statusCode: editable.status,
      callerTag: "customer-detail-route",
      ...auditCtx,
    });
    return NextResponse.json({ error: editable.message }, { status: editable.status });
  }

  try {
    const existing = await prisma.crmCustomerProfile.findUnique({
      where: { id: profileId },
      select: {
        id: true,
        deleted: true,
        name: true,
        organizationId: true,
        organizationSiteId: true,
        organization: true,
      },
    });
    if (!existing || existing.deleted) {
      return NextResponse.json({ error: "客户不存在" }, { status: 404 });
    }

    const body = await req.json();
    const {
      name, principal, email, wechat, organization, address, miniProgramId,
      archived, organizationId, organizationSiteId, organizationRawInput, labOrGroup,
    } = body;

    const profileData: Record<string, unknown> = {};

    if (name !== undefined) {
      if (!name.trim()) {
        return NextResponse.json({ error: "客户姓名不能为空" }, { status: 400 });
      }
      profileData.name = name.trim();
      // namePinyin 与 name 同源计算，保证 name 变更后索引同步（空串写 null）。
      profileData.namePinyin = toPinyinToneless(name.trim()) || null;
    }
    if (principal !== undefined) profileData.principal = principal?.trim() || null;
    if (email !== undefined) profileData.email = email?.trim() || null;
    if (wechat !== undefined) profileData.wechat = wechat?.trim() || null;
    if (address !== undefined) profileData.address = address?.trim() || null;
    if (miniProgramId !== undefined) profileData.miniProgramId = miniProgramId?.trim() || null;
    if (labOrGroup !== undefined) profileData.labOrGroup = labOrGroup || null;

    const touchedOrganization =
      organization !== undefined ||
      organizationId !== undefined ||
      organizationSiteId !== undefined ||
      organizationRawInput !== undefined;

    if (touchedOrganization) {
      const orgWrite = await resolveCustomerOrganizationWrite({
        organizationId: organizationId !== undefined ? organizationId : existing.organizationId,
        organizationSiteId: organizationSiteId !== undefined ? organizationSiteId : existing.organizationSiteId,
        organizationText: typeof organization === "string" ? organization : undefined,
        organizationRawInput: typeof organizationRawInput === "string" ? organizationRawInput : undefined,
        existingOrganizationId: existing.organizationId,
      });

      if (!orgWrite.ok) {
        return NextResponse.json({ error: orgWrite.message }, { status: orgWrite.status });
      }

      profileData.organization = orgWrite.organization;
      profileData.organizationId = orgWrite.organizationId;
      profileData.organizationSiteId = orgWrite.organizationSiteId;
      profileData.organizationRawInput = orgWrite.organizationRawInput;
    }

    if (archived !== undefined) {
      if (session.user.role !== "ADMIN") {
        return NextResponse.json({ error: "仅管理员可归档客户" }, { status: 403 });
      }
      profileData.archived = archived;
    }

    const select = {
      id: true,
      name: true,
      customerCode: true,
      principal: true,
      email: true,
      wechat: true,
      organization: true,
      address: true,
      miniProgramId: true,
      labOrGroup: true,
      organizationId: true,
      organizationSiteId: true,
      organizationRawInput: true,
      archived: true,
    } as const;

    const nameChanged = name !== undefined && name.trim() !== existing.name;

    const updatedProfile = await prisma.$transaction(async (tx) => {
      const updated = Object.keys(profileData).length > 0
        ? await tx.crmCustomerProfile.update({
            where: { id: profileId },
            data: profileData,
            select,
          })
        : await tx.crmCustomerProfile.findUniqueOrThrow({
            where: { id: profileId },
            select,
          });

      if (nameChanged) {
        await tx.project.updateMany({
          where: { profileId },
          data: { client: name.trim() },
        });
      }

      if (touchedOrganization) {
        const synced = await syncProfileRepresentativeLinks(profileId, tx);
        if (synced.skipped) {
          throw new Error(
            synced.reason === "PROFILE_NOT_ASSIGNABLE"
              ? "客户处于冻结状态，无法同步代表缓存"
              : "代表同步失败",
          );
        }
      }

      return updated;
    });

    await logCustomerApiAudit({
      path: "/api/customers/[id]",
      method: "PATCH",
      callerUserId: session.user.id,
      profileId,
      fieldsTouched: Object.keys(profileData),
      forwardedTo: CUSTOMER_API_AUDIT_TARGETS.PROFILE_COMPAT,
      statusCode: 200,
      callerTag: "customer-detail-route",
      ...auditCtx,
    });
    return NextResponse.json({
      customer: {
        profileId,
        ...updatedProfile,
        id: profileId,
      },
    });
  } catch (error) {
    console.error(error);
    const message = error instanceof Error ? error.message : "更新客户失败";
    if (
      message.includes("冻结")
      || message.includes("代表同步")
    ) {
      return NextResponse.json({ error: message }, { status: 409 });
    }
    return NextResponse.json({ error: "更新客户失败" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auditCtx = extractCustomerApiAuditContext(req);
  const session = await getServerSession(authOptions);
  if (!session) {
    await logCustomerApiAudit({
      path: "/api/customers/[id]",
      method: "DELETE",
      forwardedTo: CUSTOMER_API_AUDIT_TARGETS.CUSTOMER_LIFECYCLE,
      statusCode: 401,
      callerTag: "customer-detail-route",
      ...auditCtx,
    });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (session.user.role !== "ADMIN") {
    await logCustomerApiAudit({
      path: "/api/customers/[id]",
      method: "DELETE",
      callerUserId: session.user.id,
      profileId: (await params).id,
      forwardedTo: CUSTOMER_API_AUDIT_TARGETS.CUSTOMER_LIFECYCLE,
      statusCode: 403,
      callerTag: "customer-detail-route",
      ...auditCtx,
    });
    return NextResponse.json({ error: "仅管理员可删除客户" }, { status: 403 });
  }
  const { id: profileId } = await params;

  try {
    const existing = await prisma.crmCustomerProfile.findUnique({
      where: { id: profileId },
      select: {
        id: true,
        deleted: true,
        _count: {
          select: {
            profileProjects: true,
            profileOrders: true,
            profileExternalOrders: true,
            profileFinanceCosts: true,
            profileFinanceReceipts: true,
          },
        },
      },
    });
    if (!existing || existing.deleted) {
      return NextResponse.json({ error: "客户不存在" }, { status: 404 });
    }

    // 有业务绑定的 Profile 只能归档，不能硬软删主数据入口
    const {
      profileProjects,
      profileOrders,
      profileExternalOrders,
      profileFinanceCosts,
      profileFinanceReceipts,
    } = existing._count;
    if (
      profileProjects > 0
      || profileOrders > 0
      || profileExternalOrders > 0
      || profileFinanceCosts > 0
      || profileFinanceReceipts > 0
    ) {
      return NextResponse.json(
        { error: "该客户仍关联项目、订单、成本或回款记录，请先迁移或归档" },
        { status: 400 },
      );
    }

    await prisma.crmCustomerProfile.update({
      where: { id: profileId },
      data: { deleted: true, deletedAt: new Date(), archived: true },
    });

    await logCustomerApiAudit({
      path: "/api/customers/[id]",
      method: "DELETE",
      callerUserId: session.user.id,
      profileId,
      fieldsTouched: ["deleted", "deletedAt", "archived"],
      forwardedTo: CUSTOMER_API_AUDIT_TARGETS.CUSTOMER_LIFECYCLE,
      statusCode: 200,
      callerTag: "customer-detail-route",
      ...auditCtx,
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: "删除客户失败" }, { status: 500 });
  }
}

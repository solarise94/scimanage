import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { normalizeOrgName, normalizeSiteName } from "@/lib/organization-normalize";
import { isRepresentative } from "@/lib/permissions";
import { buildOrganizationInvoiceFieldsOnTaxIdChange } from "@/lib/organization-invoice-fields";

async function assertAdmin(session: { user: { id: string; role: string } } | null) {
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = await prisma.user.findUnique({ where: { id: session.user.id }, select: { role: true } });
  if (!user || user.role !== "ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  return null;
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const org = await prisma.organization.findUnique({
    where: { id },
    select: {
      id: true,
      orgCode: true,
      canonicalName: true,
      normalizedName: true,
      address: true,
      taxId: true,
      isInvoiceSubject: true,
      invoiceAddress: true,
      invoicePhone: true,
      invoiceBankName: true,
      invoiceBankAccount: true,
      orgDataSource: true,
      taxIdVerifySource: true,
      taxIdVerifiedAt: true,
      archived: true,
      aliases: true,
      sites: {
        where: { archived: false },
        select: {
          id: true,
          siteName: true,
          siteType: true,
          address: true,
          lat: true,
          lng: true,
          _count: { select: { crmProfiles: { where: { deleted: false } } } },
        },
        orderBy: { siteName: "asc" },
      },
      _count: { select: { crmProfiles: true } },
    },
  });
  if (!org) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (isRepresentative(session.user.role)) {
    return NextResponse.json({
      organization: {
        id: org.id,
        canonicalName: org.canonicalName,
        address: org.address,
        sites: org.sites.map((s) => ({ id: s.id, siteName: s.siteName, siteType: s.siteType })),
      },
    });
  }

  return NextResponse.json({ organization: org });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  const forbidden = await assertAdmin(session);
  if (forbidden) return forbidden;

  const { id } = await params;

  try {
    const existing = await prisma.organization.findUnique({ where: { id } });
    if (!existing || existing.deleted) {
      return NextResponse.json({ error: "机构不存在" }, { status: 404 });
    }

    const body = await req.json();
    const {
      canonicalName,
      address,
      taxId,
      archived,
      isInvoiceSubject,
      invoiceAddress,
      invoicePhone,
      invoiceBankName,
      invoiceBankAccount,
      addAlias,
      addAliases,
      removeAliasId,
      addSite,
      addSites,
      removeSiteId,
    } = body;

    const data: Record<string, unknown> = {};
    if (canonicalName !== undefined) {
      if (!canonicalName.trim()) {
        return NextResponse.json({ error: "标准名称不能为空" }, { status: 400 });
      }
      data.canonicalName = canonicalName.trim();
      data.normalizedName = normalizeOrgName(canonicalName.trim());
    }
    if (address !== undefined) data.address = address?.trim() || null;

    const lookupName = canonicalName?.trim() || existing.canonicalName;
    const invoicePatch = await buildOrganizationInvoiceFieldsOnTaxIdChange({
      taxId,
      isInvoiceSubject,
      invoiceAddress,
      invoicePhone,
      invoiceBankName,
      invoiceBankAccount,
      lookupName,
      existingTaxId: existing.taxId,
    });
    Object.assign(data, invoicePatch);
    // 修复点 A：归档机构时阻断仍有关联客户的情况（对齐 DELETE 的严格性）
    if (archived === true) {
      const customerCount = await prisma.crmCustomerProfile.count({
        where: { deleted: false, organizationId: id },
      });
      if (customerCount > 0) {
        return NextResponse.json(
          { error: `该机构仍有 ${customerCount} 个关联客户，请先迁移客户再归档` },
          { status: 409 },
        );
      }
    }
    if (archived !== undefined) data.archived = archived;

    await prisma.organization.update({ where: { id }, data });

    // Add aliases
    const aliasesToAdd = [
      ...(addAlias?.trim() ? [addAlias.trim()] : []),
      ...(Array.isArray(addAliases) ? addAliases : []),
    ]
      .map((alias) => (typeof alias === "string" ? alias.trim() : ""))
      .filter(Boolean);
    for (const alias of aliasesToAdd) {
      const normalizedAlias = normalizeOrgName(alias);
      const exists = await prisma.organizationAlias.findFirst({
        where: { organizationId: id, normalizedAlias },
        select: { id: true },
      });
      if (!exists) {
        await prisma.organizationAlias.create({
          data: {
            organizationId: id,
            alias,
            normalizedAlias,
          },
        });
      }
    }

    // Remove alias (verify it belongs to this organization)
    if (removeAliasId) {
      const alias = await prisma.organizationAlias.findUnique({ where: { id: removeAliasId } });
      if (!alias || alias.organizationId !== id) {
        return NextResponse.json({ error: "别名不属于该机构" }, { status: 400 });
      }
      // Guard: if any customer still references this alias text as their
      // organizationRawInput, deleting it would leave them unresolvable and
      // a later import/auto-create could spawn a standalone orphan org.
      const referencedByCustomers = await prisma.crmCustomerProfile.count({
        where: { deleted: false, organizationRawInput: alias.alias },
      });
      if (referencedByCustomers > 0) {
        return NextResponse.json(
          { error: `仍有 ${referencedByCustomers} 个客户引用该别名（原始输入），删除后会导致单位无法解析，请先迁移这些客户` },
          { status: 409 },
        );
      }
      await prisma.organizationAlias.delete({ where: { id: removeAliasId } });
    }

    // Add sites
    const sitesToAdd = [
      ...(addSite?.siteName?.trim() ? [addSite] : []),
      ...(Array.isArray(addSites) ? addSites : []),
    ].filter((site) => site?.siteName?.trim());
    for (const siteToAdd of sitesToAdd) {
      // Validate parentSiteId belongs to the same organization
      if (siteToAdd.parentSiteId) {
        const parentSite = await prisma.organizationSite.findUnique({ where: { id: siteToAdd.parentSiteId }, select: { organizationId: true } });
        if (!parentSite || parentSite.organizationId !== id) {
          return NextResponse.json({ error: "父级院区不属于同一单位" }, { status: 400 });
        }
      }
      const normalizedSiteName = normalizeSiteName(siteToAdd.siteName.trim());
      const existingSite = await prisma.organizationSite.findFirst({
        where: { organizationId: id, normalizedSiteName },
      });
      if (existingSite && !existingSite.archived) {
        return NextResponse.json({ error: `已存在同名院区: ${existingSite.siteName}` }, { status: 409 });
      }
      if (existingSite && existingSite.archived) {
        // Un-archive the existing site
        await prisma.organizationSite.update({
          where: { id: existingSite.id },
          data: { archived: false, siteName: siteToAdd.siteName.trim(), siteType: siteToAdd.siteType || "CAMPUS", parentSiteId: siteToAdd.parentSiteId || null, address: siteToAdd.address?.trim() || null },
        });
      } else {
        await prisma.organizationSite.create({
          data: {
            organizationId: id,
            siteName: siteToAdd.siteName.trim(),
            normalizedSiteName,
            siteType: siteToAdd.siteType || "CAMPUS",
            parentSiteId: siteToAdd.parentSiteId || null,
            address: siteToAdd.address?.trim() || null,
          },
        });
      }
    }

    // Remove site (verify it belongs to this organization)
    if (removeSiteId) {
      const site = await prisma.organizationSite.findUnique({ where: { id: removeSiteId } });
      if (!site || site.organizationId !== id) {
        return NextResponse.json({ error: "院区不属于该机构" }, { status: 400 });
      }
      await prisma.organizationSite.update({
        where: { id: removeSiteId },
        data: { archived: true },
      });
    }

    // Re-fetch with relations
    const result = await prisma.organization.findUnique({
      where: { id },
      include: {
        aliases: true,
        sites: { where: { archived: false } },
        _count: { select: { crmProfiles: true } },
      },
    });

    return NextResponse.json({ organization: result });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: "更新机构失败" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  const forbidden = await assertAdmin(session);
  if (forbidden) return forbidden;

  const { id } = await params;

  try {
    const existing = await prisma.organization.findUnique({
      where: { id },
      include: { _count: { select: { crmProfiles: true } } },
    });
    if (!existing || existing.deleted) {
      return NextResponse.json({ error: "机构不存在" }, { status: 404 });
    }

    if (existing._count.crmProfiles > 0) {
      return NextResponse.json({ error: "该机构仍有关联客户，请先归档" }, { status: 400 });
    }

    await prisma.organization.update({
      where: { id },
      data: { deleted: true },
    });

    return NextResponse.json({ deleted: true });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: "删除机构失败" }, { status: 500 });
  }
}

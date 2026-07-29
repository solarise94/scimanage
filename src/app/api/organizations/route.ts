import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { normalizeOrgName, normalizeSiteName } from "@/lib/organization-normalize";
import { buildOrganizationInvoiceFieldsOnTaxIdChange } from "@/lib/organization-invoice-fields";

async function assertAdmin(session: { user: { id: string; role: string } } | null) {
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // Real-time role check — JWT role may be stale
  const user = await prisma.user.findUnique({ where: { id: session.user.id }, select: { role: true } });
  if (!user || user.role !== "ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  return null;
}

async function generateOrgCode(): Promise<string> {
  const count = await prisma.organization.count();
  for (let i = 0; i < 10; i++) {
    const code = `ORG-${String(count + 1 + i).padStart(5, "0")}`;
    const exists = await prisma.organization.findUnique({ where: { orgCode: code }, select: { id: true } });
    if (!exists) return code;
  }
  return `ORG-${String(Date.now() % 100000).padStart(5, "0")}`;
}

export async function GET() {
  const session = await getServerSession(authOptions);
  const forbidden = await assertAdmin(session);
  if (forbidden) return forbidden;

  const orgs = await prisma.organization.findMany({
    where: { deleted: false },
    include: {
      aliases: true,
      sites: { where: { archived: false } },
      _count: { select: { crmProfiles: true } },
    },
    orderBy: [{ archived: "asc" }, { canonicalName: "asc" }],
  });

  return NextResponse.json({ organizations: orgs });
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  const forbidden = await assertAdmin(session);
  if (forbidden) return forbidden;

  try {
    const body = await req.json();
    const {
      canonicalName,
      address,
      aliases,
      sites,
      taxId,
      isInvoiceSubject,
      invoiceAddress,
      invoicePhone,
      invoiceBankName,
      invoiceBankAccount,
    } = body;

    if (!canonicalName?.trim()) {
      return NextResponse.json({ error: "标准名称为必填项" }, { status: 400 });
    }

    const trimmedName = canonicalName.trim();
    const normalizedName = normalizeOrgName(trimmedName);

    // Check for duplicate before external invoice API lookup
    const existing = await prisma.organization.findFirst({
      where: { normalizedName, deleted: false },
    });
    if (existing) {
      return NextResponse.json({ error: `已存在同名机构: ${existing.canonicalName}` }, { status: 409 });
    }

    const invoicePatch = await buildOrganizationInvoiceFieldsOnTaxIdChange({
      taxId,
      isInvoiceSubject,
      invoiceAddress,
      invoicePhone,
      invoiceBankName,
      invoiceBankAccount,
      lookupName: trimmedName,
      isCreate: true,
    });

    const orgCode = await generateOrgCode();

    const org = await prisma.organization.create({
      data: {
        orgCode,
        canonicalName: trimmedName,
        normalizedName,
        address: address?.trim() || null,
        ...invoicePatch,
        aliases: aliases?.length ? {
          create: (aliases as string[]).filter(Boolean).map((a: string) => ({
            alias: a.trim(),
            normalizedAlias: normalizeOrgName(a.trim()),
          })),
        } : undefined,
        sites: sites?.length ? {
          create: (() => {
            const siteData = (sites as Array<{ siteName: string; address?: string; siteType?: string }>).filter((s) => s.siteName?.trim());
            const seen = new Set<string>();
            const deduped = siteData.filter((s) => {
              const norm = normalizeSiteName(s.siteName.trim());
              if (seen.has(norm)) return false;
              seen.add(norm);
              return true;
            });
            return deduped.map((s) => ({
              siteName: s.siteName.trim(),
              normalizedSiteName: normalizeSiteName(s.siteName.trim()),
              siteType: s.siteType || "CAMPUS",
              address: s.address?.trim() || null,
            }));
          })(),
        } : undefined,
      },
      include: { aliases: true, sites: true },
    });

    return NextResponse.json({ organization: org }, { status: 201 });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: "创建机构失败" }, { status: 500 });
  }
}

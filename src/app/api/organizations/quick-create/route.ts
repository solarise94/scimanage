import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isRepresentative } from "@/lib/permissions";
import { normalizeOrgName } from "@/lib/organization-normalize";
import { lookupOrgByName } from "@/lib/invoice-org-api";

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const isRep = isRepresentative(session.user.role);

  try {
    const body = await req.json();
    const { canonicalName, address } = body;

    if (!canonicalName?.trim()) {
      return NextResponse.json({ error: "单位名称不能为空" }, { status: 400 });
    }

    const trimmedName = canonicalName.trim();
    const normalizedName = normalizeOrgName(trimmedName);

    // 1. Search DB first
    const existing = await prisma.organization.findFirst({
      where: {
        deleted: false,
        OR: [
          { normalizedName },
          { aliases: { some: { normalizedAlias: normalizedName, approved: true } } },
        ],
      },
      orderBy: [{ archived: "asc" }, { createdAt: "asc" }],
      select: { id: true, orgCode: true, canonicalName: true, address: true, taxId: true, isInvoiceSubject: true, archived: true },
    });

    if (existing) {
      if (existing.archived) {
        return NextResponse.json(
          { error: `同名单位 "${existing.canonicalName}" 已归档，请联系管理员恢复` },
          { status: 400 },
        );
      }
      return NextResponse.json({
        organization: { id: existing.id, orgCode: existing.orgCode, canonicalName: existing.canonicalName, address: existing.address },
        created: false,
      });
    }

    // 2. Call invoice API (try to verify by name)
    let apiResult: { unitName: string; unitTaxNo: string; unitAddress: string; unitPhone: string; bankName: string; bankNo: string } | null = null;
    try {
      const results = await lookupOrgByName(trimmedName);
      if (results.length > 0) {
        apiResult = results[0]; // highest frequency
      }
    } catch {
      // API unavailable — continue with manual flow
    }

    if (apiResult && apiResult.unitTaxNo) {
      // 3. API hit — dedup by taxId
      const taxIdExisting = await prisma.organization.findFirst({
        where: { taxId: apiResult.unitTaxNo, deleted: false },
        select: { id: true, orgCode: true, canonicalName: true, address: true, isInvoiceSubject: true },
      });

      if (taxIdExisting) {
        // Attach to existing subject
        return NextResponse.json({
          organization: { id: taxIdExisting.id, orgCode: taxIdExisting.orgCode, canonicalName: taxIdExisting.canonicalName, address: taxIdExisting.address },
          created: false,
          invoiceFound: true,
        });
      }

      // Create new invoice subject
      const oc = await prisma.organization.count();
      const ocCode = await generateOrgCode(oc);
      const organization = await prisma.organization.create({
        data: {
          orgCode: ocCode,
          canonicalName: apiResult.unitName,
          normalizedName: normalizeOrgName(apiResult.unitName),
          address: apiResult.unitAddress || address?.trim() || null,
          taxId: apiResult.unitTaxNo,
          invoiceAddress: apiResult.unitAddress || null,
          invoicePhone: apiResult.unitPhone || null,
          invoiceBankName: apiResult.bankName || null,
          invoiceBankAccount: apiResult.bankNo || null,
          isInvoiceSubject: true,
          taxIdVerifiedAt: new Date(),
          taxIdVerifySource: "API",
          orgDataSource: "INVOICE_API",
        },
        select: { id: true, orgCode: true, canonicalName: true, address: true },
      });

      return NextResponse.json({ organization, created: true, invoiceFound: true }, { status: 201 });
    }

    // 4. API miss — rep cannot create; admin can
    if (isRep) {
      // Generate OrganizationReviewTask for admin
      const reviewTask = await prisma.organizationReviewTask.create({
        data: {
          rawInput: trimmedName,
          normalizedInput: normalizedName,
          confidence: 0,
          status: "PENDING",
          sourceType: "REP_ORG_REQUEST",
          sourceId: session.user.id,
          createdById: session.user.id,
        },
      });

      return NextResponse.json(
        {
          error: `单位"${trimmedName}"需管理员核实后建立。已生成审核任务 #${reviewTask.id.slice(-6)}`,
          reviewTaskId: reviewTask.id,
        },
        { status: 403 },
      );
    }

    // Admin — create without taxId (will be enriched later)
    const count = await prisma.organization.count();
    const orgCode = await generateOrgCode(count);
    const organization = await prisma.organization.create({
      data: {
        orgCode,
        canonicalName: trimmedName,
        normalizedName,
        address: address?.trim() || null,
        orgDataSource: "MANUAL",
      },
      select: { id: true, orgCode: true, canonicalName: true, address: true },
    });

    return NextResponse.json({ organization, created: true }, { status: 201 });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: "创建单位失败" }, { status: 500 });
  }
}

async function generateOrgCode(count: number): Promise<string> {
  for (let i = 0; i < 10; i++) {
    const code = `ORG-${String(count + 1 + i).padStart(5, "0")}`;
    const exists = await prisma.organization.findUnique({ where: { orgCode: code }, select: { id: true } });
    if (!exists) return code;
  }
  return `ORG-${String(Date.now() % 100000).padStart(5, "0")}`;
}

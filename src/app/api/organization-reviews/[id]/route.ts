import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { normalizeOrgName, normalizeSiteName } from "@/lib/organization-normalize";
import {
  syncEffectiveRepresentativeLinksForOrganization,
  syncProfileRepresentativeLinks,
} from "@/lib/crm/customer-representative-sync";
import {
  findRepresentativeBindingByScope,
  hasActiveBindingAtLevel,
  validateRepresentativeBindingScope,
} from "@/lib/crm/representative-binding";
import { lookupOrgByName } from "@/lib/invoice-org-api";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const currentUser = await prisma.user.findUnique({ where: { id: session.user.id }, select: { role: true } });
  if (!currentUser || currentUser.role !== "ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;

  try {
    const task = await prisma.organizationReviewTask.findUnique({ where: { id } });
    if (!task) return NextResponse.json({ error: "任务不存在" }, { status: 404 });
    if (task.status !== "PENDING") {
      return NextResponse.json({ error: "该任务已处理，不可重复审批" }, { status: 400 });
    }

    const body = await req.json();
    const { action } = body; // "approve" | "reject" | "approveAndCreate"

    if (action === "reject") {
      await prisma.organizationReviewTask.update({
        where: { id },
        data: {
          status: "REJECTED",
          reviewedById: session.user.id,
          reviewedAt: new Date(),
          reviewNote: body.reviewNote || null,
        },
      });
      return NextResponse.json({ status: "REJECTED" });
    }

    if (action === "approve" || action === "mergeToExisting") {
      const { organizationId, organizationSiteId, reviewNote } = body;
      if (!organizationId) {
        return NextResponse.json({ error: "审批通过需要指定机构" }, { status: 400 });
      }

      const org = await prisma.organization.findUnique({ where: { id: organizationId } });
      if (!org || org.deleted || org.archived) {
        return NextResponse.json({ error: "目标机构不存在或已归档" }, { status: 400 });
      }

      const scopeValidation = await validateRepresentativeBindingScope(prisma, organizationId, organizationSiteId || null);
      if (!scopeValidation.ok) {
        return NextResponse.json({ error: scopeValidation.error }, { status: 400 });
      }

      const bindingAutoActivation = await prisma.$transaction(async (tx) => {
        let activation: { organizationId: string; representativeEmail: string; organizationSiteId?: string | null } | null = null;

        await tx.organizationReviewTask.update({
          where: { id },
          data: {
            status: "APPROVED",
            suggestedOrganizationId: organizationId,
            suggestedSiteId: organizationSiteId || null,
            reviewedById: session.user.id,
            reviewedAt: new Date(),
            reviewNote: reviewNote || null,
            resolutionSource: action === "mergeToExisting" ? "MANUAL_MERGED_TO_EXISTING" : "DB_CANDIDATE",
          },
        });

        // Auto-create alias from rawInput so the same text resolves as exact next time
        const normalizedAlias = normalizeOrgName(task.rawInput);
        if (normalizedAlias && normalizedAlias !== org.normalizedName) {
          const existingAlias = await tx.organizationAlias.findFirst({
            where: { organizationId, normalizedAlias },
          });
          if (!existingAlias) {
            await tx.organizationAlias.create({
              data: {
                organizationId,
                alias: task.rawInput.trim(),
                normalizedAlias,
                approved: true,
              },
            });
          }
        }

        // Write back to source entity
        if (task.sourceType === "REP_ORG_BINDING_REQUEST") {
          const binding = await tx.representativeOrganization.findUnique({
            where: { id: task.sourceId },
            include: { representative: { select: { email: true } } },
          });
          if (binding) {
            const existingAtScope = await findRepresentativeBindingByScope(tx, {
              representativeId: binding.representativeId,
              organizationId,
              organizationSiteId: organizationSiteId || null,
            });

            const finalSiteId = organizationSiteId || null;
            if (existingAtScope && existingAtScope.id !== binding.id) {
              await tx.representativeOrganization.update({
                where: { id: existingAtScope.id },
                data: {
                  status: "ACTIVE",
                  reviewedByUserId: session.user.id,
                  reviewedAt: new Date(),
                  reviewNote: reviewNote || null,
                },
              });
              await tx.representativeOrganization.update({
                where: { id: binding.id },
                data: {
                  status: "ARCHIVED",
                  isPrimary: false,
                  reviewedByUserId: session.user.id,
                  reviewedAt: new Date(),
                  reviewNote: reviewNote || "duplicate_binding_reused",
                },
              });
            } else {
              const hasExistingActive = await hasActiveBindingAtLevel(tx, organizationId, finalSiteId);
              await tx.representativeOrganization.update({
                where: { id: task.sourceId },
                data: {
                  organizationId,
                  organizationSiteId: finalSiteId,
                  status: "ACTIVE",
                  isPrimary: binding.isPrimary || !hasExistingActive,
                  reviewedByUserId: session.user.id,
                  reviewedAt: new Date(),
                  reviewNote: reviewNote || null,
                },
              });
            }
            activation = {
              organizationId,
              representativeEmail: binding.representative.email,
              organizationSiteId: finalSiteId,
            };
          }
        } else if (task.sourceType === "CUSTOMER_CREATE" || task.sourceType === "CUSTOMER_EDIT") {
          // Profile-only：sourceId 即 profileId（旧 Customer 锚点来源的创建链路已下线，不再反查）
          const profile = await tx.crmCustomerProfile.findUnique({
            where: { id: task.sourceId },
            select: { id: true, deleted: true },
          });
          if (!profile || profile.deleted) {
            throw new Error("来源客户档案不存在或已删除，无法审批写入机构");
          }
          await tx.crmCustomerProfile.update({
            where: { id: profile.id },
            data: {
              organizationId,
              organizationSiteId: organizationSiteId || null,
              organization: org.canonicalName,
            },
          });
          await syncProfileRepresentativeLinks(profile.id, tx);
        }
        return activation;
      });

      if (bindingAutoActivation) {
        await syncEffectiveRepresentativeLinksForOrganization({
          organizationId: bindingAutoActivation.organizationId,
          organizationSiteId: bindingAutoActivation.organizationSiteId,
        });
      }

      return NextResponse.json({ status: "APPROVED" });
    }

    if (action === "approveAndCreate" || action === "approveForceNew") {
      const isForce = action === "approveForceNew";
      const { canonicalName, address, aliases, sites, siteName, siteAddress, reviewNote, bindSiteName } = body;
      if (!canonicalName?.trim()) {
        return NextResponse.json({ error: "标准名称为必填项" }, { status: 400 });
      }
      if (isForce && !reviewNote?.trim()) {
        return NextResponse.json({ error: "强制新建需要填写备注" }, { status: 400 });
      }

      const normalizedName = normalizeOrgName(canonicalName.trim());
      if (!isForce) {
        const existing = await prisma.organization.findFirst({
          where: { normalizedName, deleted: false },
        });
        if (existing) {
          return NextResponse.json({ error: `已存在同名机构: ${existing.canonicalName}` }, { status: 409 });
        }
      }

      // Generate org code
      const count = await prisma.organization.count();
      let orgCode = "";
      for (let i = 0; i < 10; i++) {
        const code = `ORG-${String(count + 1 + i).padStart(5, "0")}`;
        const exists = await prisma.organization.findUnique({ where: { orgCode: code }, select: { id: true } });
        if (!exists) { orgCode = code; break; }
      }
      if (!orgCode) orgCode = `ORG-${String(Date.now() % 100000).padStart(5, "0")}`;

      // Merge sites array with legacy siteName/siteAddress, deduplicate by normalized name
      const allSites: Array<{ siteName: string; address?: string; siteType?: string }> = [];
      const seenSiteNames = new Set<string>();
      if (Array.isArray(sites)) {
        for (const s of sites) {
          if (s.siteName?.trim()) {
            const norm = normalizeSiteName(s.siteName.trim());
            if (!seenSiteNames.has(norm)) {
              seenSiteNames.add(norm);
              allSites.push({ siteName: s.siteName.trim(), address: s.address?.trim(), siteType: s.siteType || "CAMPUS" });
            }
          }
        }
      }
      if (siteName?.trim()) {
        const norm = normalizeSiteName(siteName.trim());
        if (!seenSiteNames.has(norm)) {
          seenSiteNames.add(norm);
          allSites.push({ siteName: siteName.trim(), address: siteAddress?.trim(), siteType: "CAMPUS" });
        }
      }

      const bindingAutoActivation = await prisma.$transaction(async (tx) => {
        let activation: { organizationId: string; representativeEmail: string; organizationSiteId?: string | null } | null = null;

        // Try invoice API to pre-populate taxId + four elements
        let invoiceData: Record<string, unknown> = {};
        try {
          const apiResults = await lookupOrgByName(canonicalName.trim());
          if (apiResults.length > 0) {
            const match = apiResults[0];
            invoiceData = {
              taxId: match.unitTaxNo,
              invoiceAddress: match.unitAddress || null,
              invoicePhone: match.unitPhone || null,
              invoiceBankName: match.bankName || null,
              invoiceBankAccount: match.bankNo || null,
              isInvoiceSubject: true,
              taxIdVerifiedAt: new Date(),
              taxIdVerifySource: "API",
              orgDataSource: "INVOICE_API",
            };
          }
        } catch { /* API unavailable */ }

        const newOrg = await tx.organization.create({
          data: {
            orgCode,
            canonicalName: canonicalName.trim(),
            normalizedName,
            address: address?.trim() || null,
            ...invoiceData,
            aliases: aliases?.length ? {
              create: (aliases as string[]).filter(Boolean).map((a: string) => ({
                alias: a.trim(),
                normalizedAlias: normalizeOrgName(a.trim()),
              })),
            } : undefined,
          },
        });

        // Create all sites
        const createdSiteIds: string[] = [];
        for (const s of allSites) {
          const site = await tx.organizationSite.create({
            data: {
              organizationId: newOrg.id,
              siteName: s.siteName,
              normalizedSiteName: normalizeSiteName(s.siteName),
              siteType: s.siteType || undefined,
              address: s.address || null,
            },
          });
          createdSiteIds.push(site.id);
        }
        // Determine which site to bind by name match
        let bindSiteId: string | null = null;
        if (bindSiteName && createdSiteIds.length > 0) {
          const normalizedBind = normalizeSiteName(bindSiteName);
          const matchedSite = await tx.organizationSite.findFirst({
            where: {
              organizationId: newOrg.id,
              normalizedSiteName: normalizedBind,
            },
            select: { id: true },
          });
          bindSiteId = matchedSite?.id || null;
        }

        await tx.organizationReviewTask.update({
          where: { id },
          data: {
            status: "APPROVED",
            suggestedOrganizationId: newOrg.id,
            suggestedSiteId: bindSiteId,
            suggestedCanonicalName: newOrg.canonicalName,
            reviewedById: session.user.id,
            reviewedAt: new Date(),
            reviewNote: reviewNote || null,
            resolutionSource: isForce ? "MANUAL_FORCE_NEW" : "MANUAL_NEW",
          },
        });

        // Auto-create alias from rawInput if it differs from canonicalName and wasn't already in aliases
        const normalizedRaw = normalizeOrgName(task.rawInput);
        if (normalizedRaw && normalizedRaw !== normalizedName) {
          const aliasNorms = (aliases as string[] || []).map((a: string) => normalizeOrgName(a.trim()));
          if (!aliasNorms.includes(normalizedRaw)) {
            await tx.organizationAlias.create({
              data: {
                organizationId: newOrg.id,
                alias: task.rawInput.trim(),
                normalizedAlias: normalizedRaw,
                approved: true,
              },
            });
          }
        }

        // Write back to source entity
        if (task.sourceType === "REP_ORG_BINDING_REQUEST") {
          const binding = await tx.representativeOrganization.findUnique({
            where: { id: task.sourceId },
            include: { representative: { select: { email: true } } },
          });
          if (binding) {
            const hasExistingActive = await hasActiveBindingAtLevel(tx, newOrg.id, bindSiteId);
            await tx.representativeOrganization.update({
              where: { id: task.sourceId },
              data: {
                organizationId: newOrg.id,
                organizationSiteId: bindSiteId,
                status: "ACTIVE",
                isPrimary: binding.isPrimary || !hasExistingActive,
                reviewedByUserId: session.user.id,
                reviewedAt: new Date(),
                reviewNote: reviewNote || null,
              },
            });
            activation = {
              organizationId: newOrg.id,
              representativeEmail: binding.representative.email,
              organizationSiteId: bindSiteId,
            };
          }
        } else if (task.sourceType === "CUSTOMER_CREATE" || task.sourceType === "CUSTOMER_EDIT") {
          // Profile-only：sourceId 即 profileId（旧 Customer 锚点来源的创建链路已下线，不再反查）
          const profile = await tx.crmCustomerProfile.findUnique({
            where: { id: task.sourceId },
            select: { id: true, deleted: true },
          });
          if (!profile || profile.deleted) {
            throw new Error("来源客户档案不存在或已删除，无法审批写入机构");
          }
          await tx.crmCustomerProfile.update({
            where: { id: profile.id },
            data: {
              organizationId: newOrg.id,
              organizationSiteId: bindSiteId,
              organization: newOrg.canonicalName,
            },
          });
          await syncProfileRepresentativeLinks(profile.id, tx);
        }
        return activation;
      });

      if (bindingAutoActivation) {
        await syncEffectiveRepresentativeLinksForOrganization({
          organizationId: bindingAutoActivation.organizationId,
          organizationSiteId: bindingAutoActivation.organizationSiteId,
        });
      }

      return NextResponse.json({ status: "APPROVED", orgCode });
    }

    // ── 缺口2: taxId validation for REP_ORG_REQUEST ──
    if (action === "verifyTaxId") {
      // Try invoice API for this org name
      let verified = false;
      let invoiceInfo: Record<string, unknown> | null = null;
      try {
        const results = await lookupOrgByName(task.rawInput);
        const match = results[0];
        if (match && match.unitTaxNo && match.unitName) {
          // P1 fix: only accept exact normalized match, not loose startsWith
          const normalizedMatch = normalizeOrgName(match.unitName);
          const normalizedTask = normalizeOrgName(task.rawInput);
          if (normalizedMatch === normalizedTask) {
            verified = true;
            invoiceInfo = {
              unitName: match.unitName,
              unitTaxNo: match.unitTaxNo,
              unitAddress: match.unitAddress,
              unitPhone: match.unitPhone,
              bankName: match.bankName,
              bankNo: match.bankNo,
            };
          }
        }
      } catch { /* API unavailable */ }

      return NextResponse.json({ verified, invoiceInfo });
    }

    if (action === "approveWithTax") {
      // Admin confirms a REP_ORG_REQUEST with taxId data from API or manual
      const { organizationId, organizationSiteId, reviewNote, taxId, invoiceAddress, invoicePhone, invoiceBankName, invoiceBankAccount, verifiedByApi } = body;

      const targetOrgId = organizationId;
      if (targetOrgId) {
        // Bind to existing org — update its invoice fields
        await prisma.organization.update({
          where: { id: targetOrgId },
          data: {
            taxId: taxId ? (taxId as string).trim() || null : null,
            invoiceAddress: invoiceAddress ? (invoiceAddress as string).trim() || null : null,
            invoicePhone: invoicePhone ? (invoicePhone as string).trim() || null : null,
            invoiceBankName: invoiceBankName ? (invoiceBankName as string).trim() || null : null,
            invoiceBankAccount: invoiceBankAccount ? (invoiceBankAccount as string).trim() || null : null,
            isInvoiceSubject: true,
            taxIdVerifiedAt: verifiedByApi ? new Date() : undefined,
            taxIdVerifySource: verifiedByApi ? "API" : "MANUAL",
          },
        });
      } else {
        // Create new org with taxId — approveAndCreate variant
        return NextResponse.json({ error: "需要指定机构" }, { status: 400 });
      }

      await prisma.organizationReviewTask.update({
        where: { id },
        data: {
          status: "APPROVED",
          suggestedOrganizationId: targetOrgId,
          reviewedById: session.user.id,
          reviewedAt: new Date(),
          reviewNote: reviewNote || null,
          resolutionSource: "MANUAL_NEW",
        },
      });

      return NextResponse.json({ status: "APPROVED" });
    }

    if (action === "markAsNonInvoice") {
      // For orgs that never need invoices (e.g., overseas labs)
      const { organizationId, reviewNote } = body;
      if (!organizationId) {
        return NextResponse.json({ error: "需要指定机构" }, { status: 400 });
      }

      await prisma.$transaction(async (tx) => {
        await tx.organization.update({
          where: { id: organizationId },
          data: {
            isInvoiceSubject: true, // marked as subject but exempt from taxId requirement
            taxIdVerifySource: "EXEMPT",
          },
        });

        await tx.organizationReviewTask.update({
          where: { id },
          data: {
            status: "APPROVED",
            suggestedOrganizationId: organizationId,
            reviewedById: session.user.id,
            reviewedAt: new Date(),
            reviewNote: reviewNote || "标记为无需开票",
            resolutionSource: "MANUAL_NEW",
          },
        });

        // Write back to source customer if applicable（Profile-only：sourceId 即 profileId，不再反查 Customer 锚点）
        if (task.sourceType === "CUSTOMER_CREATE" || task.sourceType === "CUSTOMER_EDIT") {
          const profile = await tx.crmCustomerProfile.findUnique({
            where: { id: task.sourceId },
            select: { id: true, deleted: true },
          });
          if (!profile || profile.deleted) {
            throw new Error("来源客户档案不存在或已删除，无法审批写入机构");
          }
          const orgRow = await tx.organization.findUnique({
            where: { id: organizationId },
            select: { canonicalName: true },
          });
          await tx.crmCustomerProfile.update({
            where: { id: profile.id },
            data: {
              organizationId,
              organization: orgRow!.canonicalName,
            },
          });
          await syncProfileRepresentativeLinks(profile.id, tx);
        }
      });

      return NextResponse.json({ status: "APPROVED" });
    }

    return NextResponse.json({ error: "无效的操作" }, { status: 400 });
  } catch (error) {
    console.error(error);
    const message = error instanceof Error ? error.message : "审批失败";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

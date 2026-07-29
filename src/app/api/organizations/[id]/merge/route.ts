import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { mergeRepresentativeBindingsAtScope } from "@/lib/crm/representative-binding";
import { rebindOrganizationReferences } from "@/lib/organization-rebind";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // Real-time role check
  const currentUser = await prisma.user.findUnique({ where: { id: session.user.id }, select: { role: true } });
  if (!currentUser || currentUser.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id: sourceId } = await params;

  try {
    const body = await req.json();
    const { targetId } = body;

    if (!targetId || targetId === sourceId) {
      return NextResponse.json({ error: "目标机构无效" }, { status: 400 });
    }

    const [source, target] = await Promise.all([
      prisma.organization.findUnique({ where: { id: sourceId }, include: { aliases: true, sites: true } }),
      prisma.organization.findUnique({ where: { id: targetId }, include: { sites: true } }),
    ]);

    if (!source || source.deleted) return NextResponse.json({ error: "源机构不存在" }, { status: 404 });
    if (!target || target.deleted) return NextResponse.json({ error: "目标机构不存在" }, { status: 404 });

    // Build map of target's site normalized names -> {id, archived} for dedup + rebind
    const targetSiteMap = new Map(target.sites.map((s) => [s.normalizedSiteName, { id: s.id, archived: s.archived }]));
    // Track source site id → target site id for binding migration
    const siteIdRedirect = new Map<string, string>();

    await prisma.$transaction(async (tx) => {
      // Move customer profiles from source to target
      await tx.crmCustomerProfile.updateMany({
        where: { organizationId: sourceId },
        data: { organizationId: targetId, organization: target.canonicalName },
      });

      // Move aliases to target (add source canonical name as alias too)
      for (const alias of source.aliases) {
        await tx.organizationAlias.update({
          where: { id: alias.id },
          data: { organizationId: targetId },
        });
      }
      // Add source's canonical name as alias on target
      await tx.organizationAlias.create({
        data: {
          organizationId: targetId,
          alias: source.canonicalName,
          normalizedAlias: source.normalizedName,
          aliasType: "FORMER_NAME",
        },
      });

      // Move sites to target, handle duplicates and rebind customers
      for (const site of source.sites) {
        const targetSite = targetSiteMap.get(site.normalizedSiteName);
        if (targetSite) {
          // Collision — un-archive target site if needed, rebind customer profiles, archive source site
          if (targetSite.archived) {
            await tx.organizationSite.update({
              where: { id: targetSite.id },
              data: { archived: false },
            });
          }
          await tx.crmCustomerProfile.updateMany({
            where: { organizationSiteId: site.id },
            data: { organizationSiteId: targetSite.id },
          });
          // Redirect site-level bindings from source site to target site
          siteIdRedirect.set(site.id, targetSite.id);
          await tx.organizationSite.update({
            where: { id: site.id },
            data: { archived: true },
          });
        } else {
          await tx.organizationSite.update({
            where: { id: site.id },
            data: { organizationId: targetId },
          });
          targetSiteMap.set(site.normalizedSiteName, { id: site.id, archived: false });
        }
      }

      // Migrate representative bindings one by one to avoid duplicate org/site scope collisions.
      const sourceBindings = await tx.representativeOrganization.findMany({
        where: { organizationId: sourceId },
        orderBy: { createdAt: "asc" },
      });

      for (const binding of sourceBindings) {
        const redirectedSiteId = binding.organizationSiteId
          ? (siteIdRedirect.get(binding.organizationSiteId) ?? binding.organizationSiteId)
          : null;
        await mergeRepresentativeBindingsAtScope(tx, binding, {
          organizationId: targetId,
          organizationSiteId: redirectedSiteId,
        });
      }

      // 3. Clear extra primary flags: keep target org's primary, clear others at same level
      const migratedBindings = await tx.representativeOrganization.findMany({
        where: { organizationId: targetId, isPrimary: true, status: "ACTIVE" },
        select: { id: true, organizationSiteId: true },
        orderBy: { createdAt: "asc" },
      });

      // Group by level (org-level vs site-level)
      const levelPrimaries = new Map<string, string[]>();
      for (const b of migratedBindings) {
        const key = b.organizationSiteId ?? "__org__";
        const list = levelPrimaries.get(key) || [];
        list.push(b.id);
        levelPrimaries.set(key, list);
      }

      for (const [, ids] of levelPrimaries) {
        if (ids.length > 1) {
          // Keep the earliest (first in sorted order), clear the rest
          const [, ...extras] = ids;
          await tx.representativeOrganization.updateMany({
            where: { id: { in: extras } },
            data: { isPrimary: false },
          });
        }
      }

      // Soft-delete source
      await tx.organization.update({
        where: { id: sourceId },
        data: { deleted: true },
      });

      // Rebind remaining FK references (FinanceReceipt, CrmCustomerApplication, etc.)
      // Does NOT touch invoice buyer references
      await rebindOrganizationReferences(tx, sourceId, targetId, target.canonicalName, source.canonicalName);
    });

    return NextResponse.json({ merged: true, targetId });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: "合并机构失败" }, { status: 500 });
  }
}

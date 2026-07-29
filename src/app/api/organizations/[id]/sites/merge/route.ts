import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

/**
 * POST /api/organizations/[id]/sites/merge
 *
 * Merge two OrganizationSites under the SAME organization (source → target).
 * Used by admins to clean up LLM-induced duplicate / near-synonym sites.
 *
 * Body: { sourceSiteId, targetSiteId, reason?, preserveHierarchy?, dryRun? }
 *  - dryRun: true  → read-only impact preview (migrated customers + archived
 *    bindings), no writes.
 *  - dryRun: false (default) → execute the merge.
 *
 * Source-site ACTIVE representative bindings are ARCHIVED (not migrated to the
 * target) to avoid colliding with the target's bindings under the unique key
 * `@@unique([representativeId, organizationSiteId])`. This API only merges
 * sites — it does not merge organizations.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // Real-time role check — JWT role may be stale
  const currentUser = await prisma.user.findUnique({ where: { id: session.user.id }, select: { role: true } });
  if (!currentUser || currentUser.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;

  try {
    const body = await req.json();
    const { sourceSiteId, targetSiteId, reason, preserveHierarchy, dryRun } = body as {
      sourceSiteId?: string;
      targetSiteId?: string;
      reason?: string;
      preserveHierarchy?: boolean;
      dryRun?: boolean;
    };

    if (!sourceSiteId || !targetSiteId) {
      return NextResponse.json({ error: "源院区和目标院区均为必填" }, { status: 400 });
    }
    if (sourceSiteId === targetSiteId) {
      return NextResponse.json({ error: "源院区与目标院区不能相同" }, { status: 400 });
    }

    const [sourceSite, targetSite] = await Promise.all([
      prisma.organizationSite.findUnique({
        where: { id: sourceSiteId },
        select: { id: true, organizationId: true, siteName: true, archived: true },
      }),
      prisma.organizationSite.findUnique({
        where: { id: targetSiteId },
        select: { id: true, organizationId: true, siteName: true, archived: true, mergedFromJson: true },
      }),
    ]);

    if (!sourceSite) return NextResponse.json({ error: "源院区不存在" }, { status: 404 });
    if (!targetSite) return NextResponse.json({ error: "目标院区不存在" }, { status: 404 });
    if (sourceSite.organizationId !== id || targetSite.organizationId !== id) {
      return NextResponse.json({ error: "院区不属于指定机构" }, { status: 400 });
    }
    if (sourceSite.archived) {
      return NextResponse.json({ error: "源院区已归档，无法作为合并来源" }, { status: 400 });
    }

    // ── dryRun: read-only impact preview ──
    if (dryRun) {
      const [migratedCustomers, archivedBindings] = await Promise.all([
        prisma.crmCustomerProfile.count({ where: { organizationSiteId: sourceSiteId } }),
        prisma.representativeOrganization.count({ where: { organizationSiteId: sourceSiteId, status: "ACTIVE" } }),
      ]);
      return NextResponse.json({
        dryRun: true,
        sourceSiteId,
        targetSiteId,
        sourceSiteName: sourceSite.siteName,
        targetSiteName: targetSite.siteName,
        migratedCustomers,
        archivedBindings,
      });
    }

    // ── execute merge ──
    const result = await prisma.$transaction(async (tx) => {
      // 1. Un-archive target if it was archived
      if (targetSite.archived) {
        await tx.organizationSite.update({ where: { id: targetSiteId }, data: { archived: false } });
      }

      // 2. Rebind customer profiles from source site → target site
      const customerUpdate = await tx.crmCustomerProfile.updateMany({
        where: { organizationSiteId: sourceSiteId },
        data: { organizationSiteId: targetSiteId },
      });

      // 3. Archive the source site's ACTIVE representative bindings (do NOT migrate —
      //    migrating would collide with target bindings under
      //    @@unique([representativeId, organizationSiteId])). Only ACTIVE bindings
      //    are touched; PENDING/REJECTED/ARCHIVED are left as-is.
      const bindingUpdate = await tx.representativeOrganization.updateMany({
        where: { organizationSiteId: sourceSiteId, status: "ACTIVE" },
        data: { status: "ARCHIVED", isPrimary: false },
      });

      // 4. Reparent child sites that pointed at the source (soft reference fix)
      await tx.organizationSite.updateMany({
        where: { parentSiteId: sourceSiteId },
        data: { parentSiteId: targetSiteId },
      });

      // 5. preserveHierarchy → append merged-from history to target
      if (preserveHierarchy) {
        let existing: Array<{ siteId: string; siteName: string; mergedAt: string }> = [];
        if (targetSite.mergedFromJson) {
          try {
            const parsed = JSON.parse(targetSite.mergedFromJson);
            if (Array.isArray(parsed)) existing = parsed;
          } catch {
            existing = [];
          }
        }
        existing.push({ siteId: sourceSite.id, siteName: sourceSite.siteName, mergedAt: new Date().toISOString() });
        await tx.organizationSite.update({
          where: { id: targetSiteId },
          data: { mergedFromJson: JSON.stringify(existing) },
        });
      }

      // 6. Archive the source site
      await tx.organizationSite.update({
        where: { id: sourceSiteId },
        data: { archived: true },
      });

      // 7. Audit
      await tx.activityLog.create({
        data: {
          type: "ORG_SITE_MERGE",
          content: `合并院区「${sourceSite.siteName}」→「${targetSite.siteName}」（迁移客户 ${customerUpdate.count}，归档代表绑定 ${bindingUpdate.count}）`,
          metadata: JSON.stringify({
            organizationId: id,
            sourceSiteId,
            sourceSiteName: sourceSite.siteName,
            targetSiteId,
            targetSiteName: targetSite.siteName,
            migratedCustomers: customerUpdate.count,
            archivedBindings: bindingUpdate.count,
            preserveHierarchy: !!preserveHierarchy,
            reason: reason || null,
          }),
          userId: session.user.id,
        },
      });

      return { migratedCustomers: customerUpdate.count, archivedBindings: bindingUpdate.count };
    });

    return NextResponse.json({
      merged: true,
      sourceSiteId,
      targetSiteId,
      migratedCustomers: result.migratedCustomers,
      archivedBindings: result.archivedBindings,
    });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: "合并院区失败" }, { status: 500 });
  }
}

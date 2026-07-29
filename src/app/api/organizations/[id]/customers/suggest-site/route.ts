import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

/**
 * POST /api/organizations/[id]/customers/suggest-site
 *
 * Suggest which OrganizationSite each site-less profile of this org likely
 * belongs to, using pure text rules (D12 — no POI search). Read-only: callers
 * apply suggestions via POST /api/crm/profiles/batch-assign-site.
 *
 * Returns one row per org profile with `organizationSiteId IS NULL`:
 *   { profileId, customerName, suggestedSiteId, suggestedSiteName,
 *     confidence: "HIGH" | "LOW" | null, matchedSignals: string[] }
 *
 *  - HIGH: matched exactly one site with ≥1 signal
 *  - LOW:  matched multiple sites (suggested = the one with the most signals)
 *  - null: no match
 */

const MIN_KEYWORD_LEN = 2;

/** Site keyword = the segment before the "·" hierarchy marker (or the whole name). */
function siteKeyword(siteName: string): string {
  const dot = siteName.indexOf("·");
  const head = dot >= 0 ? siteName.slice(0, dot) : siteName;
  return head.trim();
}

function includesCI(haystack: string | null | undefined, needle: string): boolean {
  if (!haystack) return false;
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const currentUser = await prisma.user.findUnique({ where: { id: session.user.id }, select: { role: true } });
  if (!currentUser || currentUser.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id: orgId } = await params;

  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { id: true } });
  if (!org) return NextResponse.json({ error: "机构不存在" }, { status: 404 });

  const [sites, profiles] = await Promise.all([
    prisma.organizationSite.findMany({
      where: { organizationId: orgId, archived: false },
      select: { id: true, siteName: true },
    }),
    prisma.crmCustomerProfile.findMany({
      where: {
        organizationId: orgId,
        organizationSiteId: null,
        deleted: false,
        archived: false,
        mergedIntoProfileId: null,
      },
      select: { id: true, name: true, labOrGroup: true, addressNote: true, address: true },
    }),
  ]);

  const siteKeywords = sites
    .map((s) => ({ id: s.id, siteName: s.siteName, keyword: siteKeyword(s.siteName) }))
    .filter((s) => s.keyword.length >= MIN_KEYWORD_LEN);

  const results = profiles.map((p) => {
    const candidates: Array<{ siteId: string; siteName: string; signals: string[] }> = [];
    for (const s of siteKeywords) {
      const signals: string[] = [];
      if (includesCI(p.addressNote, s.keyword) || includesCI(p.address, s.keyword)) signals.push("地址");
      if (includesCI(p.labOrGroup, s.keyword) || includesCI(p.name, s.keyword)) signals.push("名称");
      if (signals.length > 0) candidates.push({ siteId: s.id, siteName: s.siteName, signals });
    }

    if (candidates.length === 0) {
      return {
        profileId: p.id,
        customerName: p.name ?? null,
        suggestedSiteId: null,
        suggestedSiteName: null,
        confidence: null as "HIGH" | "LOW" | null,
        matchedSignals: [] as string[],
      };
    }

    if (candidates.length === 1) {
      const only = candidates[0];
      return {
        profileId: p.id,
        customerName: p.name ?? null,
        suggestedSiteId: only.siteId,
        suggestedSiteName: only.siteName,
        confidence: "HIGH" as const,
        matchedSignals: only.signals,
      };
    }

    const best = [...candidates].sort((a, b) => b.signals.length - a.signals.length)[0];
    return {
      profileId: p.id,
      customerName: p.name ?? null,
      suggestedSiteId: best.siteId,
      suggestedSiteName: best.siteName,
      confidence: "LOW" as const,
      matchedSignals: best.signals,
    };
  });

  return NextResponse.json({ suggestions: results });
}

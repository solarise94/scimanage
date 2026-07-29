import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ siteId: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { siteId } = await params;

  const site = await prisma.organizationSite.findUnique({
    where: { id: siteId },
    select: {
      id: true,
      siteName: true,
      siteType: true,
      organizationId: true,
      organization: { select: { canonicalName: true } },
    },
  });

  if (!site) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json({
    site: {
      id: site.id,
      siteName: site.siteName,
      siteType: site.siteType,
      organizationId: site.organizationId,
      organizationName: site.organization.canonicalName,
    },
  });
}

/**
 * PATCH /api/organization-sites/[siteId]  (Task 1.13 — 保存地图选点坐标)
 *
 * 写入 site 的 lat/lng/geocodeSource/geocodedAt（外加可选 geocodeRawJson）。
 * 来源 source 必须是 MANUAL | POI_SEARCH | GEOCODE | REVERSE_GEOCODE。ADMIN-only。
 */
const VALID_GEOCODE_SOURCES = new Set(["MANUAL", "POI_SEARCH", "GEOCODE", "REVERSE_GEOCODE"]);

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ siteId: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // Real-time role check — JWT role may be stale
  const currentUser = await prisma.user.findUnique({ where: { id: session.user.id }, select: { role: true } });
  if (!currentUser || currentUser.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { siteId } = await params;

  const body = await req.json().catch(() => null);
  const lat = typeof body?.lat === "number" ? body.lat : Number(body?.lat);
  const lng = typeof body?.lng === "number" ? body.lng : Number(body?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return NextResponse.json({ error: "lat/lng 必须是有效数字" }, { status: 400 });
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return NextResponse.json({ error: "lat/lng 超出合法范围" }, { status: 400 });
  }
  const source = typeof body?.geocodeSource === "string" && VALID_GEOCODE_SOURCES.has(body.geocodeSource)
    ? body.geocodeSource
    : "MANUAL";
  const geocodeRawJson = typeof body?.geocodeRawJson === "string" ? body.geocodeRawJson : undefined;

  const existing = await prisma.organizationSite.findUnique({ where: { id: siteId }, select: { id: true } });
  if (!existing) return NextResponse.json({ error: "院区不存在" }, { status: 404 });

  const updated = await prisma.organizationSite.update({
    where: { id: siteId },
    data: {
      lat,
      lng,
      geocodeSource: source,
      geocodedAt: new Date(),
      ...(geocodeRawJson !== undefined ? { geocodeRawJson } : {}),
    },
    select: { id: true, lat: true, lng: true, geocodeSource: true, geocodedAt: true },
  });

  return NextResponse.json({ site: updated });
}

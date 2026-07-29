import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { suggestSites, geocodeSite } from "@/lib/site-geocode";

/**
 * POST /api/organization-sites/geocode  (Task 1.13 — 地图选点后端)
 *
 * 把服务端高德 Web 服务（suggestSites / geocodeSite，读 AMAP_WEB_KEY）暴露给
 * site 地图选点 UI。前端 JS API（NEXT_PUBLIC_AMAP_JS_KEY）只负责渲染地图与拖拽，
 * 联想/地理编码统一走这里，避免在浏览器里再配一套 Web 服务 key。
 *
 * Body:
 *   { mode: "suggest", keyword, city? }  → { results: SuggestItem[] }
 *   { mode: "geocode",  keyword, city? } → { result: SiteGeocodeResult }
 *
 * ADMIN-only（机构/院区治理是 admin 能力）。
 */
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // Real-time role check — JWT role may be stale
  const currentUser = await prisma.user.findUnique({ where: { id: session.user.id }, select: { role: true } });
  if (!currentUser || currentUser.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const mode = body?.mode === "geocode" ? "geocode" : body?.mode === "suggest" ? "suggest" : null;
  if (!mode) return NextResponse.json({ error: "mode 必须是 suggest 或 geocode" }, { status: 400 });

  const keyword = typeof body?.keyword === "string" ? body.keyword.trim() : "";
  if (!keyword) return NextResponse.json({ error: "keyword 必填" }, { status: 400 });
  const city = typeof body?.city === "string" && body.city.trim() ? body.city.trim() : undefined;

  if (mode === "suggest") {
    const { error, results } = await suggestSites(keyword, city);
    if (error) return NextResponse.json({ error }, { status: 502 });
    return NextResponse.json({ results: results ?? [] });
  }

  const { error, result } = await geocodeSite(keyword, city);
  if (error) return NextResponse.json({ error }, { status: 502 });
  return NextResponse.json({ result });
}

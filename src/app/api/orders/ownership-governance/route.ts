/**
 * Phase E: technical-owner governance UI route（ADMIN）。
 *
 * GET /api/orders/ownership-governance?resourceType=ORDER|PROJECT&limit=
 *   列出 PENDING 治理任务。
 *
 * ADMIN-only。这是 UI 治理入口（非 Agent 写路径），保留 Web 既有 role policy。
 */
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { listPendingGovernanceTasks } from "@/lib/orders/application/technical-owner-governance";

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const url = req.nextUrl;
  const resourceTypeParam = url.searchParams.get("resourceType");
  const resourceType =
    resourceTypeParam === "ORDER" || resourceTypeParam === "PROJECT" ? resourceTypeParam : undefined;
  const limitParam = parseInt(url.searchParams.get("limit") || "50", 10);
  const limit = Number.isFinite(limitParam) ? limitParam : 50;

  const result = await listPendingGovernanceTasks({ resourceType, limit });
  return NextResponse.json(result);
}

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { enrichOrganization } from "@/lib/organization-enrichment";

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const user = await prisma.user.findUnique({ where: { id: session.user.id }, select: { role: true } });
  if (!user || user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json();
  const query = (body.query || "").trim();
  const mode = body.mode === "supplement" ? "supplement" : "create";
  if (!query) {
    return NextResponse.json({ error: "查询内容不能为空" }, { status: 400 });
  }

  try {
    const result = await enrichOrganization(query, { skipLocalResolve: mode === "supplement" });

    if (result.kind === "existing") {
      return NextResponse.json({
        kind: "existing",
        organization: {
          id: result.resolveResult.organizationId,
          canonicalName: result.resolveResult.canonicalName,
          siteName: result.resolveResult.siteName,
          address: result.resolveResult.address,
        },
      });
    }

    if (result.kind === "candidates") {
      return NextResponse.json({
        kind: "candidates",
        candidates: result.resolveResult.candidates,
      });
    }

    if (result.kind === "failed") {
      return NextResponse.json({ error: result.reason }, { status: 422 });
    }

    return NextResponse.json({
      kind: "draft",
      draftPreview: {
        canonicalName: result.draft.canonicalName,
        address: result.draft.address,
        aliases: result.draft.aliases,
        sites: result.draft.sites,
        confidence: result.draft.confidence,
      },
      evidence: result.evidence,
    });
  } catch (error) {
    console.error("Organization AI draft error:", error);
    const message = error instanceof Error ? error.message : "AI 预填失败";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

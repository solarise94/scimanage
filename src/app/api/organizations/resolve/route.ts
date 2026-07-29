import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { isRepresentative } from "@/lib/permissions";
import { resolveOrganization } from "@/lib/organization-resolver";

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const name = body.name?.trim();
  if (!name) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  const result = await resolveOrganization(name);
  const isRep = isRepresentative(session.user.role);

  // Representatives get exact-only to prevent enumeration of org master data
  if (isRep) {
    if (result.status === "exact" && result.organizationId) {
      return NextResponse.json({
        status: "exact",
        organizationId: result.organizationId,
        organizationSiteId: result.organizationSiteId,
        canonicalName: result.canonicalName,
        siteName: result.siteName,
        rawInput: result.rawInput,
        normalizedInput: result.normalizedInput,
      });
    }
    return NextResponse.json({
      status: "unmatched",
      organizationId: null,
      organizationSiteId: null,
      canonicalName: null,
      siteName: null,
      rawInput: result.rawInput,
      normalizedInput: result.normalizedInput,
    });
  }

  return NextResponse.json({
    status: result.status,
    organizationId: result.organizationId,
    organizationSiteId: result.organizationSiteId,
    canonicalName: result.canonicalName,
    siteName: result.siteName,
    address: result.address,
    candidates: result.candidates,
    bestSuggestion: result.bestSuggestion,
    reviewRequired: result.reviewRequired,
    rawInput: result.rawInput,
    normalizedInput: result.normalizedInput,
  });
}

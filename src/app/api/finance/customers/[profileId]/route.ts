import { NextRequest, NextResponse } from "next/server";
import { requirePortalSession } from "@/lib/application/http-error-mapping";
import { isFinanceBlocked, getFinanceProfileScopeWhere } from "@/lib/finance/permissions";
import { getCustomerFinanceDetail } from "@/lib/finance/calculations";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ profileId: string }> }
) {
  const gated = await requirePortalSession();
  if (!gated.ok) return gated.response;
  const session = gated.session;
  if (isFinanceBlocked(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { profileId } = await params;

  if (session.user.role !== "ADMIN") {
    const scope = await getFinanceProfileScopeWhere(session.user.id, session.user.role);
    if (scope && !scope.id.in.includes(profileId)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  const detail = await getCustomerFinanceDetail(profileId);
  if (!detail) return NextResponse.json({ error: "Not Found" }, { status: 404 });
  return NextResponse.json(detail);
}

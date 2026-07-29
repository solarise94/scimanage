import { NextRequest, NextResponse } from "next/server";
import { requirePortalSession } from "@/lib/application/http-error-mapping";
import { isFinanceBlocked, getFinanceProfileScopeWhere } from "@/lib/finance/permissions";
import { getCustomerFinanceList } from "@/lib/finance/calculations";

export async function GET(req: NextRequest) {
  const gated = await requirePortalSession();
  if (!gated.ok) return gated.response;
  const session = gated.session;
  if (isFinanceBlocked(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const url = req.nextUrl;
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
  const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get("pageSize") || "20", 10)));
  const search = url.searchParams.get("search")?.trim() || "";
  const includeArchived = url.searchParams.get("includeArchived") === "true" && session.user.role === "ADMIN";

  const customerScope = await getFinanceProfileScopeWhere(session.user.id, session.user.role);
  const result = await getCustomerFinanceList(customerScope, page, pageSize, search || undefined, includeArchived);
  return NextResponse.json(result);
}

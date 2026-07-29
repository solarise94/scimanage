import { NextRequest, NextResponse } from "next/server";
import { requirePortalSession } from "@/lib/application/http-error-mapping";
import { isFinanceBlocked, getFinanceProfileScopeWhere, getFinanceProjectScopeWhere } from "@/lib/finance/permissions";
import { getFinanceSummary } from "@/lib/finance/calculations";
import { resolveActorDepartmentOrNull } from "@/lib/department";

export async function GET(req: NextRequest) {
  const gated = await requirePortalSession();
  if (!gated.ok) return gated.response;
  const session = gated.session;
  if (isFinanceBlocked(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const includeArchived = req.nextUrl.searchParams.get("includeArchived") === "true" && session.user.role === "ADMIN";
  // Fail-closed（设计 §6.1）：非 ADMIN 部门无法权威解析时收紧到 no-match scope，
  // 让 getFinanceSummary 计算等价于空集的汇总，不静默降级 FIELD_SALES。
  // ADMIN 不限部门（department = null，全量）。
  const isAdmin = session.user.role === "ADMIN";
  const department = isAdmin ? null : await resolveActorDepartmentOrNull(session.user.id);
  const NO_MATCH_SCOPE = { id: { in: ["__NO_MATCH__"] } };
  const customerScope = isAdmin
    ? null
    : department
      ? await getFinanceProfileScopeWhere(session.user.id, session.user.role, department)
      : NO_MATCH_SCOPE;
  const projectScope = isAdmin
    ? null
    : department
      ? await getFinanceProjectScopeWhere(session.user.id, session.user.role, department)
      : NO_MATCH_SCOPE;
  const summary = await getFinanceSummary(customerScope, projectScope, includeArchived, new Date(), department);
  return NextResponse.json(summary);
}

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { isRepresentative } from "@/lib/permissions";
import { resolveOrganization } from "@/lib/organization-resolver";
import { CUSTOMER_API_AUDIT_TARGETS, logCustomerApiAudit } from "@/lib/customers/customer-api-audit";

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) {
    await logCustomerApiAudit({
      path: "/api/customers/org-search",
      method: "POST",
      forwardedTo: CUSTOMER_API_AUDIT_TARGETS.ORG_RESOLVER,
      statusCode: 401,
      callerTag: "org-search-route",
    });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (isRepresentative(session.user.role)) {
    await logCustomerApiAudit({
      path: "/api/customers/org-search",
      method: "POST",
      callerUserId: session.user.id,
      forwardedTo: CUSTOMER_API_AUDIT_TARGETS.ORG_RESOLVER,
      statusCode: 403,
      callerTag: "org-search-route",
    });
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const body = await req.json();
    const { query } = body;

    if (!query?.trim()) {
      await logCustomerApiAudit({
        path: "/api/customers/org-search",
        method: "POST",
        callerUserId: session.user.id,
        forwardedTo: CUSTOMER_API_AUDIT_TARGETS.ORG_RESOLVER,
        statusCode: 400,
        callerTag: "org-search-route",
      });
      return NextResponse.json({ error: "请输入单位名称" }, { status: 400 });
    }

    const result = await resolveOrganization(query.trim());

    // §9.3：org-search 是机构解析（非 Customer 业务字段读写），但仍属 /api/customers/** 覆盖
    // 范围，记审计以便 burn-down 时识别机构解析流量来源。无 customerId（非客户作用域）。
    await logCustomerApiAudit({
      path: "/api/customers/org-search",
      method: "POST",
      callerUserId: session.user.id,
      forwardedTo: CUSTOMER_API_AUDIT_TARGETS.ORG_RESOLVER,
      statusCode: 200,
      callerTag: "org-search-route",
    });

    return NextResponse.json(result);
  } catch (error) {
    console.error("Org search error:", error);
    const message = error instanceof Error ? error.message : "搜索失败";
    await logCustomerApiAudit({
      path: "/api/customers/org-search",
      method: "POST",
      callerUserId: session?.user?.id,
      forwardedTo: CUSTOMER_API_AUDIT_TARGETS.ORG_RESOLVER,
      statusCode: 500,
      callerTag: "org-search-route",
    });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

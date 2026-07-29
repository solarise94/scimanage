import { NextRequest, NextResponse } from "next/server";
import { requirePortalSession } from "@/lib/application/http-error-mapping";
import { buildOrganizationFinanceList } from "@/lib/finance/collection-analysis";

export async function GET(req: NextRequest) {
  const gated = await requirePortalSession();
  if (!gated.ok) return gated.response;
  const session = gated.session;
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { searchParams } = req.nextUrl;
  const sort = searchParams.get("sort") || "canonicalName";
  const order = searchParams.get("order") || "asc";

  let organizations = await buildOrganizationFinanceList();

  const sortOrder = order === "desc" ? -1 : 1;
  organizations = [...organizations].sort((a, b) => {
    let cmp = 0;
    switch (sort) {
      case "quarterlyReceiptRate":
        cmp = (a.quarterlyReceiptRate ?? -1) - (b.quarterlyReceiptRate ?? -1);
        break;
      case "yearlyReceiptRate":
        cmp = (a.yearlyReceiptRate ?? -1) - (b.yearlyReceiptRate ?? -1);
        break;
      case "avgCollectionCycleDays":
        cmp = (a.avgCollectionCycleDays ?? 9999) - (b.avgCollectionCycleDays ?? 9999);
        break;
      case "pairCount":
        cmp = a.pairCount - b.pairCount;
        break;
      case "canonicalName":
      default:
        cmp = a.canonicalName.localeCompare(b.canonicalName, "zh-CN");
    }
    return cmp * sortOrder;
  });

  return NextResponse.json({ organizations });
}

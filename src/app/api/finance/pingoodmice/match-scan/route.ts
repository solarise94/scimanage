import { NextRequest, NextResponse } from "next/server";
import { requirePortalSession } from "@/lib/application/http-error-mapping";
import { matchSourceOrders } from "@/lib/finance/pingoodmice-match";

export async function POST(req: NextRequest) {
  const gated = await requirePortalSession();
  if (!gated.ok) return gated.response;
  const session = gated.session;
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const url = req.nextUrl;
  const source = url.searchParams.get("source")?.trim() || "PINGOODMICE";

  let body: { orderIds?: string[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "请求体不是合法 JSON，请检查 content-type 与 payload" },
      { status: 400 },
    );
  }

  const result = await matchSourceOrders(source, body.orderIds);
  return NextResponse.json(result);
}

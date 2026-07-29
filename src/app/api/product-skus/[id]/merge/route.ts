/**
 * POST /api/product-skus/[id]/merge  合并 SKU 到替代 SKU
 *   body: { replacementSkuId }
 */
import { NextRequest, NextResponse } from "next/server";
import { requireActorFromSession, mapDomainErrorToHttp } from "@/lib/application/http-error-mapping";
import { mergeSkuForActor } from "@/lib/products/application/create-product";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireActorFromSession();
  if (!auth.ok) return auth.response;
  const { id: sourceSkuId } = await params;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const replacementSkuId = String(body.replacementSkuId ?? "");
  if (!replacementSkuId) {
    return NextResponse.json({ error: "replacementSkuId 必填" }, { status: 400 });
  }

  try {
    const result = await mergeSkuForActor(auth.actor, sourceSkuId, replacementSkuId);
    return NextResponse.json(result);
  } catch (err) {
    return mapDomainErrorToHttp(err, "Failed to merge SKU");
  }
}

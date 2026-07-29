/**
 * POST /api/product-skus/[id]/retire  停用 SKU（RETIRED，保留历史引用）
 */
import { NextRequest, NextResponse } from "next/server";
import { requireActorFromSession, mapDomainErrorToHttp } from "@/lib/application/http-error-mapping";
import { retireSkuForActor } from "@/lib/products/application/create-product";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireActorFromSession();
  if (!auth.ok) return auth.response;
  const { id } = await params;
  try {
    const result = await retireSkuForActor(auth.actor, id);
    return NextResponse.json(result);
  } catch (err) {
    return mapDomainErrorToHttp(err, "Failed to retire SKU");
  }
}

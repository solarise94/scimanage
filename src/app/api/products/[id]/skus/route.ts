/**
 * POST /api/products/[id]/skus  为产品创建 SKU（领 SKU- 编号）
 */
import { NextRequest, NextResponse } from "next/server";
import { requireActorFromSession, mapDomainErrorToHttp } from "@/lib/application/http-error-mapping";
import { createSkuForActor } from "@/lib/products/application/create-product";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireActorFromSession();
  if (!auth.ok) return auth.response;
  const { id: productId } = await params;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const result = await createSkuForActor(auth.actor, {
      productId,
      name: String(body.name ?? ""),
      spec: typeof body.spec === "string" ? body.spec : null,
      standardUnit: String(body.standardUnit ?? ""),
      sellable: typeof body.sellable === "boolean" ? body.sellable : undefined,
      purchasable: typeof body.purchasable === "boolean" ? body.purchasable : undefined,
      fulfillmentMode: typeof body.fulfillmentMode === "string" ? body.fulfillmentMode : undefined,
      defaultSalesPriceYuan:
        typeof body.defaultSalesPriceYuan === "number"
          ? body.defaultSalesPriceYuan
          : body.defaultSalesPriceYuan === null
            ? null
            : undefined,
      status: typeof body.status === "string" ? body.status : undefined,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return mapDomainErrorToHttp(err, "Failed to create SKU");
  }
}
